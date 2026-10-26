/**
 * Shared model-request semaphore for one task runtime.
 *
 * Every executor process asks the runtime for a slot immediately before it
 * opens a model stream and returns the slot when the stream settles. The
 * semaphore therefore limits *requests in flight*, not executors: an executor
 * that is running a tool, waiting for a message or backing off holds no slot.
 *
 * The queue is FIFO, permits have caller-supplied identities (so a cancelled
 * request can be cleaned up even if its acquire response was lost), and
 * release is idempotent.
 */

import { randomUUID } from 'node:crypto'
import { AppError } from './errors.ts'

export const DEFAULT_MODEL_CONCURRENCY = 2

export interface ModelPermit {
  permitId: string
  workId: string
  generation: number
}

export interface AcquireModelPermitOptions {
  workId: string
  generation?: number
  /** Client-chosen id; generated when omitted. */
  permitId?: string
  signal?: AbortSignal
}

export interface ModelSlotStats {
  limit: number
  active: number
  queued: number
}

export interface ReleasedSlots {
  active: number
  queued: number
}

interface Waiter {
  permitId: string
  workId: string
  generation: number
  signal?: AbortSignal
  onAbort?: () => void
  resolve: (permit: ModelPermit) => void
  reject: (error: unknown) => void
}

export function abortReason(signal?: AbortSignal): unknown {
  const reason = signal?.reason
  // AbortSignal.reason is a DOMException by default, which is not an Error in
  // every Node build. Normalize the ordinary abort to the runtime's own code so
  // callers (and the loopback API) see one stable cancellation error.
  if (reason instanceof AppError) return reason
  if (reason instanceof Error && reason.name !== 'AbortError') return reason
  return new AppError('REQUEST_ABORTED', '请求已取消')
}

/**
 * Validate the configured model concurrency. Startup configuration is strict:
 * a malformed value is a configuration error, never a silent fallback.
 */
export function parseModelConcurrency(value: unknown, fallback = DEFAULT_MODEL_CONCURRENCY): number {
  if (value === undefined || value === null || value === '') return fallback
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^[1-9]\d*$/.test(text)) {
    throw new AppError('INVALID_ARGUMENT', `模型请求并发数必须是正整数：${String(value)}`)
  }
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError('INVALID_ARGUMENT', `模型请求并发数超出范围：${String(value)}`)
  }
  return parsed
}

/** Resolve `LIEBIAN_MODEL_CONCURRENCY` with the documented default of 2. */
export function modelConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseModelConcurrency(env.LIEBIAN_MODEL_CONCURRENCY)
}

/**
 * Bounded slot pool shared by every executor in one task runtime.
 *
 * This object is owned by the runtime process. Executor processes reach it
 * through the loopback API; creating one per executor would defeat the limit.
 */
export class Semaphore {
  readonly limit: number

  private readonly active = new Map<string, ModelPermit>()
  private queue: Waiter[] = []
  /**
   * Releases can overtake their acquire request on the loopback socket when a
   * caller aborts. Keep a short-lived tombstone so that a late acquire cannot
   * grant a permit nobody will return.
   */
  private readonly cancelled = new Map<string, number>()
  private closed = false

