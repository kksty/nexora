/**
 * Harness driver over the DeepSeek Harness SDK stdio protocol.
 *
 * One `dsh --profile sdk` process serves exactly one work session. The runtime
 * owns process lifetime, session identity and recovery; the harness owns model
 * requests, tool execution, context management, compaction and session logs.
 *
 * This file deliberately contains no retry policy. Request failures surface as
 * errors and the runtime's lifecycle layer records `retrying`, backs off and
 * re-establishes the session. The harness's own LLM retry plugin remains active
 * inside the process.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { ActivityEvent } from '../types.ts'
import { AppError, describeError } from '../util/errors.ts'
import type { Logger } from '../util/log.ts'
import type { EnsureResult, HarnessDriver, PromptReceipt, WorkSessionSpec } from './driver.ts'
import { normalizeSessionEvent, normalizeSessionStatus } from './events.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const INITIALIZE_TIMEOUT_MS = 180_000
const PROMPT_TIMEOUT_MS = 180_000
/** One turn may take a long time; this timeout only catches a wedged session. */
const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000
const SHUTDOWN_TIMEOUT_MS = 8_000

/** A timer that never keeps the process alive, including inside Promise.race. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

interface RpcMessage {
  jsonrpc?: string
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Newline-delimited JSON-RPC peer for one harness process. */
class RpcPeer {
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private closed = false
  private readonly logger: Logger

  private readonly child: ChildProcessWithoutNullStreams
  private readonly onNotification: (message: RpcMessage) => void

  constructor(
    child: ChildProcessWithoutNullStreams,
    onNotification: (message: RpcMessage) => void,
    logger: Logger,
  ) {
    this.child = child
    this.onNotification = onNotification
    this.logger = logger
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
  }

