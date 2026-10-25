import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHarness } from './support/harness.ts'
import { Engine } from '../src/core/engine.ts'
import { FakeDriver } from './support/fake-driver.ts'
import { nullLogger } from '../src/util/log.ts'
import { dispatchWorkOp } from '../src/api/rpc.ts'

test('发现幂等：并发重试、冲突、作者隔离与重启后重放', async (t) => {
  const h = await createHarness()
  t.after(() => h.cleanup())
  await h.engine.start()
  await h.engine.spawnWork('W-0001', { reason: '并行', start_prompt: '检查' })
  await h.engine.whenQuiet()
  const input = { text: '发现正文', request_id: 'finding-1' }
  const results = await Promise.all(Array.from({ length: 5 }, () => dispatchWorkOp(h.engine, 'W-0001', 'findings.append', input)))
  results.forEach((result) => assert.deepEqual(result, results[0]))
  assert.equal(h.engine.state.findings.length, 1)
  const version = h.engine.state.sharedStateVersion
  await assert.rejects(h.engine.appendFinding('W-0001', { ...input, text: '不同正文' }), { code: 'REQUEST_CONFLICT' })
  assert.equal(h.engine.state.sharedStateVersion, version)
  await h.engine.appendFinding('W-0002', input)
  assert.equal(h.engine.state.findings.length, 2)
  await h.engine.close('restart')
  const engine = await Engine.open({ paths: h.paths, driver: new FakeDriver(), logger: nullLogger, dispatch: false })
  t.after(() => engine.close('test'))
  assert.deepEqual(await engine.appendFinding('W-0001', input), results[0])
  await engine.stopTask('完成测试')
  assert.deepEqual(await engine.appendFinding('W-0001', input), results[0])
  assert.equal(engine.state.findings.length, 2)
  const log = await readFile(h.paths.findingsFile, 'utf8')
  assert.equal((log.match(/^## F-0001 /gm) ?? []).length, 1)
})

test('消息幂等：部分失败结果固定，重复请求不投递，重启后仍可重放', async (t) => {
  const h = await createHarness()
  t.after(() => h.cleanup())
  await h.engine.start()
  await h.engine.spawnWork('W-0001', { reason: '协作', start_prompt: '继续' })
  await h.engine.whenQuiet()
  const input = { to: ['W-0002', 'W-missing'], body: '消息', request_id: 'send-1' }
  const [first, replay] = await Promise.all([h.engine.sendMessage('W-0001', input), h.engine.sendMessage('W-0001', input)])
  assert.deepEqual(replay, first)
  assert.equal(first.results.filter((r) => r.ok).length, 1)
  assert.equal(h.engine.state.messages.filter((m) => !m.system).length, 1)
  await assert.rejects(h.engine.sendMessage('W-0001', { ...input, to: 'W-0002' }), { code: 'REQUEST_CONFLICT' })
  await h.engine.whenQuiet()
  await h.engine.retireWork('W-0002', { reason: '退出' })
  assert.deepEqual(await h.engine.sendMessage('W-0001', input), first)
  await h.engine.close('restart')
  const engine = await Engine.open({ paths: h.paths, driver: new FakeDriver(), logger: nullLogger, dispatch: false })
  t.after(() => engine.close('test'))
  assert.deepEqual(await engine.sendMessage('W-0001', input), first)
  assert.equal(engine.state.messages.filter((m) => !m.system).length, 1)
})

test('消息全失败也保存幂等结果；省略 request_id 保持旧协议行为', async (t) => {
  const h = await createHarness()
  t.after(() => h.cleanup())
  await h.engine.start()
  await h.engine.whenQuiet()
  const input = { to: 'W-0002', body: '尚未存在', request_id: 'failed-1' }
  await assert.rejects(h.engine.sendMessage('W-0001', input), { code: 'MESSAGE_NOT_DELIVERED' })
  await h.engine.spawnWork('W-0001', { reason: '新建', start_prompt: '继续' })
  await assert.rejects(h.engine.sendMessage('W-0001', input), { code: 'MESSAGE_NOT_DELIVERED' })
  assert.equal(h.engine.state.messages.filter((m) => !m.system).length, 0)
  await h.engine.appendFinding('W-0001', { text: '相同正文' })
  await h.engine.appendFinding('W-0001', { text: '相同正文' })
  assert.equal(h.engine.state.findings.length, 2)
  await assert.rejects(h.engine.appendFinding('W-0001', { text: 'x', request_id: '' }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(dispatchWorkOp(h.engine, 'W-0001', 'peer.send', { ...input, request_id: 1 }), { code: 'INVALID_ARGUMENT' })
})
