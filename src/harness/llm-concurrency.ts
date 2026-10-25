/**
 * Harness plugin: gate every model stream through the task runtime's shared
 * model-request semaphore.
 *
 * Each executor process runs this plugin independently, but they all call the
 * same loopback endpoint (`POST /llm/acquire` and `POST /llm/release`), so the
 * limit is per task, not per executor. The permit is held for the whole
 * streamed response and returned as soon as the stream settles; tool calls and
 * message waits do not occupy a slot.
 *
 * This module is loaded directly from the profile patch by absolute path. It
 * intentionally has no imports beyond Node builtins and only erasable
 * TypeScript syntax, so the harness can import it under Node's type stripping.
 */

import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

export const name = 'llm-concurrency'

interface StreamOptions {
  signal?: AbortSignal
  provider?: string
  model?: string
  purpose?: string
  sessionId?: string
  messages?: unknown[]
  tools?: unknown[]
}

type StreamNext = () => AsyncIterable<unknown>

interface PluginContext {
  on(
    event: 'llm/stream',
    listener: (options: StreamOptions, next: StreamNext) => AsyncIterable<unknown>,
  ): () => void
  effect(callback: () => (() => void) | void, label?: string): void
}

interface Envelope<T> {
  ok?: boolean
  result?: T
  error?: { code?: string; message?: string }
}

interface HttpResponse {
  status: number
  body: string
}

const ACQUIRE_PATH = '/llm/acquire'
const RELEASE_PATH = '/llm/release'
const RETRY_INITIAL_MS = 250
const RETRY_MAX_MS = 5_000

/** Attach the stream gate when the process was launched by the liebian runtime. */
export function apply(ctx: PluginContext): void {
  const endpoint = process.env.LIEBIAN_DAEMON_URL
  const token = process.env.LIEBIAN_DAEMON_TOKEN
  const workId = process.env.LIEBIAN_WORK
  if (
    endpoint === undefined ||
    endpoint.length === 0 ||
    token === undefined ||
    token.length === 0 ||
    workId === undefined ||
    workId.length === 0
  ) {
    // A harness booted outside a task runtime must not be broken by this plugin.
    return
  }

  const gate = new ModelGate(endpoint, token, workId)
  ctx.effect(() => {
    const dispose = ctx.on('llm/stream', (options, next) => gate.wrap(options, next))
    return () => {
      dispose()
      gate.dispose()
    }
  }, 'llm-concurrency: shared model request slots')
}

/**
 * POST a small JSON body to the loopback runtime.
 *
 * `fetch` is deliberately not used for acquire: Node's fetch has a default
 * headers timeout, while a queued acquire must be allowed to wait behind a long
 * streamed response for as long as that response takes. A release uses a short
 * timeout so a transient failure reaches the retry loop quickly.
 */
function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  timeoutMs = 0,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        })
        response.on('error', reject)
      },
    )
    request.setTimeout(timeoutMs)
    if (timeoutMs > 0) {
      request.on('timeout', () => {
        request.destroy(new Error('模型名额接口超时'))
      })
    }
    request.on('error', reject)

    if (signal !== undefined) {
      const onAbort = (): void => {
        request.destroy(abortError(signal))
      }
      if (signal.aborted) {
        request.destroy(abortError(signal))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      request.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    request.end(payload)
  })
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error && reason.name !== 'AbortError') return reason
  const error = new Error('模型请求已取消')
  error.name = 'AbortError'
  return error
}

function parseEnvelope<T>(text: string): Envelope<T> | null {
  try {
    return JSON.parse(text) as Envelope<T>
  } catch {
    return null
  }
}

class ModelGate {
  private readonly acquireUrl: string
  private readonly releaseUrl: string
  private readonly abortUrl: string
  private readonly generation: number | undefined
  private readonly headers: Record<string, string>
  private readonly pendingReleases = new Map<string, { attempts: number; cancel: boolean; metrics?: Record<string, unknown> }>()
  private readonly pendingAborts = new Map<string, { attempts: number; reason: string }>()
  private readonly streams = new Map<string, () => Promise<void>>()
  private retryTimer: NodeJS.Timeout | undefined
  private flushing = false
  private disposed = false

