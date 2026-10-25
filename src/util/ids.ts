/**
 * Identifier allocation. IDs are assigned by the runtime, never by agents.
 *
 * Every identifier is a stable, sortable string: `R-0001` (run), `W-0001` (work), `F-0001`
 * (finding), `M-0001` (message), `C-0001` (completion round), `CMD-0001`
 * (human command), and `T-YYYYMMDD-HHmmss-xxxx` (task). Agents quote these IDs
 * when they communicate or write findings, so the format is part of the public
 * interface.
 */

import { randomBytes } from 'node:crypto'
import { compactStamp } from './time.ts'

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

export function runId(sequence: number): string {
  return `R-${pad(sequence, 4)}`
}

export function workId(sequence: number): string {
  return `W-${pad(sequence, 4)}`
}

export function findingId(sequence: number): string {
  return `F-${pad(sequence, 4)}`
}

export function messageId(sequence: number): string {
  return `M-${pad(sequence, 4)}`
}

export function roundId(sequence: number): string {
  return `C-${pad(sequence, 4)}`
}

export function commandId(sequence: number): string {
  return `CMD-${pad(sequence, 4)}`
}

/** Create a new task id such as `T-20261021-193000-9f3a`. */
export function newTaskId(date = new Date()): string {
  return `T-${compactStamp(date)}-${randomBytes(2).toString('hex')}`
}

/** Deterministic harness session id for one work instance. */
export function sessionIdFor(taskId: string, work: string): string {
  return `liebian-${taskId}-${work}`
}

/** True when a user-supplied task directory name is safe to use as a path segment. */
export function isValidTaskId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value)
}

/** Numeric suffix of a runtime-assigned id (`F-0012` -> 12), or 0. */
export function sequenceOf(id: string): number {
  const match = /-(\d+)$/.exec(id)
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10)
}
