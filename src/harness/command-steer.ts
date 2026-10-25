/**
 * Harness plugin: hand queued human commands to this work's live agent.
 *
 * The runtime persists a command and a per-work delivery record; it never
 * guesses when the model could read it. This plugin polls the runtime's internal
 * command endpoint, submits each command through the harness's own `steer`
 * input (next-step steering, so a long turn receives it at a step boundary),
 * and reports the returned message id back. The runtime then watches the
 * session log for that exact `user/message` event before it records
 * "entered context".
 *
 * The plugin is loaded directly from the profile patch by absolute path. It
 * uses only Node builtins and the harness's public agent API; it does not add
 * model requests of its own, and an idle agent simply starts a turn when the
 * command is steered.
 */

import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'command-steer'

interface AgentLike {
  readonly session: { readonly id: string }
  steer(message: unknown): void
}

interface PluginContext {
  on(event: string, listener: (...args: any[]) => unknown): () => void
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

interface ClaimedCommand {
  id: string
  text: string
  token: string
}

interface PendingAck {
  commandId: string
  token: string
  messageId: string
  attempts: number
  nextAt: number
}

const POLL_MS = 400
const ACK_RETRY_MS = 2_000
const REQUEST_TIMEOUT_MS = 5_000

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error && reason.name !== 'AbortError') return reason
  const error = new Error('命令投递请求已取消')
  error.name = 'AbortError'
  return error
}

function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
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
    request.on('timeout', () => {
      request.destroy(new Error('命令投递接口超时'))
    })
    request.on('error', reject)
    if (signal !== undefined) {
      if (signal.aborted) {
        request.destroy(abortError(signal))
        return
      }
      const onAbort = (): void => {
        request.destroy(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      request.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    request.end(payload)
  })
}

class CommandPoller {
  private readonly claimUrl: string
  private readonly ackUrl: string
  private readonly releaseUrl: string
  private readonly headers: Record<string, string>
  private readonly resolveAgent: () => AgentLike | undefined
  private readonly logger: (message: string) => void
  private readonly pendingAcks: PendingAck[] = []
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private stopped = false
  private failures = 0

  constructor(options: {
    endpoint: string
    token: string
    workId: string
    resolveAgent: () => AgentLike | undefined
    logger: (message: string) => void
  }) {
    const base = options.endpoint.replace(/\/+$/, '')
    this.claimUrl = `${base}/command/claim`
    this.ackUrl = `${base}/command/ack`
    this.releaseUrl = `${base}/command/release`
    this.headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token}`,
      'x-liebian-work': options.workId,
    }
    this.resolveAgent = options.resolveAgent
    this.logger = options.logger
  }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.tick()
    }, POLL_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  wake(): void {
    void this.tick()
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      await this.flushAcks()
      const agent = this.resolveAgent()
      if (agent === undefined) return
      const claimed = await this.post<{ commands?: ClaimedCommand[] }>(this.claimUrl, {
        sessionId: agent.session.id,
        generation: this.generation,
      })
      this.failures = 0
      for (const command of claimed.commands ?? []) {
        if (this.stopped) return
        try {
          const message = createUserMessage({
            content: [{ type: 'text', text: command.text }],
            source: { kind: 'user' },
          })
          agent.steer(message)
          this.pendingAcks.push({
            commandId: command.id,
            token: command.token,
            messageId: message.id,
            attempts: 0,
            nextAt: Date.now(),
          })
        } catch (error) {
          this.logger(`转交命令 ${command.id} 失败：${error instanceof Error ? error.message : String(error)}`)
          await this.post(this.releaseUrl, {
            commandId: command.id,
            token: command.token,
            reason: 'steer failed',
          }).catch(() => undefined)
        }
      }
      await this.flushAcks()
    } catch (error) {
      // The runtime may be restarting; the next poll retries and the saved
      // command stays intact. Log sparsely so a long outage cannot flood the
      // harness stderr log at the polling rate.
      this.failures += 1
      if (this.failures === 1 || this.failures % 10 === 0) {
        this.logger(
          `命令投递轮询失败（第 ${this.failures} 次）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } finally {
      this.ticking = false
    }
  }

  private async flushAcks(): Promise<void> {
    const now = Date.now()
    for (const ack of [...this.pendingAcks]) {
      if (ack.nextAt > now) continue
      try {
        await this.post(this.ackUrl, {
          commandId: ack.commandId,
          token: ack.token,
          messageId: ack.messageId,
        })
        const index = this.pendingAcks.indexOf(ack)
        if (index >= 0) this.pendingAcks.splice(index, 1)
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'COMMAND_CLAIM_STALE' || code === 'COMMAND_NOT_FOUND') {
          // The runtime re-claimed the command for a new attempt; the old
          // steering may already be in the session, so this is at-least-once.
          const index = this.pendingAcks.indexOf(ack)
          if (index >= 0) this.pendingAcks.splice(index, 1)
          continue
        }
        ack.attempts += 1
        ack.nextAt = Date.now() + ACK_RETRY_MS
      }
    }
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const response = await postJson(url, this.headers, body)
    let payload: Envelope<T> | null = null
    try {
      payload = JSON.parse(response.body) as Envelope<T>
    } catch {
      payload = null
    }
    if (response.status !== 200 || payload?.ok !== true) {
      const error = new Error(payload?.error?.message ?? `命令投递接口失败（HTTP ${response.status}）`) as Error & {
        code?: string
      }
      error.code = payload?.error?.code
      throw error
    }
    return (payload.result ?? {}) as T
  }

  private readonly generation = (() => {
    const raw = process.env.LIEBIAN_GENERATION
    if (raw === undefined || raw.length === 0) return undefined
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) ? value : undefined
  })()
}

/** Attach the poller when the process was launched by the liebian runtime. */
export function apply(ctx: PluginContext): void {
  const endpoint = process.env.LIEBIAN_DAEMON_URL
  const token = process.env.LIEBIAN_DAEMON_TOKEN
  const workId = process.env.LIEBIAN_WORK
  const sessionId = process.env.LIEBIAN_SESSION_ID
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

  let agent: AgentLike | undefined
  const resolveAgent = (): AgentLike | undefined => agent

  ctx.on('agent/created', (...args: any[]) => {
    const created = args[0]?.agent as AgentLike | undefined
    if (created === undefined) return
    if (sessionId !== undefined && sessionId.length > 0 && created.session.id !== sessionId) return
    agent = created
    poller.wake()
  })
  ctx.on('agent/disposed', (...args: any[]) => {
    if (args[0]?.agent === agent) agent = undefined
  })

  const poller = new CommandPoller({
    endpoint,
    token,
    workId,
    resolveAgent,
    logger: (message) => process.stderr.write(`[command-steer] ${message}\n`),
  })
  ctx.effect(() => {
    poller.start()
    return () => poller.stop()
  }, 'command-steer: human command delivery')
}