  constructor(endpoint: string, token: string, workId: string) {
    const base = endpoint.replace(/\/+$/, '')
    this.acquireUrl = `${base}${ACQUIRE_PATH}`
    this.releaseUrl = `${base}${RELEASE_PATH}`
    this.abortUrl = `${base}/llm/abort`
    const generation = Number(process.env.LIEBIAN_GENERATION)
    this.generation = Number.isSafeInteger(generation) && generation > 0 ? generation : undefined
    this.headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-liebian-work': workId,
    }
  }

  /** Wrap one model stream. The permit covers exactly the streamed response. */
  async *wrap(options: StreamOptions, next: StreamNext): AsyncGenerator<unknown> {
    if (this.disposed) throw new Error('模型请求插件已关闭')
    const permitId = randomUUID()
    const started = performance.now()
    const acquireController = new AbortController()
    const metrics: Record<string, unknown> = {
      provider: options.provider, model: options.model, purpose: options.purpose,
      sessionId: options.sessionId, messageCount: options.messages?.length, toolCount: options.tools?.length,
      chunks: 0, textChars: 0, reasoningChars: 0, toolArgumentChars: 0,
    }
    let held: string | undefined
    let iterator: AsyncIterator<unknown> | undefined
    let stopped = false
    let cleanup: Promise<void> | undefined
    let timer: NodeJS.Timeout | undefined
    let streamStarted: number | undefined
    const idleValue = Number(process.env.LIEBIAN_MODEL_STREAM_IDLE_MS)
    const idleMs = Number.isSafeInteger(idleValue) && idleValue > 0 && idleValue <= 86_400_000 ? idleValue : 120_000
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { void stop('idle-timeout') }, idleMs)
      timer.unref?.()
    }
    const stop = (outcome: string): Promise<void> => {
      if (cleanup !== undefined) return cleanup
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', aborted)
      acquireController.abort()
      this.streams.delete(permitId)
      cleanup = (async () => {
        let closeTimer: NodeJS.Timeout | undefined
        try {
          if (iterator !== undefined && outcome !== 'completed') {
            await Promise.race([
              Promise.resolve(iterator.return?.()),
              new Promise<never>((_, reject) => { closeTimer = setTimeout(() => reject(new Error('stream cleanup timeout')), 5_000); closeTimer.unref?.() }),
            ])
          }
        } catch {
          // Do not free capacity while a hung provider might still be in flight.
          // The runtime terminates this exact process generation and reclaims on exit.
          metrics.cleanup = 'process-stop-requested'
          this.pendingAborts.set(permitId, { attempts: 0, reason: outcome })
          if (this.disposed) void this.sendAbort(permitId, outcome).catch(() => undefined)
          else void this.flushReleases()
          return
        } finally {
          if (closeTimer !== undefined) clearTimeout(closeTimer)
        }
        metrics.outcome = outcome
        metrics.totalMs = performance.now() - started
        metrics.streamMs = streamStarted === undefined ? null : performance.now() - streamStarted
        metrics.memory = process.memoryUsage()
        this.release(held ?? permitId, held === undefined, metrics)
      })()
      return cleanup
    }
    const aborted = (): void => { void stop('aborted') }
    this.streams.set(permitId, () => stop('disposed'))
    options.signal?.addEventListener('abort', aborted, { once: true })
    let outcome = 'consumer-closed'
    try {
      options.signal?.throwIfAborted()
      held = await this.acquire(permitId, acquireController.signal)
      options.signal?.throwIfAborted()
      if (stopped) throw new Error('模型请求已取消')
      streamStarted = performance.now()
      metrics.waitMs = streamStarted - started
      iterator = next()[Symbol.asyncIterator]()
      arm()
      for (;;) {
        const chunk = await iterator.next()
        if (stopped) throw new Error('模型流已中止')
        if (chunk.done) { outcome = 'completed'; break }
        if (metrics.chunks === 0) metrics.firstChunkMs = performance.now() - streamStarted
        metrics.chunks = Number(metrics.chunks) + 1
        if (chunk.value && typeof chunk.value === 'object') {
          const item = chunk.value as Record<string, unknown>
          if (item.type === 'usage') metrics.usage = item.usage
          if (item.type === 'finish') metrics.finishReason = item.reason
          if (item.type === 'text-delta' && typeof item.text === 'string' && item.text.length > 0 && metrics.firstTextMs === undefined) {
            metrics.firstTextMs = performance.now() - streamStarted
          }
          if (item.type === 'text-delta' && typeof item.text === 'string') metrics.textChars = Number(metrics.textChars) + item.text.length
          if (item.type === 'reasoning-delta' && typeof item.text === 'string') metrics.reasoningChars = Number(metrics.reasoningChars) + item.text.length
          if (item.type === 'tool-call-delta' && typeof item.argumentsDelta === 'string') metrics.toolArgumentChars = Number(metrics.toolArgumentChars) + item.argumentsDelta.length
        }
        arm() // bounds a stalled provider AND an abandoned consumer between yields
        yield chunk.value
      }
    } catch (error) {
      outcome = options.signal?.aborted ? 'aborted' : 'error'
      metrics.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      await stop(outcome)
    }
  }

  private async acquire(permitId: string, signal?: AbortSignal): Promise<string> {
    const response = await postJson(this.acquireUrl, this.headers, { permitId, generation: this.generation }, signal)
    const payload = parseEnvelope<{ permitId?: string }>(response.body)
    if (response.status !== 200 || payload?.ok !== true) {
      throw new Error(payload?.error?.message ?? `模型请求名额申请失败（HTTP ${response.status}）`)
    }
    return typeof payload.result?.permitId === 'string' ? payload.result.permitId : permitId
  }

  /**
   * Queue a release. A failed loopback call is retried with capped backoff:
   * silently dropping it would permanently shrink the task's capacity. The
   * runtime also reclaims every permit of a work when its process exits, which
   * covers a daemon that disappears while this process is being shut down.
   */
  private release(permitId: string, cancel = false, metrics?: Record<string, unknown>): void {
    if (this.disposed) { void this.sendRelease(permitId, cancel, metrics).catch(() => undefined); return }
    const existing = this.pendingReleases.get(permitId)
    if (existing !== undefined) {
      existing.cancel = existing.cancel || cancel
      return
    }
    this.pendingReleases.set(permitId, { attempts: 0, cancel, metrics })
    void this.flushReleases()
  }

  private async flushReleases(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      if (this.retryTimer !== undefined) {
        clearTimeout(this.retryTimer)
        this.retryTimer = undefined
      }
      for (const [permitId, entry] of [...this.pendingAborts]) {
        try {
          await this.sendAbort(permitId, entry.reason)
          this.pendingAborts.delete(permitId)
        } catch { entry.attempts += 1 }
      }
      for (const [permitId, entry] of [...this.pendingReleases]) {
        try {
          await this.sendRelease(permitId, entry.cancel, entry.metrics)
          this.pendingReleases.delete(permitId)
        } catch (error) {
          entry.attempts += 1
          if (entry.attempts === 1) {
            process.stderr.write(
              `[llm-concurrency] 归还模型请求名额失败，将重试：${error instanceof Error ? error.message : String(error)}\n`,
            )
          }
        }
      }
      if ((this.pendingReleases.size === 0 && this.pendingAborts.size === 0) || this.disposed) return
      const attempts = Math.max(...[...this.pendingReleases.values(), ...this.pendingAborts.values()].map((entry) => entry.attempts))
      const delay = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempts, 5))
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        void this.flushReleases()
      }, delay)
      this.retryTimer.unref?.()
    } finally {
      this.flushing = false
    }
  }

  private async sendRelease(permitId: string, cancel: boolean, metrics?: Record<string, unknown>): Promise<void> {
    const response = await postJson(this.releaseUrl, this.headers, { permitId, cancel, generation: this.generation, metrics }, undefined, 5_000)
    const payload = parseEnvelope<{ released?: boolean }>(response.body)
    if (response.status !== 200 || payload?.ok !== true) {
      throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
    }
  }

  private async sendAbort(permitId: string, reason: string): Promise<void> {
    const response = await postJson(this.abortUrl, this.headers,
      { generation: this.generation, permitId, reason }, undefined, 20_000)
    if (response.status !== 200 || parseEnvelope(response.body)?.ok !== true) throw new Error('模型流清理请求失败')
  }

  /** Best-effort final flush; the process is about to exit. */
  dispose(): void {
    this.disposed = true
    for (const stop of this.streams.values()) void stop()
    for (const [permitId, entry] of this.pendingAborts) void this.sendAbort(permitId, entry.reason).catch(() => undefined)
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    for (const [permitId, entry] of [...this.pendingReleases]) {
      void this.sendRelease(permitId, entry.cancel, entry.metrics)
        .then(() => this.pendingReleases.delete(permitId))
        .catch(() => undefined)
    }
  }
}
