/** Report identity, path validation and content hashing. */

import { createHash } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import type { ReportRecord } from '../types.ts'
import { AppError } from '../util/errors.ts'

export const DEFAULT_REPORT_KEY = 'report'
/** Reports are text documents; a larger draft is an accident, not a report. */
export const MAX_REPORT_BYTES = 5 * 1024 * 1024
const REPORT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ENTRY_EXTENSION = /\.(md|txt)$/i
const RESERVED_ENTRIES = new Set(['task.md', 'findings.md', 'works.md'])
const RUNTIME_STATE_FILES = new Set(['runtime/state.json', 'runtime/daemon.json'])

/** Validate a client-supplied report key; defaults to `report`. */
export function normalizeReportKey(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_REPORT_KEY
  if (typeof value !== 'string') throw new AppError('INVALID_ARGUMENT', 'key 必须是字符串')
  const trimmed = value.trim()
  if (trimmed.length === 0) return DEFAULT_REPORT_KEY
  if (!REPORT_KEY.test(trimmed)) {
    throw new AppError('INVALID_ARGUMENT', 'key 只能包含字母、数字、点、下划线、连字符，且不超过 64 字符')
  }
  return trimmed
}

/** Normalize a task-relative path and refuse escapes and reserved targets. */
export function normalizeTaskRelativePath(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AppError('INVALID_ARGUMENT', `${field} 必须是字符串`)
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.length === 0) throw new AppError('INVALID_ARGUMENT', `${field} 不能为空`)
  if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw new AppError('INVALID_ARGUMENT', `${field} 必须是任务目录内的相对路径`)
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new AppError('INVALID_ARGUMENT', `${field} 必须是任务目录内的相对路径`)
  }
  return normalized
}

/** Validate the fixed report entry: a text document outside runtime internals. */
export function normalizeReportEntryPath(value: unknown): string {
  const normalized = normalizeTaskRelativePath(value, 'path')
  // Compare case-insensitively: on Windows `TASK.md` and `task.md` are the same
  // file, and overwriting a shared document must be refused on every platform.
  const comparison = normalized.toLowerCase()
  if (comparison.startsWith('runtime/')) {
    throw new AppError('INVALID_ARGUMENT', 'path 不能位于 runtime/ 下；报告入口必须是执行者可读的任务文件')
  }
  if (RESERVED_ENTRIES.has(comparison)) {
    throw new AppError('INVALID_ARGUMENT', `path 不能覆盖共享文档：${normalized}`)
  }
  if (!ENTRY_EXTENSION.test(normalized)) {
    throw new AppError('INVALID_ARGUMENT', 'path 必须是 .md 或 .txt 报告文件')
  }
  return normalized
}

/** Resolve a task-relative path, proving it cannot escape the task directory. */
export function resolveInsideTask(taskDir: string, relativePath: string, field = 'path'): string {
  const comparison = relativePath.replace(/\\/g, '/').toLowerCase()
  if (comparison.startsWith('runtime/') && RUNTIME_STATE_FILES.has(comparison)) {
    throw new AppError('INVALID_ARGUMENT', `${field} 不能是运行时权威状态文件`)
  }
  const absolute = resolve(taskDir, relativePath)
  const root = resolve(taskDir)
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new AppError('INVALID_ARGUMENT', `${field} 超出任务目录`)
  }
  return absolute
}

/** Immutable content location for one report revision. */
export function reportContentRelative(key: string, revision: number): string {
  return `runtime/reports/${key}/r${revision}.md`
}

export function hashReportContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Short human-readable metadata used by shared reading and the Web UI. */
export function renderReportMeta(report: ReportRecord): string {
  return (
    `- 报告键：${report.key}\n` +
    `- 固定入口：${report.path}\n` +
    `- 版本：r${report.revision}\n` +
    `- 内容哈希：${report.contentHash}\n` +
    `- 字符数：${report.size}\n` +
    `- 发布者：${report.publishedByWorkId}\n` +
    `- 发布时间：${report.publishedAt}\n` +
    `- 入口状态：${report.entryState}\n` +
    `- 内容文件（恢复用）：${report.contentFile}\n`
  )
}