  request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new AppError('HARNESS_NOT_READY', 'harness 进程不可用'))
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppError('HARNESS_TIMEOUT', `harness 请求超时：${method}`, { method, timeoutMs }))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolvePromise(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
        timer,
      })
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      try {
        this.child.stdin.write(`${frame}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new AppError('HARNESS_NOT_READY', describeError(error)))
      }
    })
  }

  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new AppError('HARNESS_EXITED', reason))
    }
    this.pending.clear()
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.logger.warn(`忽略无法解析的 harness 输出：${line.slice(0, 200)}`)
      return
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) {
        const error = new Error(message.error.message ?? 'harness 请求失败') as Error & {
          code?: number
          data?: unknown
        }
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method !== undefined) this.onNotification(message)
  }
}

class Worker {
  readonly child: ChildProcessWithoutNullStreams
  readonly peer: RpcPeer
  readonly workId: string
  readonly sessionId: string
  readonly generation: number
  readonly exited: Promise<void>
  ready = false
  stopping = false
  dead = false
  private readonly stderrTail: string[] = []
  private readonly logStream: WriteStream
  private readonly logger: Logger
  private readonly onActivity: (events: ActivityEvent[]) => void
  /** Serializes activity callbacks so quiesce observes a stable order. */
  private notificationChain: Promise<void> = Promise.resolve()
  private shutdownTask?: Promise<void>

  constructor(options: {
    workId: string
    sessionId: string
    generation: number
    taskDir: string
    command: string
    args: string[]
    env: NodeJS.ProcessEnv
    logFile: string
    logger: Logger
    onNotification: (message: RpcMessage) => void
    onActivity: (events: ActivityEvent[]) => void
    onExit: () => void
  }) {
    this.workId = options.workId
    this.sessionId = options.sessionId
    this.generation = options.generation
    this.onActivity = options.onActivity
    this.logger = options.logger
    this.logStream = createWriteStream(options.logFile, { flags: 'a' })
    // A missing directory, a full disk or an over-long path must not surface as
    // an unhandled 'error' event that takes the whole runtime down.
    this.logStream.on('error', (error: Error) => {
      this.logger.warn(`harness 日志写入失败（${options.logFile}）：${describeError(error)}`)
    })
    this.child = spawn(options.command, options.args, {
      cwd: options.taskDir,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.peer = new RpcPeer(this.child, options.onNotification, options.logger)
    const exited = Promise.withResolvers<void>()
    this.exited = exited.promise

    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.logStream.write(chunk)
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length === 0) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > 80) this.stderrTail.shift()
      }
    })
    const finishExit = (): void => {
      if (this.dead) return
      this.dead = true
      this.logStream.end()
      exited.resolve()
      options.onExit()
    }
    this.child.on('error', (error) => {
      this.logger.error(`harness 进程错误：${describeError(error)}`)
      this.peer.close(`harness 进程错误：${describeError(error)}`)
      if (this.child.pid === undefined) finishExit()
    })
    this.child.on('exit', (code, signal) => {
      const reason = `harness 进程退出（code=${String(code)}, signal=${String(signal)}）`
      this.logger.warn(`${this.workId}: ${reason}`)
      this.peer.close(reason)
      finishExit()
    })
  }

  get exitReason(): string {
    const tail = this.stderrTail.slice(-8).join(' | ')
    return tail.length === 0 ? '无 stderr 输出' : tail
  }

  async initialize(cwd: string, provider: string, model: string): Promise<void> {
    await this.peer.request('initialize', { cwd, provider, model }, INITIALIZE_TIMEOUT_MS)
    this.ready = true
  }

  async resume(): Promise<void> {
    await this.peer.request('session/resume', { sessionId: this.sessionId }, INITIALIZE_TIMEOUT_MS)
  }

  async prompt(text: string): Promise<PromptReceipt> {
    const result = (await this.peer.request(
      'session/prompt',
      { sessionId: this.sessionId, contentBlocks: [{ type: 'text', text }] },
      PROMPT_TIMEOUT_MS,
    )) as { messageId?: unknown } | null
    if (typeof result?.messageId !== 'string' || result.messageId.length === 0) {
      throw new AppError('HARNESS_PROMPT_FAILED', 'harness 未返回持久入队回执 messageId')
    }
    return { messageId: result.messageId }
  }

  async waitForIdle(): Promise<void> {
    await this.peer.request('session/wait', { sessionId: this.sessionId }, WAIT_TIMEOUT_MS)
  }

  /** Queue one ordered activity batch for delivery to the runtime. */
  enqueueActivity(events: ActivityEvent[]): void {
    if (events.length === 0) return
    this.notificationChain = this.notificationChain
      .then(() => {
        if (this.dead) return
        this.onActivity(events)
      })
      .catch((error: unknown) => {
        this.logger.warn(`${this.workId}: 处理 harness 活动事件失败：${describeError(error)}`)
      })
  }

  /**
   * Wait for already-received notifications, then round-trip a harmless
   * request so notifications written before its response are dispatched, then
   * wait again. This is a transport ordering barrier, not a liveness check.
   */
  async quiesce(): Promise<void> {
    await this.notificationChain
    // The runtime skips the completion commit if this barrier fails: without a
    // response boundary it cannot prove that earlier notifications were seen.
    await this.peer.request('session/working-directory/get', { sessionId: this.sessionId }, 30_000)
    await this.notificationChain
  }

  shutdown(): Promise<void> {
    return this.shutdownTask ??= this.shutdownOnce()
  }

  private async shutdownOnce(): Promise<void> {
    if (this.dead) return
    this.stopping = true
    try {
      await Promise.race([this.peer.request('shutdown', undefined, SHUTDOWN_TIMEOUT_MS), delay(SHUTDOWN_TIMEOUT_MS + 1000)])
    } catch {
      // An exiting process may never answer; the kill below is the fallback.
    }
    try {
      this.child.stdin.end()
    } catch {
      // already closed
    }
    const timedOut = await Promise.race([this.exited.then(() => false), delay(3000).then(() => true)])
    if (timedOut) {
      this.child.kill('SIGTERM')
      const stillAlive = await Promise.race([this.exited.then(() => false), delay(1000).then(() => true)])
      if (stillAlive) {
        this.child.kill('SIGKILL')
        const notDead = await Promise.race([this.exited.then(() => false), delay(3000).then(() => true)])
        if (notDead) throw new AppError('HARNESS_STOP_FAILED', `无法确认 ${this.workId} 进程已退出`)
      }
    }
    this.peer.close('runtime 已停止该 work 的 harness 进程')
  }
}

export interface SdkDriverOptions {
  taskDir: string
  patchFile: string
  mcpEntry: string
  logDir: string
  daemonUrl: string
  daemonToken: string
  provider: string
  model: string
  logger: Logger
  dshBin?: string
  profile?: string
}

/** Locate the harness CLI installed as this package's dependency. */
export function resolveDshBin(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.LIEBIAN_DSH_BIN,
    fileURLToPath(new URL('../../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0) return resolve(candidate)
  }
  throw new AppError('HARNESS_NOT_FOUND', '找不到 @deepseek-ai/dsh，请先运行 npm install 或设置 LIEBIAN_DSH_BIN')
}

function retryAfterHint(error: unknown): number | undefined {
  const data = (error as { data?: unknown }).data
  if (typeof data === 'object' && data !== null) {
    for (const key of ['retryAfterMs', 'retry_after_ms', 'retry_after']) {
      const value = (data as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10) * 1000
    }
  }
  const message = describeError(error)
  const match = /retry[\s_-]*after[^\d]{0,8}(\d+(?:\.\d+)?)\s*(ms|s|秒)?/i.exec(message)
  if (match === null) return undefined
  const amount = Number.parseFloat(match[1] ?? '0')
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  return match[2] === 'ms' ? amount : amount * 1000
}

function looksLikeMissingSession(error: unknown): boolean {
  const message = describeError(error).toLowerCase()
  return (
    message.includes('not found') ||
    message.includes('missing') ||
    message.includes('does not exist') ||
    message.includes('no such') ||
    message.includes('unknown session') ||
    message.includes('no persisted')
  )
}

/**
 * Locate one session's persisted JSONL log. The harness nests it under a
 * directory derived from the session cwd, so searching by session id is more
 * stable than reconstructing that encoding.
 */
export async function findSessionLog(taskDir: string, sessionId: string): Promise<string | null> {
  const root = join(taskDir, 'runtime', 'sessions')
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !/^session\.v\d+\.jsonl$/.test(entry.name)) continue
    const parent = entry.parentPath
    if (parent === undefined || basename(parent) !== sessionId) continue
    return join(parent, entry.name)
  }
  return null
}

/** Read replay events after a cursor from one persisted session JSONL file. */
export async function readSessionActivityFile(
  file: string,
  sessionId: string,
  generation: number,
  afterSeq: number,
): Promise<ActivityEvent[]> {
  const replay: ActivityEvent[] = []
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let raw: unknown
      try {
        raw = JSON.parse(trimmed)
      } catch {
        continue
      }
      const record = raw as { seq?: unknown }
      if (typeof record.seq !== 'number' || record.seq <= afterSeq) continue
      const event = normalizeSessionEvent(raw, sessionId, generation)
      if (event !== null) replay.push(event)
    }
  } finally {
    lines.close()
    stream.close()
  }
  return replay
}

/** Driver that owns one `dsh --profile sdk` process per work. */
export class SdkHarnessDriver implements HarnessDriver {
  onActivity?: (workId: string, events: ActivityEvent[]) => void
  onUnexpectedExit?: (workId: string, reason: string) => void
  onWorkerExit?: (workId: string, reason: string, generation?: number) => void
  onWorkerStart?: (workId: string, generation: number) => void
  private readonly workers = new Map<string, Worker>()
  private readonly processes = new Set<Worker>()
  private readonly generations = new Map<string, number>()
  private readonly ensureLocks = new Map<string, Promise<unknown>>()
  /** Incremented by every stop request so an in-flight ensure cannot resurrect a work. */
  private readonly stopEpochs = new Map<string, number>()
  private closed = false
  private readonly options: SdkDriverOptions
  private readonly logger: Logger

  constructor(options: SdkDriverOptions) {
    this.options = options
    this.logger = options.logger
  }

  async ensure(spec: WorkSessionSpec): Promise<EnsureResult> {
    // Capture the stop epoch at admission: a stop that arrives while this
    // ensure is queued behind another one must still prevent a new process.
    const epoch = this.stopEpoch(spec.workId)
    const previous = this.ensureLocks.get(spec.workId) ?? Promise.resolve()
    const task = previous.then(
      () => this.ensureUnlocked(spec, epoch),
      () => this.ensureUnlocked(spec, epoch),
    )
    this.ensureLocks.set(
      spec.workId,
      task.then(
        () => undefined,
        () => undefined,
      ),
    )
    return (await task) as EnsureResult
  }

  async prompt(workId: string, text: string): Promise<PromptReceipt> {
    const worker = this.requireWorker(workId)
    try {
      return await worker.prompt(text)
    } catch (error) {
      throw new AppError('HARNESS_PROMPT_FAILED', `提交给 harness 的请求失败：${describeError(error)}`, {
        workId,
        retryAfterMs: retryAfterHint(error),
        cause: describeError(error),
      })
    }
  }

  async waitForIdle(workId: string): Promise<void> {
    const worker = this.requireWorker(workId)
    try {
      await worker.waitForIdle()
    } catch (error) {
      throw new AppError('HARNESS_WAIT_FAILED', `等待 harness 空闲失败：${describeError(error)}`, {
        workId,
        cause: describeError(error),
      })
    }
  }

  async quiesce(workId: string): Promise<void> {
    const worker = this.workers.get(workId)
    if (worker === undefined || worker.dead) return
    await worker.quiesce()
  }

  async stop(workId: string): Promise<void> {
    this.bumpStop(workId)
    this.workers.delete(workId)
    await Promise.all([...this.processes].filter((worker) => worker.workId === workId).map((worker) => worker.shutdown()))
  }

  async inspectProcesses(): Promise<Record<string, unknown>[]> {
    return Promise.all([...this.processes].map(async (worker) => {
      const result: Record<string, unknown> = { workId: worker.workId, sessionId: worker.sessionId,
        generation: worker.generation, pid: worker.child.pid, stopping: worker.stopping }
      if (process.platform === 'linux' && worker.child.pid !== undefined) {
        const status = await readFile(`/proc/${worker.child.pid}/status`, 'utf8').catch(() => '')
        for (const [field, key] of [['VmRSS', 'rssKiB'], ['VmSize', 'virtualKiB'], ['Threads', 'threads']]) {
          const match = new RegExp(`^${field}:\\s+(\\d+)`, 'm').exec(status)
          result[key] = match === null ? null : Number(match[1])
        }
      }
      return result
    }))
  }

  async stopAll(): Promise<void> {
    this.closed = true
    for (const workId of this.workers.keys()) this.bumpStop(workId)
    const workers = [...this.processes]
    this.workers.clear()
    await Promise.all(workers.map((worker) => worker.shutdown()))
  }

  private stopEpoch(workId: string): number {
    return this.stopEpochs.get(workId) ?? 0
  }

  private bumpStop(workId: string): void {
    this.stopEpochs.set(workId, this.stopEpoch(workId) + 1)
  }

  /** Refuse to spawn or return a session after the work/runtime was stopped. */
  private assertNotStopped(workId: string, epoch: number): void {
    if (this.closed || this.stopEpoch(workId) !== epoch) {
      throw new AppError('HARNESS_STOPPED', `work ${workId} 的 harness 已被运行时停止`)
    }
  }

  private async ensureUnlocked(spec: WorkSessionSpec, epoch: number): Promise<EnsureResult> {
    this.assertNotStopped(spec.workId, epoch)
    const existing = this.workers.get(spec.workId)
    if (existing !== undefined && !existing.dead && existing.sessionId === spec.sessionId) {
      if (!existing.ready) await existing.initialize(spec.taskDir, this.options.provider, this.options.model)
      this.assertNotStopped(spec.workId, epoch)
      return { resumed: false, freshFallback: false, generation: existing.generation }
    }
    if (existing !== undefined) {
      this.workers.delete(spec.workId)
      await existing.shutdown()
      // A stop during the old process' shutdown must not spawn a replacement:
      // stop()/stopAll() no longer see this work in the map at that point.
      this.assertNotStopped(spec.workId, epoch)
    }
    const worker = this.spawn(spec)
    this.workers.set(spec.workId, worker)
    try {
      await worker.initialize(spec.taskDir, this.options.provider, this.options.model)
      this.assertNotStopped(spec.workId, epoch)
      if (spec.sessionStarted) {
        try {
          await worker.resume()
          this.assertNotStopped(spec.workId, epoch)
          const replay = await this.readSessionActivity(spec, worker.generation)
          this.assertNotStopped(spec.workId, epoch)
          return { resumed: true, freshFallback: false, generation: worker.generation, replay }
        } catch (error) {
          if (looksLikeMissingSession(error)) {
            this.logger.warn(`${spec.workId}: 持久化会话缺失，改用新会话（${describeError(error)}）`)
            return { resumed: false, freshFallback: true, generation: worker.generation }
          }
          throw error
        }
      }
      return { resumed: false, freshFallback: false, generation: worker.generation }
    } catch (error) {
      this.workers.delete(spec.workId)
      await worker.shutdown()
      if (error instanceof AppError && error.code === 'HARNESS_STOPPED') throw error
      throw new AppError('HARNESS_START_FAILED', `harness 会话启动失败：${describeError(error)}`, {
        workId: spec.workId,
        retryAfterMs: retryAfterHint(error),
        stderr: worker.exitReason,
      })
    }
  }

  private spawn(spec: WorkSessionSpec): Worker {
    const dshBin = resolveDshBin(this.options.dshBin)
    const profile = this.options.profile ?? 'sdk'
    // Generation must distinguish processes across daemon restarts too, so a
    // new driver instance does not reuse the persisted number by accident.
    const previousGeneration = this.generations.get(spec.workId)
    const generation =
      previousGeneration === undefined
        ? Math.floor(Math.random() * 2 ** 50) + 1
        : previousGeneration + 1
    this.generations.set(spec.workId, generation)
    this.onWorkerStart?.(spec.workId, generation)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LIEBIAN_WORK: spec.workId,
      LIEBIAN_SESSION_ID: spec.sessionId,
      LIEBIAN_GENERATION: String(generation),
      LIEBIAN_DAEMON_URL: this.options.daemonUrl,
      LIEBIAN_DAEMON_TOKEN: this.options.daemonToken,
      LIEBIAN_MCP_ENTRY: this.options.mcpEntry,
      LIEBIAN_SESSION_ROOT: resolve(this.options.taskDir, 'runtime', 'sessions'),
      DSH_HOME: process.env.DSH_HOME || resolve(REPO_ROOT, '.dsh'),
      DSH_PERMISSION_MODE: 'danger-full-access',
    }
    const workLogger = this.logger.child(spec.workId)
    let worker!: Worker
    worker = new Worker({
      workId: spec.workId,
      sessionId: spec.sessionId,
      generation,
      taskDir: this.options.taskDir,
      command: process.execPath,
      args: [dshBin, '--profile', profile, '--patch', this.options.patchFile],
      env,
      logFile: resolve(this.options.logDir, `harness-${spec.workId}.log`),
      logger: workLogger,
      onNotification: (message) => this.handleNotification(worker, message),
      onActivity: (events) => this.onActivity?.(spec.workId, events),
      onExit: () => {
        this.processes.delete(worker)
        const current = this.workers.get(spec.workId)
        if (current === worker) this.workers.delete(spec.workId)
        this.onWorkerExit?.(spec.workId, worker.exitReason, worker.generation)
        // If a replacement process already owns this work, the old process's
        // exit must not reclaim the new process's slots or fail its session.
        if (current !== undefined && current !== worker) return
        if (!worker.stopping) this.onUnexpectedExit?.(spec.workId, worker.exitReason)
      },
    })
    this.processes.add(worker)
    return worker
  }

  /**
   * Convert raw SDK notifications into activity events. Events from a process
   * that has been replaced are dropped: an old generation can never mutate the
   * current work's projection.
   */
  private handleNotification(worker: Worker, message: RpcMessage): void {
    if (this.workers.get(worker.workId) !== worker || worker.dead) return
    if (message.method === 'session.event') {
      const payload = message.params as { sessionId?: unknown; event?: unknown } | undefined
      if (typeof payload?.sessionId !== 'string' || payload.sessionId !== worker.sessionId) return
      const event = normalizeSessionEvent(payload.event, worker.sessionId, worker.generation)
      if (event !== null) worker.enqueueActivity([event])
      return
    }
    if (message.method === 'session.status') {
      const payload = message.params as { sessionId?: unknown; status?: unknown } | undefined
      if (typeof payload?.sessionId !== 'string' || payload.sessionId !== worker.sessionId) return
      const event = normalizeSessionStatus(worker.sessionId, worker.generation, payload.status)
      if (event !== null) worker.enqueueActivity([event])
    }
  }

  /**
   * Read persisted session events after the runtime's cursor. `session/resume`
   * only reports new events, so without this step a tool result or job
   * settlement committed just before a crash would be reported as unknown.
   */
  private async readSessionActivity(
    spec: WorkSessionSpec,
    generation: number,
  ): Promise<ActivityEvent[]> {
    const file = await findSessionLog(this.options.taskDir, spec.sessionId)
    if (file === null) return []
    return readSessionActivityFile(file, spec.sessionId, generation, spec.activityCursor ?? 0)
  }

  private requireWorker(workId: string): Worker {
    const worker = this.workers.get(workId)
    if (worker === undefined || worker.dead) {
      throw new AppError('HARNESS_NOT_READY', `work ${workId} 没有可用的 harness 进程`)
    }
    return worker
  }
}
