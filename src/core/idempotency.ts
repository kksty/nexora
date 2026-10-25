import { createHash } from 'node:crypto'
import { AppError } from '../util/errors.ts'

/** Scope keys to operation and author, avoiding object-prototype keys. */
export function workRequestKey(workId: string, op: string, requestId?: string): string | undefined {
  if (requestId === undefined) return undefined
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) {
    throw new AppError('INVALID_ARGUMENT', 'request_id 必须为 1–200 位字母、数字、点、下划线、冒号或连字符')
  }
  return JSON.stringify([workId, op, requestId])
}

export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function replayRequest<T>(record: { fingerprint: string; result: unknown }, fingerprint: string): T {
  if (record.fingerprint !== fingerprint) {
    throw new AppError('REQUEST_CONFLICT', '该 request_id 已用于不同内容；重试必须沿用原参数，新操作请使用新 ID')
  }
  return structuredClone(record.result) as T
}
