/**
 * Append-only `findings.md` materialization.
 *
 * The authoritative records live in `state.json`. This module writes the
 * Markdown log and repairs the only failure shape the runtime can produce on
 * its own: a crash between committing a finding and finishing its append. A
 * complete block is verified by content, not merely by the presence of its ID;
 * a truncated tail is replaced and missing trailing blocks are appended once.
 * Complete committed history is never rewritten.
 */

import { dirname } from 'node:path'
import type { FindingRecord, RuntimeState } from '../types.ts'
import { appendFileDurable, ensureDir, readTextIfExists, writeFileAtomic } from '../util/atomic.ts'
import { AppError } from '../util/errors.ts'
import { renderFindingBlock, renderFindingsHeader } from './render.ts'

interface FindingSegment {
  id: string
  start: number
  end: number
  text: string
}

const BLOCK_HEADER = /^## (F-\d+) · W-\d+ · /gm
/** A finding header that was cut short by a crash (`## F-00`, `## F-0002 · W-00`). */
const PARTIAL_BLOCK_HEADER = /^#{1,2}\s?(?:F(?:-\d*)?(?:\s·.*)?)?$/

function parseSegments(markdown: string): FindingSegment[] {
  const starts: { id: string; start: number }[] = []
  BLOCK_HEADER.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BLOCK_HEADER.exec(markdown)) !== null) {
    if (match[1] !== undefined) starts.push({ id: match[1], start: match.index })
  }
  return starts.map((entry, index) => {
    const end = starts[index + 1]?.start ?? markdown.length
    return { id: entry.id, start: entry.start, end, text: markdown.slice(entry.start, end) }
  })
}

/**
 * Detect a block header truncated by a crash at the very end of the log.
 *
 * Such a fragment (`## F-00`) matches no complete header, so segment parsing
 * would count it as part of the previous block. Treating it as the stale tail
 * lets recovery replace it with the complete record instead of appending a new
 * block after the fragment.
 */
function partialHeaderStart(markdown: string): number | null {
  const trimmed = markdown.trimEnd()
  if (trimmed.length === 0) return null
  const lineStart = trimmed.lastIndexOf('\n') + 1
  const line = trimmed.slice(lineStart)
  if (!line.startsWith('#')) return null
  if (!PARTIAL_BLOCK_HEADER.test(line)) return null
  // A complete header at EOF is also a truncated block (header without body);
  // hand it to segment parsing so the normal tail repair handles it.
  if (/^## F-\d+ · W-\d+ · /.test(line)) return null
  return lineStart
}

function comparable(text: string): string {
  // A crash can cut a UTF-8 character in half (the reader yields U+FFFD) or
  // leave the file with CRLF line endings. Neither is a semantic edit, so
  // normalize both before deciding whether a block is truncated.
  return text.replace(/\r\n/g, '\n').replace(/\uFFFD+$/, '').trimEnd()
}

function blockState(segment: FindingSegment, finding: FindingRecord): 'complete' | 'truncated' | 'modified' {
  const actual = comparable(segment.text)
  const expected = renderFindingBlock(finding).trimEnd()
  if (actual === expected) return 'complete'
  // A crash during append leaves a prefix of the rendered block. A complete
  // block whose text differs elsewhere (for example a manually redacted copy)
  // is not a runtime half-write and is left untouched.
  if (expected.startsWith(actual)) return 'truncated'
  return 'modified'
}

export interface FindingsRepairResult {
  action: 'created' | 'appended' | 'repaired-tail' | 'unchanged'
  /** Finding IDs (re)written by this repair. */
  written: string[]
  /** Existing complete blocks whose text differs from the state rendering. */
  modified: string[]
}

/**
 * Materialize or repair `findings.md` against the authoritative record list.
 *
 * Throws `FINDINGS_LOG_CORRUPT` when a non-tail block is broken or blocks are
 * out of order; silently rewriting committed history would make the append-only
 * log claim something the runtime cannot prove.
 */
export async function repairFindingsLog(
  findingsFile: string,
  state: RuntimeState,
  findings: readonly FindingRecord[],
): Promise<FindingsRepairResult> {
  await ensureDir(dirname(findingsFile))
  const existing = await readTextIfExists(findingsFile)
  if (existing === null) {
    const header = renderFindingsHeader(state)
    const body = findings.map((finding) => renderFindingBlock(finding)).join('\n')
    await writeFileAtomic(findingsFile, body.length === 0 ? header : `${header}\n${body}`)
    return { action: 'created', written: findings.map((finding) => finding.id), modified: [] }
  }

  const partialStart = partialHeaderStart(existing)
  // Everything before a truncated final header is complete history. Parse only
  // that prefix so the fragment is not mistaken for part of the last block.
  const content = partialStart === null ? existing : existing.slice(0, partialStart)
  const segments = parseSegments(content)
  let cursor = 0
  let repairFrom: number | null = null
  const modified: string[] = []
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    const expected = findings[cursor]
    if (expected === undefined) {
      throw new AppError(
        'FINDINGS_LOG_CORRUPT',
        `findings.md 含有状态中不存在的记录 ${segment.id}；请人工核对，运行时不会删除已写出的历史块`,
      )
    }
    if (segment.id !== expected.id) {
      throw new AppError(
        'FINDINGS_LOG_CORRUPT',
        `findings.md 的记录顺序与权威状态不一致：位置 ${index + 1} 是 ${segment.id}，期望 ${expected.id}`,
      )
    }
    const block = blockState(segment, expected)
    if (block === 'truncated') {
      const isLast = index === segments.length - 1 && content.slice(segment.end).trim().length === 0
      if (!isLast) {
        throw new AppError(
          'FINDINGS_LOG_CORRUPT',
          `findings.md 中 ${segment.id} 的块未写完且不在文件尾部；请人工核对，运行时只修复未完成尾部`,
        )
      }
      repairFrom = segment.start
      break
    }
    // A complete block modified outside the runtime (for example a redacted
    // copy) is reported but never rewritten: it is not a half-write.
    if (block === 'modified') modified.push(segment.id)
    cursor += 1
  }

  const remaining = findings.slice(cursor)
  if (remaining.length === 0) {
    if (partialStart !== null) {
      throw new AppError(
        'FINDINGS_LOG_CORRUPT',
        'findings.md 尾部有不完整的发现标题，但状态中没有待补齐的记录；请人工核对',
      )
    }
    return { action: 'unchanged', written: [], modified }
  }

  const blocks = remaining.map((finding) => renderFindingBlock(finding)).join('\n')
  if (partialStart !== null && repairFrom === null) repairFrom = partialStart
  if (repairFrom !== null) {
    // Keep the committed prefix byte-for-byte; only the truncated tail is
    // replaced. The header/block separator already present is preserved.
    const prefix = existing.slice(0, repairFrom)
    await writeFileAtomic(findingsFile, `${prefix}${blocks}`)
    return { action: 'repaired-tail', written: remaining.map((finding) => finding.id), modified }
  }

  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await appendFileDurable(findingsFile, `${separator}${blocks}`)
  return { action: 'appended', written: remaining.map((finding) => finding.id), modified }
}
