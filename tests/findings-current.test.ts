import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { buildFindingsIndex, queryFindings, resolveCurrentIds } from '../src/core/findings.ts'
import { repairFindingsLog } from '../src/core/findings-log.ts'
import type { FindingRecord } from '../src/types.ts'
import { createHarness } from './support/harness.ts'

test('替代链：多级替代与两个并行分支都保留为当前记录', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const a = await harness.engine.appendFinding('W-0001', { text: '根结论：口令可猜' })
  const b = await harness.engine.appendFinding('W-0001', {
    text: '分支 B：口令策略薄弱',
    supersedes: [a.id],
  })
  const c = await harness.engine.appendFinding('W-0001', {
    text: '分支 C：口令不可猜但可爆破',
    supersedes: [a.id],
  })
  const d = await harness.engine.appendFinding('W-0001', {
    text: '分支 B 的进一步结论：锁定策略缺失',
    supersedes: [b.id],
  })

  const current = await harness.engine.queryShared('W-0001', { scope: 'findings' })
  assert.deepEqual(
    (current.records as { id: string }[]).map((finding) => finding.id),
    [c.id, d.id],
  )
  assert.equal(current.total, 2)
  assert.equal(current.view, 'current')

  const history = await harness.engine.queryShared('W-0001', {
    scope: 'findings',
    view: 'history',
  })
  assert.equal(history.records.length, 4)

  const rootView = await harness.engine.getFinding('W-0001', a.id)
  assert.equal(rootView.current, false)
  assert.deepEqual(rootView.currentIds, [c.id, d.id])
  assert.doesNotMatch(rootView.text, /根结论：口令可猜/, '旧正文默认不展开')

  const rootHistory = await harness.engine.getFinding('W-0001', a.id, { history: true })
  assert.match(rootHistory.text, /根结论：口令可猜/)
  assert.match(rootHistory.text, new RegExp(c.id))
  assert.match(rootHistory.text, new RegExp(d.id))

  const branch = await harness.engine.getFinding('W-0001', b.id)
  assert.deepEqual(branch.currentIds, [d.id])

  const shared = await harness.engine.readShared('W-0001', { section: 'findings' })
  assert.match(shared.text, new RegExp(c.id))
  assert.match(shared.text, new RegExp(d.id))
  assert.doesNotMatch(shared.text, /根结论：口令可猜/, '默认共享阅读不返回已被替代的旧正文')
  assert.equal(shared.findings, 2)
  assert.equal(shared.historicalFindings, 4)
})

test('增量查询：游标分页不重不漏，替代通知不受过滤条件影响', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const first = await harness.engine.appendFinding('W-0001', { text: 'alpha 初始信号' })
  const second = await harness.engine.appendFinding('W-0001', { text: 'page item 二' })
  const third = await harness.engine.appendFinding('W-0001', { text: 'page item 三' })
  const fourth = await harness.engine.appendFinding('W-0001', { text: 'page item 四' })
  const fifth = await harness.engine.appendFinding('W-0001', { text: 'page item 五' })

  const pageOne = await harness.engine.queryShared('W-0001', { scope: 'findings', limit: 2 })
  assert.deepEqual(
    (pageOne.records as { id: string }[]).map((finding) => finding.id),
    [first.id, second.id],
  )
  assert.equal(pageOne.hasMore, true)
  assert.equal(pageOne.cursor, second.id)

  const pageTwo = await harness.engine.queryShared('W-0001', {
    scope: 'findings',
    since: pageOne.cursor ?? undefined,
    limit: 2,
  })
  assert.deepEqual(
    (pageTwo.records as { id: string }[]).map((finding) => finding.id),
    [third.id, fourth.id],
  )
  assert.equal(pageTwo.cursor, fourth.id)

  const pageThree = await harness.engine.queryShared('W-0001', {
    scope: 'findings',
    since: pageTwo.cursor ?? undefined,
    limit: 2,
  })
  assert.deepEqual(
    (pageThree.records as { id: string }[]).map((finding) => finding.id),
    [fifth.id],
  )
  assert.equal(pageThree.hasMore, false)

  // A cached, filtered result must learn that its record became stale even
  // when the superseding record does not match the same text filter.
  const cached = await harness.engine.queryShared('W-0001', { scope: 'findings', text: 'alpha 初始信号' })
  assert.deepEqual(
    (cached.records as { id: string }[]).map((finding) => finding.id),
    [first.id],
  )
  const replacement = await harness.engine.appendFinding('W-0001', {
    text: 'beta 替代结论',
    supersedes: [first.id],
  })
  const incremental = await harness.engine.queryShared('W-0001', {
    scope: 'findings',
    text: 'alpha 初始信号',
    since: cached.cursor ?? first.id,
  })
  assert.equal(incremental.records.length, 0)
  assert.deepEqual(incremental.superseded, [{ id: first.id, by: [replacement.id] }])

  const incrementalHistory = await harness.engine.queryShared('W-0001', {
    scope: 'findings',
    text: 'alpha 初始信号',
    since: cached.cursor ?? first.id,
    view: 'history',
  })
  // The cursor is the old record itself; only records appended after it are
  // scanned, and the invalidation notice is still delivered on the history view.
  assert.equal(incrementalHistory.records.length, 0)
  assert.deepEqual(incrementalHistory.superseded, [{ id: first.id, by: [replacement.id] }])
})