  constructor(limit: number = DEFAULT_MODEL_CONCURRENCY) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new AppError('INVALID_ARGUMENT', `模型请求并发数必须是正整数：${String(limit)}`)
    }
    this.limit = limit
  }

  get stats(): ModelSlotStats {
    return { limit: this.limit, active: this.active.size, queued: this.queue.length }
  }

  owner(permitId: string): ModelPermit | undefined {
    const active = this.active.get(permitId)
    if (active !== undefined) return active
    const queued = this.queue.find((waiter) => waiter.permitId === permitId)
    return queued === undefined ? undefined : { permitId, workId: queued.workId, generation: queued.generation }
  }

  /** Wait for a slot. An aborted waiter is removed without consuming a slot. */
  acquire(options: AcquireModelPermitOptions): Promise<ModelPermit> {
    const { workId } = options
    if (workId.length === 0) return Promise.reject(new AppError('INVALID_ARGUMENT', '缺少 work ID'))
    if (this.closed) return Promise.reject(new AppError('RUNTIME_CLOSED', '运行时已关闭'))
    const permitId = options.permitId ?? randomUUID()
    if (permitId.length === 0 || permitId.length > 200) {
      return Promise.reject(new AppError('INVALID_ARGUMENT', '非法 permit ID'))
    }
    if (this.active.has(permitId) || this.queue.some((waiter) => waiter.permitId === permitId)) {
      return Promise.reject(new AppError('INVALID_ARGUMENT', `permit ID 已存在：${permitId}`))
    }
    if ((this.cancelled.get(permitId) ?? 0) > Date.now()) {
      return Promise.reject(new AppError('REQUEST_ABORTED', '请求在获得名额前已取消'))
    }
    if (options.signal?.aborted === true) return Promise.reject(abortReason(options.signal))

    return new Promise<ModelPermit>((resolve, reject) => {
      const waiter: Waiter = {
        permitId,
        workId,
        generation: options.generation ?? 0,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        resolve,
        reject,
      }
      if (this.active.size < this.limit) {
        this.grant(waiter)
        return
      }
      this.enqueue(waiter)
    })
  }

  /**
   * Return one slot. Repeated calls for the same permit are harmless and never
   * drive the counter below zero.
   */
  release(permitId: string): boolean {
    if (!this.active.delete(permitId)) return false
    this.rememberCancelled(permitId)
    this.dispatch()
    return true
  }

  /**
   * Cancel a request that never reached (or never finished) acquire: remove a
   * queued waiter by its client-chosen id, or remember the id briefly so a late
   * acquire is refused instead of leaking a permit.
   */
  cancel(permitId: string): boolean {
    this.rememberCancelled(permitId)
    if (this.active.delete(permitId)) {
      this.dispatch()
      return true
    }
    const index = this.queue.findIndex((waiter) => waiter.permitId === permitId)
    if (index >= 0) {
      const [waiter] = this.queue.splice(index, 1)
      this.detachAbort(waiter)
      waiter.reject(new AppError('REQUEST_ABORTED', '请求在获得名额前已取消'))
      return true
    }
    this.rememberCancelled(permitId)
    return false
  }

  /**
   * Reclaim everything owned by one executor: queued waits are rejected and
   * held permits are returned. Used when a harness process exits, including an
   * unexpected crash where no plugin `finally` can run.
   */
  releaseWork(workId: string, generation?: number): ReleasedSlots {
    let queued = 0
    const remaining: Waiter[] = []
    for (const waiter of this.queue) {
      if (waiter.workId !== workId || (generation !== undefined && waiter.generation !== generation)) {
        remaining.push(waiter)
        continue
      }
      this.detachAbort(waiter)
      this.rememberCancelled(waiter.permitId)
      waiter.reject(new AppError('WORK_EXITED', `work ${workId} 已退出，模型请求名额已回收`))
      queued += 1
    }
    this.queue = remaining

    let active = 0
    for (const [permitId, permit] of this.active) {
      if (permit.workId !== workId || (generation !== undefined && permit.generation !== generation)) continue
      this.active.delete(permitId)
      this.rememberCancelled(permitId)
      active += 1
    }
    if (active > 0) this.dispatch()
    return { active, queued }
  }

  /** Stop the pool and reject every waiter. Held permits become no-ops. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const waiters = this.queue
    this.queue = []
    for (const waiter of waiters) {
      this.detachAbort(waiter)
      waiter.reject(new AppError('RUNTIME_CLOSED', '运行时已关闭'))
    }
    this.active.clear()
    this.cancelled.clear()
  }

  private rememberCancelled(permitId: string): void {
    const now = Date.now()
    for (const [id, expiresAt] of this.cancelled) {
      if (expiresAt <= now) this.cancelled.delete(id)
    }
    // Bound memory even if a misbehaving client cancels random ids forever.
    if (this.cancelled.size >= 10_000) {
      const oldest = this.cancelled.keys().next().value
      if (oldest !== undefined) this.cancelled.delete(oldest)
    }
    this.cancelled.set(permitId, now + 60_000)
  }

  private enqueue(waiter: Waiter): void {
    if (waiter.signal !== undefined) {
      waiter.onAbort = () => this.cancelQueued(waiter, abortReason(waiter.signal))
      waiter.signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    this.queue.push(waiter)
  }

  private cancelQueued(waiter: Waiter, error: unknown): void {
    const index = this.queue.indexOf(waiter)
    if (index < 0) return
    this.queue.splice(index, 1)
    this.detachAbort(waiter)
    waiter.reject(error)
  }

  private grant(waiter: Waiter): void {
    if (waiter.signal?.aborted === true) {
      this.detachAbort(waiter)
      waiter.reject(abortReason(waiter.signal))
      return
    }
    this.detachAbort(waiter)
    const permit: ModelPermit = { permitId: waiter.permitId, workId: waiter.workId, generation: waiter.generation }
    this.active.set(permit.permitId, permit)
    waiter.resolve(permit)
  }

  /** Hand freed slots to the oldest waiting requests. */
  private dispatch(): void {
    while (!this.closed && this.active.size < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()
      if (waiter === undefined) return
      this.grant(waiter)
    }
  }

  private detachAbort(waiter: Waiter): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    waiter.onAbort = undefined
  }
}
