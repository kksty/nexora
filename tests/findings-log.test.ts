import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { repairFindingsLog } from '../src/core/findings-log.ts'
import { renderFindingBlock, renderFindingsHeader } from '../src/core/render.ts'
import { createHarness } from './support/harness.ts'

/** Append two findings through the engine and return the task paths + state. */
async function twoFindingHarness(t: { after: (fn: () => Promise<void> | void) => void }) {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.appendFinding('W-0001', { text: '第一条记录。' })
  await harness.engine.appendFinding('W-0001', { text: '第二条记录，含中文正文。' })
  const state = harness.engine.state
  assert.equal(state.findings.length, 2)
  return { harness, state }
}

test('修复 findings.md：半截块标题被替换为完整记录，而不是追加在碎片后', async (t) => {
  const { harness, state } = await twoFindingHarness(t)
  const [first, second] = state.findings
  assert.ok(first && second)
  const header = renderFindingsHeader(state)
  const broken = `${header}\n${renderFindingBlock(first)}\n## F-000`
  await writeFile(harness.paths.findingsFile, broken, 'utf8')

  const result = await repairFindingsLog(harness.paths.findingsFile, state, state.findings)
  assert.equal(result.action, 'repaired-tail')
  assert.deepEqual(result.written, [second.id])
  const repaired = await readFile(harness.paths.findingsFile, 'utf8')
  assert.ok(repaired.includes(renderFindingBlock(second).trimEnd()))
  assert.ok(!repaired.includes('## F-000\n'), '半截标题不应残留')
})

test('修复 findings.md：多字节字符被截断留下的 U+FFFD 尾部会被重写', async (t) => {
  const { harness, state } = await twoFindingHarness(t)
  const [first, second] = state.findings
  assert.ok(first && second)
  const header = renderFindingsHeader(state)
  const block = renderFindingBlock(second)
  // Cut the UTF-8 bytes in the middle of a character; decoding yields U+FFFD.
  const bytes = Buffer.from(block, 'utf8')
  const brokenBlock = bytes.subarray(0, bytes.length - 3).toString('utf8')
  assert.ok(brokenBlock.endsWith('\uFFFD'), '截断点应落在多字节字符中间')
  const broken = `${header}\n${renderFindingBlock(first)}\n${brokenBlock}`
  await writeFile(harness.paths.findingsFile, broken, 'utf8')

  const result = await repairFindingsLog(harness.paths.findingsFile, state, state.findings)
  assert.equal(result.action, 'repaired-tail')
  const repaired = await readFile(harness.paths.findingsFile, 'utf8')
  assert.ok(repaired.includes(renderFindingBlock(second).trimEnd()))
  assert.ok(!repaired.includes('\uFFFD'))
})

test('修复 findings.md：CRLF 只是行尾差异，不被判为人工修改', async (t) => {
  const { harness, state } = await twoFindingHarness(t)
  const header = renderFindingsHeader(state)
  const original = `${header}\n${state.findings.map((finding) => renderFindingBlock(finding)).join('\n')}`
  const crlf = original.replace(/\n/g, '\r\n')
  await writeFile(harness.paths.findingsFile, crlf, 'utf8')

  const result = await repairFindingsLog(harness.paths.findingsFile, state, state.findings)
  assert.equal(result.action, 'unchanged')
  assert.deepEqual(result.modified, [])
  const repaired = await readFile(harness.paths.findingsFile, 'utf8')
  assert.equal(repaired, crlf, '完整块的 CRLF 内容保持原样')
})

test('修复 findings.md：完整块后的人工追加内容保留并报 modified', async (t) => {
  const { harness, state } = await twoFindingHarness(t)
  const header = renderFindingsHeader(state)
  const body = `${header}\n${state.findings.map((finding) => renderFindingBlock(finding)).join('\n')}`
  const withNote = `${body}\n## 人工备注\n\n这段内容不是运行时写入的。\n`
  await writeFile(harness.paths.findingsFile, withNote, 'utf8')

  const result = await repairFindingsLog(harness.paths.findingsFile, state, state.findings)
  assert.equal(result.action, 'unchanged')
  assert.deepEqual(result.modified, [state.findings.at(-1)!.id])
  const repaired = await readFile(harness.paths.findingsFile, 'utf8')
  assert.ok(repaired.includes('这段内容不是运行时写入的。'))
})
