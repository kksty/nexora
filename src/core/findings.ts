/**
 * Finding queries, correction chains and the current-view index.
 *
 * The append-only log keeps every revision. The default query view only returns
 * findings that are not superseded by another record; historical records stay
 * reachable by ID or with `view=history`. The runtime never judges whether a
 * correction is semantically right — it only follows the links the executors
 * recorded.
 */

import type { FindingRecord } from '../types.ts'

/** Which slice of the append-only log a query covers. */
export type FindingView = 'current' | 'history'

export interface FindingQuery {
  text?: string
  author?: string
  type?: string
  refs?: string
  /** Cursor: only records appended after this finding ID are scanned. */
  since?: string
  /** Default `current`: superseded records are excluded. */
  view?: FindingView
  limit?: number
  offset?: number
}

/** One old finding that became stale after the caller's cursor. */
export interface SupersedeNotice {
  id: string
  /** IDs of the newly appended records that supersede `id`. */
  by: string[]
}

export interface FindingQueryResult {
  view: FindingView
  records: FindingRecord[]
  /** Number of records in the selected view. */
  total: number
  /** Number of matches in the scanned range (before pagination). */
  matched: number
  /** Last record actually scanned; safe to pass back as `since`. */
  cursor: string | null
  hasMore: boolean
  /** Invalidation notices for cached records, independent of the filter. */
  superseded: SupersedeNotice[]
}

export interface FindingsIndex {
  findings: readonly FindingRecord[]
  byId: Map<string, FindingRecord>
  /** Finding ID → IDs of records that directly supersede it. */
  supersededBy: Map<string, string[]>
  /** Append-order IDs with no incoming supersede edge. */
  currentIds: string[]
}

/** Numeric part of an `F-0018` identifier; -1 when the ID is not recognizable. */
export function findingSequence(id: string): number {
  const match = /^F-(\d+)$/.exec(id)
  if (match?.[1] === undefined) return -1
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : -1
}

/** Build the derived indexes once; callers pass the append-ordered array. */
export function buildFindingsIndex(findings: readonly FindingRecord[]): FindingsIndex {
  const byId = new Map<string, FindingRecord>()
  const supersededBy = new Map<string, string[]>()
  const superseded = new Set<string>()
  for (const finding of findings) {
    byId.set(finding.id, finding)
    for (const target of finding.supersedes) {
      if (target === finding.id) continue
      const list = supersededBy.get(target) ?? []
      if (!list.includes(finding.id)) list.push(finding.id)
      supersededBy.set(target, list)
      superseded.add(target)
    }
  }
  const currentIds = findings.filter((finding) => !superseded.has(finding.id)).map((finding) => finding.id)
  return { findings, byId, supersededBy, currentIds }
}

/** IDs of findings that directly correct or supersede `id`. */
export function correctionsFor(id: string, findings: readonly FindingRecord[]): string[] {
  return findings.filter((finding) => finding.supersedes.includes(id)).map((finding) => finding.id)
}

/**
 * Resolve an old ID to every current leaf along its supersede chain.
 *
 * A branched correction (two works superseding the same record) yields all
 * current branches. A cycle — which the runtime rejects on write but a
 * hand-edited document could contain — terminates and yields no leaf instead of
 * looping forever.
 */
export function resolveCurrentIds(
  id: string,
  findings: readonly FindingRecord[],
  index?: FindingsIndex,
): string[] {
  const built = index ?? buildFindingsIndex(findings)
  const visited = new Set<string>()
  const leaves: string[] = []
  const stack = [id]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    const next = (built.supersededBy.get(current) ?? []).filter((candidate) => built.byId.has(candidate))
    if (next.length === 0) {
      if (built.byId.has(current)) leaves.push(current)
      continue
    }
    stack.push(...next)
  }
  return leaves
    .filter((leaf, position, all) => all.indexOf(leaf) === position)
    .sort((left, right) => findingSequence(left) - findingSequence(right))
}

/** Attach direct correction relations so a result never silently hides them. */
export function withRelations(
  finding: FindingRecord,
  findings: readonly FindingRecord[],
): FindingRecord & { supersededBy: string[] } {
  return { ...finding, supersededBy: correctionsFor(finding.id, findings) }
}

function matches(finding: FindingRecord, query: FindingQuery): boolean {
  if (query.author !== undefined && finding.authorWorkId !== query.author) return false
  if (query.type !== undefined && (finding.type ?? '').toLowerCase() !== query.type.toLowerCase()) return false
  if (query.refs !== undefined) {
    const wanted = query.refs
    if (!finding.refs.includes(wanted) && !finding.supersedes.includes(wanted) && finding.id !== wanted) return false
  }
  if (query.text !== undefined && query.text.trim().length > 0) {
    const needle = query.text.trim().toLowerCase()
    const haystack = [
      finding.id,
      finding.text,
      finding.type ?? '',
      ...finding.refs,
      ...finding.supersedes,
      ...finding.evidence,
      ...finding.relatedWork,
    ]
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

/**
 * Query the append-only log with a resumable cursor.
 *
 * The cursor advances only over records the call actually scanned, so a page
 * limit can never skip records appended after the page boundary. When `since`
 * is supplied, records appended later that supersede records at or before the
 * cursor are reported in `superseded` even when the new record does not match
 * the caller's text filter; a client that cached the old content must learn it
 * is stale.
 */
export function queryFindings(findings: readonly FindingRecord[], query: FindingQuery): FindingQueryResult {
  const view: FindingView = query.view === 'history' ? 'history' : 'current'
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const offset = Math.max(query.offset ?? 0, 0)
  const index = buildFindingsIndex(findings)
  const pool =
    view === 'history'
      ? findings
      : index.currentIds
          .map((id) => index.byId.get(id))
          .filter((finding): finding is FindingRecord => finding !== undefined)
  const sinceSequence = query.since === undefined ? null : findingSequence(query.since)
  const candidates =
    sinceSequence === null || sinceSequence < 0
      ? [...pool]
      : pool.filter((finding) => findingSequence(finding.id) > sinceSequence)

  const matchedRecords = candidates.filter((finding) => matches(finding, query))
  const records: FindingRecord[] = []
  let scanned: string | null = sinceSequence === null ? null : query.since ?? null
  let skipped = 0
  for (const finding of candidates) {
    if (!matches(finding, query)) continue
    if (skipped < offset) {
      skipped += 1
      scanned = finding.id
      continue
    }
    records.push(finding)
    scanned = finding.id
    if (records.length >= limit) break
  }
  // When nothing matched, the cursor still advances over the scanned range so
  // the next call does not rescan the same non-matching records.
  if (candidates.length > 0 && records.length < limit) scanned = candidates.at(-1)!.id
  const hasMore = records.length + skipped < matchedRecords.length

  const superseded = new Map<string, string[]>()
  if (sinceSequence !== null && sinceSequence >= 0) {
    for (const finding of findings) {
      if (findingSequence(finding.id) <= sinceSequence) continue
      for (const target of finding.supersedes) {
        const targetSequence = findingSequence(target)
        if (targetSequence < 0 || targetSequence > sinceSequence) continue
        const list = superseded.get(target) ?? []
        if (!list.includes(finding.id)) list.push(finding.id)
        superseded.set(target, list)
      }
    }
  }

  return {
    view,
    records,
    total: pool.length,
    matched: matchedRecords.length,
    cursor: scanned,
    hasMore,
    superseded: [...superseded.entries()].map(([id, by]) => ({ id, by })),
  }
}