test('findings.md 只修复未完成尾部，完整历史前缀保持不变且幂等', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  await harness.engine.appendFinding('W-0001', { text: '第一条完整记录', type: '已验证事实' })
  await harness.engine.appendFinding('W-0001', {
    text: '第二条记录会写到一半时崩溃',
    evidence: ['evidence/proof.txt'],
  })
  const original = await readFile(harness.paths.findingsFile, 'utf8')
  const secondHeader = original.indexOf('## F-0002')
  assert.ok(secondHeader > 0)
  const truncated = original.slice(0, secondHeader + 40)
  await writeFile(harness.paths.findingsFile, truncated, 'utf8')

  const repaired = await repairFindingsLog(
    harness.paths.findingsFile,
    harness.engine.state,
    harness.engine.state.findings,
  )
  assert.equal(repaired.action, 'repaired-tail')
  assert.deepEqual(repaired.written, ['F-0002'])
  const afterRepair = await readFile(harness.paths.findingsFile, 'utf8')
  assert.equal(afterRepair.trimEnd(), original.trimEnd(), '恢复后的日志应与崩溃前一致')
  assert.match(afterRepair.slice(0, secondHeader), /第一条完整记录/)

  const again = await repairFindingsLog(
    harness.paths.findingsFile,
    harness.engine.state,
    harness.engine.state.findings,
  )
  assert.equal(again.action, 'unchanged')

  // A crash after the state commit but before the first append leaves only the
  // header; the repair appends every committed block once.
  const headerOnly = `${afterRepair.slice(0, afterRepair.indexOf('## F-0001'))}`
  await writeFile(harness.paths.findingsFile, headerOnly, 'utf8')
  const appended = await repairFindingsLog(
    harness.paths.findingsFile,
    harness.engine.state,
    harness.engine.state.findings,
  )
  assert.equal(appended.action, 'appended')
  assert.deepEqual(appended.written, ['F-0001', 'F-0002'])
  const restored = await readFile(harness.paths.findingsFile, 'utf8')
  assert.equal(restored.trimEnd(), original.trimEnd())
})

test('完整但被人工改写（脱敏）的历史块保留原样，只报告差异', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  await harness.engine.appendFinding('W-0001', { text: '包含敏感值 secret-value 的记录' })
  const original = await readFile(harness.paths.findingsFile, 'utf8')
  const redacted = original.replace('secret-value', '[已删除]')
  assert.notEqual(redacted, original)
  await writeFile(harness.paths.findingsFile, redacted, 'utf8')

  const result = await repairFindingsLog(
    harness.paths.findingsFile,
    harness.engine.state,
    harness.engine.state.findings,
  )
  assert.equal(result.action, 'unchanged')
  assert.deepEqual(result.modified, ['F-0001'])
  assert.equal(await readFile(harness.paths.findingsFile, 'utf8'), redacted, '不重写完整块')
})

test('替代图不会因环而无限解析', () => {
  const findings: FindingRecord[] = [
    {
      id: 'F-0001',
      authorWorkId: 'W-0001',
      createdAt: '2026-10-22T00:00:00.000Z',
      text: 'a',
      refs: [],
      evidence: [],
      supersedes: ['F-0002'],
      relatedWork: [],
    },
    {
      id: 'F-0002',
      authorWorkId: 'W-0001',
      createdAt: '2026-10-22T00:00:01.000Z',
      text: 'b',
      refs: [],
      evidence: [],
      supersedes: ['F-0001'],
      relatedWork: [],
    },
  ]
  const index = buildFindingsIndex(findings)
  assert.deepEqual(index.currentIds, [])
  assert.deepEqual(resolveCurrentIds('F-0001', findings), [])
  const result = queryFindings(findings, {})
  assert.equal(result.records.length, 0)
})
