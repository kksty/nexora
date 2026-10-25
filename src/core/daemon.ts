/**
 * Access to the loopback API of a running task runtime.
 *
 * The daemon writes `runtime/daemon.json` while it is alive and removes it on
 * graceful shutdown. The file carries the ephemeral port and bearer token for
 * the MCP bridge and the human CLI/Web UI; it must never be served to agents or
 * exposed through the Web UI.
 */

import { readTextIfExists, writeFileAtomic } from '../util/atomic.ts'
import { AppError } from '../util/errors.ts'
import { nowIso } from '../util/time.ts'
import type { TaskPaths } from './paths.ts'

export interface DaemonInfo {
  url: string
  token: string
  pid: number
  taskId: string
  startedAt: string
}

/** Read the daemon descriptor, or null when the runtime is not running. */
export async function readDaemonInfo(paths: TaskPaths): Promise<DaemonInfo | null> {
  const raw = await readTextIfExists(paths.daemonFile)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonInfo>
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.taskId !== 'string'
    ) {
      return null
    }
    return parsed as DaemonInfo
  } catch {
    return null
  }
}

/** Persist the daemon descriptor atomically. */
export async function writeDaemonInfo(paths: TaskPaths, info: Omit<DaemonInfo, 'startedAt'> & { startedAt?: string }): Promise<DaemonInfo> {
  const record: DaemonInfo = { ...info, startedAt: info.startedAt ?? nowIso() }
  await writeFileAtomic(paths.daemonFile, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** Remove the descriptor; missing files are fine. */
export async function removeDaemonInfo(paths: TaskPaths): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(paths.daemonFile, { force: true }).catch(() => undefined)
}

/** Probe `/health` with a short timeout. A stale descriptor is simply not alive. */
export async function daemonAlive(info: DaemonInfo, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return false
    const health = await response.json() as { ok?: boolean; taskId?: string }
    // Host-network ports can be reused by another task after a daemon exits.
    return health.ok === true && health.taskId === info.taskId
  } catch {
    return false
  }
}

/** Call one admin or work-scoped operation and unwrap the envelope. */
export async function callDaemon(
  info: DaemonInfo,
  path: '/admin' | '/rpc',
  op: string,
  params: unknown,
  options: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<unknown> {
  const response = await fetch(`${info.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}`, ...options.headers },
    body: JSON.stringify({ op, params }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  const payload = (await response.json()) as {
    ok?: boolean
    result?: unknown
    error?: { code?: string; message?: string }
  }
  if (payload.ok !== true) {
    throw new AppError(payload.error?.code ?? 'ADMIN_ERROR', payload.error?.message ?? '管理调用失败')
  }
  return payload.result
}
