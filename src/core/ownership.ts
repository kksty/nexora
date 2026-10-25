/** Single writer enforced by an OS-backed SQLite exclusive lock, not lease expiry. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { AppError } from '../util/errors.ts'
import { writeFileAtomic } from '../util/atomic.ts'
import { tryFileLock } from '../util/file-lock.ts'
import { Mutex } from '../util/mutex.ts'
import { nowIso } from '../util/time.ts'
import { daemonAlive, readDaemonInfo } from './daemon.ts'
import type { TaskPaths } from './paths.ts'

export type TaskOwnerKind = 'daemon' | 'web' | 'cli'
export interface TaskOwnerRecord {
  owner: TaskOwnerKind
  pid: number
  taskId: string
  token: string
  acquiredAt: string
  heartbeatAt: string
  protocol?: 'sqlite-v1'
}
export interface AcquireOwnershipOptions {
  waitMs?: number
  /** Used only when migrating an old file-only lease. */
  staleMs?: number
  heartbeatMs?: number
}
const held = new Map<string, { unlock: () => void; mutex: Mutex; path: string }>()
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function readTaskOwnership(paths: TaskPaths): Promise<TaskOwnerRecord | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = await readFile(paths.ownerFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (raw === null) return null
    try {
      const value = JSON.parse(raw) as TaskOwnerRecord
      if (value && ['daemon', 'web', 'cli'].includes(value.owner) && typeof value.pid === 'number' &&
          typeof value.taskId === 'string' && typeof value.token === 'string' &&
          typeof value.acquiredAt === 'string' && typeof value.heartbeatAt === 'string') return value
    } catch { /* an older runtime may still update metadata in place */ }
    await sleep(5)
  }
  return null
}

export async function acquireTaskOwnership(
  paths: TaskPaths, owner: TaskOwnerKind, options: AcquireOwnershipOptions = {},
): Promise<TaskOwnerRecord> {
  await assertTaskWritable(paths)
  await mkdir(paths.runtimeDir, { recursive: true })
  const deadline = Date.now() + Math.max(0, options.waitMs ?? 0)
  for (;;) {
    const unlock = tryFileLock(paths.ownerFile + '.lock.sqlite')
    if (unlock !== null) {
      let accepted = false
      try {
        await assertTaskWritable(paths)
        const existing = await readTaskOwnership(paths)
        // Legacy processes do not hold the kernel lock. Respect their lease and
        // health check during migration; deployments must stop old writers first.
        let legacyBusy = false
        if (existing !== null && existing.protocol !== 'sqlite-v1') {
          const age = Date.now() - Date.parse(existing.heartbeatAt)
          legacyBusy = !Number.isFinite(age) || age <= (options.staleMs ?? 8_000)
          if (existing.owner === 'daemon') {
            const daemon = await readDaemonInfo(paths)
            if (daemon !== null && await daemonAlive(daemon, 1_200)) legacyBusy = true
          }
        } else if (existing === null) {
          const info = await stat(paths.ownerFile).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
          })
          legacyBusy = info !== null && Date.now() - info.mtimeMs < 1_000
        }
        if (!legacyBusy) {
          const at = nowIso()
          const record: TaskOwnerRecord = {
            owner, pid: process.pid, taskId: paths.taskId,
            token: owner + '-' + process.pid + '-' + randomUUID(),
            acquiredAt: at, heartbeatAt: at, protocol: 'sqlite-v1',
          }
          await writeFileAtomic(paths.ownerFile, JSON.stringify(record, null, 2) + '\n')
          held.set(record.token, { unlock, mutex: new Mutex(), path: paths.ownerFile })
          accepted = true
          return record
        }
      } finally {
        if (!accepted) unlock()
      }
    }
    if (Date.now() >= deadline) {
      throw new AppError('TASK_BUSY', '任务写入锁被占用，或旧版运行时仍在响应；请停止旧运行时后重试。')
    }
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())))
  }
}

async function assertTaskWritable(paths: TaskPaths): Promise<void> {
  if (await stat(paths.ownerFile + '.deleting').then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })) throw new AppError('TASK_DELETING', '任务正在删除，不能重新取得写入权')
  await stat(paths.stateFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new AppError('TASK_NOT_FOUND', '任务已删除或尚未初始化')
    throw error
  })
}

/** Commit deletion before releasing the Windows file handle; late writers fail closed. */
export async function deleteOwnedTask(paths: TaskPaths, record: TaskOwnerRecord): Promise<void> {
  const lock = held.get(record.token)
  if (lock === undefined || lock.path !== paths.ownerFile) throw new AppError('TASK_BUSY', '删除需要持有写入锁')
  await lock.mutex.run(async () => {
    if ((await readTaskOwnership(paths))?.token !== record.token) throw new AppError('TASK_BUSY', '写入所有权已丢失')
    await writeFileAtomic(paths.ownerFile + '.deleting', JSON.stringify({ at: nowIso() }))
    // Once state is gone, even a caller racing the final tombstone removal
    // cannot acquire ownership of a task that no longer exists.
    await rm(paths.stateFile, { force: true })
  })
  await releaseTaskOwnership(paths, record)
  await rm(paths.taskDir, { recursive: true, force: true, maxRetries: 3 })
}

export async function renewTaskOwnership(
  paths: TaskPaths, record: TaskOwnerRecord, signal?: AbortSignal,
): Promise<boolean> {
  const lock = held.get(record.token)
  if (lock === undefined || lock.path !== paths.ownerFile) return false
  return lock.mutex.run(async () => {
    if (signal?.aborted || held.get(record.token) !== lock) return false
    const current = await readTaskOwnership(paths)
    if (signal?.aborted || current?.token !== record.token) return false
    await writeFileAtomic(paths.ownerFile, JSON.stringify({ ...current, heartbeatAt: nowIso() }, null, 2) + '\n')
    return true
  })
}

export function startOwnershipHeartbeat(
  paths: TaskPaths, record: TaskOwnerRecord, heartbeatMs = 2_000,
): { stop: () => Promise<void>; lost: () => boolean } {
  let lost = false
  let busy = false
  const controller = new AbortController()
  let inFlight: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    if (busy || lost) return
    busy = true
    inFlight = renewTaskOwnership(paths, record, controller.signal)
      .then((ok) => { if (!ok && !controller.signal.aborted) lost = true })
      .catch(() => { lost = true })
      .finally(() => { busy = false })
  }, heartbeatMs)
  timer.unref?.()
  return {
    stop: async () => { controller.abort(); clearInterval(timer); await inFlight },
    lost: () => lost,
  }
}

export async function releaseTaskOwnership(paths: TaskPaths, record: TaskOwnerRecord): Promise<void> {
  const lock = held.get(record.token)
  if (lock === undefined || lock.path !== paths.ownerFile) return
  await lock.mutex.run(async () => {
    if (held.get(record.token) !== lock) return
    try {
      if ((await readTaskOwnership(paths))?.token === record.token) await rm(paths.ownerFile, { force: true })
    } finally {
      held.delete(record.token)
      lock.unlock()
    }
  })
}

