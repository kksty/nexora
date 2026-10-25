import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createHarness, waitUntil } from './support/harness.ts'

test('两个 work 并发追加发现不会互相覆盖', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.spawnWork('W-0001', { reason: '并行验证另一条路径', start_prompt: '从 /login 开始' })
  assert.equal(await harness.engine.whenQuiet(), true)

  const [first, second] = await Promise.all([
    harness.engine.appendFinding('W-0001', { text: '第一条并发发现', type: '已验证事实' }),
    harness.engine.appendFinding('W-0002', { text: '第二条并发发现', type: '待验证假设' }),
  ])

  assert.notEqual(first.id, second.id)
  const ids = harness.engine.state.findings.map((finding) => finding.id)
  assert.deepEqual(ids.sort(), [first.id, second.id].sort())
  assert.equal(first.authorWorkId, 'W-0001')
  assert.equal(second.authorWorkId, 'W-0002')

  const markdown = await readFile(harness.paths.findingsFile, 'utf8')
  assert.match(markdown, new RegExp(first.id))
  assert.match(markdown, /第一条并发发现/)
  assert.match(markdown, new RegExp(second.id))
  assert.match(markdown, /第二条并发发现/)

  // IDs, authors and timestamps come from the runtime, not from the caller.
  for (const finding of harness.engine.state.findings) {
    assert.match(finding.id, /^F-\d{4}$/)
    assert.match(finding.authorWorkId, /^W-\d{4}$/)
    assert.match(finding.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  }
})

test('更正关系在按 ID 读取和查询中保留，默认只返回当前结论', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const original = await harness.engine.appendFinding('W-0001', {
    text: '初步判断目标使用默认口令',
    type: '待验证假设',
  })
  const correction = await harness.engine.appendFinding('W-0001', {
    text: '复核后发现默认口令不可用，原判断不成立',
    type: '更正',
    supersedes: [original.id],
  })

  const lookedUp = await harness.engine.getFinding('W-0001', original.id)
  assert.equal(lookedUp.current, false)
  assert.deepEqual(lookedUp.supersededBy, [correction.id])
  assert.match(lookedUp.text, new RegExp(correction.id))
  assert.doesNotMatch(lookedUp.text, /初步判断目标使用默认口令/, '旧正文默认不展开')
  assert.match(lookedUp.text, /复核后发现默认口令不可用/)

  const historic = await harness.engine.getFinding('W-0001', original.id, { history: true })
  assert.equal(historic.current, false)
  assert.match(historic.text, /初步判断目标使用默认口令/)
  assert.match(historic.text, /复核后发现默认口令不可用/)
  assert.deepEqual(historic.currentIds, [correction.id])

  const queried = await harness.engine.queryShared('W-0001', { scope: 'findings', text: '默认口令' })
  assert.equal(queried.records.length, 1, '默认视图排除被替代记录')
  assert.match(queried.text, new RegExp(correction.id))
  assert.doesNotMatch(queried.text, /初步判断目标使用默认口令/)

  const history = await harness.engine.queryShared('W-0001', {
    scope: 'findings',
    text: '默认口令',
    view: 'history',
  })
  assert.equal(history.records.length, 2)
  assert.match(history.text, new RegExp(original.id))
  assert.match(history.text, new RegExp(correction.id))
})

test('work 方向变化更新表格行且转义 Markdown', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const before = harness.engine.state.sharedStateVersion
  await harness.engine.updateWork('W-0001', {
    direction: '扫描 a|b\n第二行',
    self_status: 'working',
  })
  assert.ok(harness.engine.state.sharedStateVersion > before)

  const markdown = await readFile(harness.paths.worksFile, 'utf8')
  assert.match(markdown, /a\\\|b/)
  assert.match(markdown, /a\\\|b \/ 第二行/)

  const works = await harness.engine.queryShared('W-0001', { scope: 'works', author: 'W-0001' })
  assert.equal(works.records.length, 1)
  assert.match(works.text, /扫描 a\|b\n第二行/)
})

test('引用不存在的发现会被拒绝', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  await assert.rejects(
    harness.engine.appendFinding('W-0001', { text: '引用错误', refs: ['F-9999'] }),
    /FINDING_NOT_FOUND|不存在/,
  )
})

test('发现正文与证据路径原样保留', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  await harness.engine.appendFinding('W-0001', {
    text: '观察到响应头缺少安全策略。\n\n第二段内容。',
    type: '已验证事实',
    evidence: ['evidence/headers.txt'],
  })
  const wait = waitUntil(() => harness.engine.state.findings.length === 1)
  await wait
  const finding = harness.engine.state.findings[0]
  assert.ok(finding)
  assert.deepEqual(finding.evidence, ['evidence/headers.txt'])
  assert.match(finding.text, /第二段内容/)
})
