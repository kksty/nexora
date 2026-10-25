import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Engine } from '../src/core/engine.ts'
import { nullLogger } from '../src/util/log.ts'
import { createHarness, waitUntil } from './support/harness.ts'
import { FakeDriver } from './support/fake-driver.ts'

test('停止失败不能把终止清理标记为完成', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  const originalStop = harness.driver.stopAll.bind(harness.driver)
  harness.driver.stopAll = async () => { throw new Error('injected stop failure') }
  await harness.engine.stopTask('test stop')
  await harness.engine.close()
  assert.equal(harness.engine.state.runs[0].cleanup, 'pending')
  await originalStop()
})

test('模型请求失败：记录 retrying、退避重试，且不判定任务完成', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  harness.driver.failNextPrompt(new Error('模拟限流：retry after 0.05s'))

  await harness.engine.start()
  await waitUntil(
    () => harness.engine.state.works['W-0001']?.runtimeStatus === 'retrying',
    2_000,
    '进入 retrying',
  )
  const work = harness.engine.state.works['W-0001']
  assert.ok(work)
  assert.equal(work.lastError?.attempts, 1)
  assert.match(work.lastError?.message ?? '', /限流/)
  assert.ok(work.lastError?.nextRetryAt)
  assert.equal(harness.engine.state.status, 'active')
  assert.equal(harness.engine.state.completion, null)

  await waitUntil(
    () => harness.engine.state.works['W-0001']?.runtimeStatus === 'idle',
    3_000,
    '重试后恢复空闲',
  )
  const prompts = harness.driver.promptsFor('W-0001')
  assert.equal(prompts.length, 1, '失败的请求不会被重复写入会话；恢复后重新提交启动提示')
  assert.match(prompts[0] ?? '', /起始信息：目标站点为 example\.test/)
  assert.equal(harness.engine.state.works['W-0001']?.lastError, undefined)
})

test('连续失败时重试次数递增并持续可见，不会静默结束', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  harness.driver.failNextPrompt(new Error('第一次失败'))
  harness.driver.failNextPrompt(new Error('第二次失败'))

  await harness.engine.start()
  await waitUntil(
    () => harness.engine.state.works['W-0001']?.lastError?.attempts === 2,
    3_000,
    '第二次失败后 attempts=2',
  )
  assert.equal(harness.engine.state.status, 'active')
  await waitUntil(
    () => harness.engine.state.works['W-0001']?.runtimeStatus === 'idle',
    4_000,
    '最终恢复',
  )
  assert.equal(harness.driver.promptsFor('W-0001').length, 1)
})

test('harness 启动失败同样进入重试，而不是把 work 移除', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  harness.driver.failNextEnsure(new Error('模拟无法连接模型服务'))

  await harness.engine.start()
  await waitUntil(
    () => harness.engine.state.works['W-0001']?.runtimeStatus === 'retrying',
    2_000,
    '进入 retrying',
  )
  assert.equal(harness.engine.state.status, 'active')
  assert.equal(Object.keys(harness.engine.state.works).length, 1)

  await waitUntil(
    () => harness.engine.state.works['W-0001']?.runtimeStatus === 'idle',
    3_000,
    '恢复后空闲',
  )
  assert.equal(harness.driver.ensures.length, 1)
  assert.equal(harness.engine.state.works['W-0001']?.sessionStarted, true)
})

test('harness 进程意外退出后恢复会话并继续', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  harness.driver.onUnexpectedExit?.('W-0001', '模拟进程崩溃')
  await waitUntil(
    () => harness.engine.state.works['W-0001']?.runtimeStatus === 'retrying',
    2_000,
    '崩溃后进入 retrying',
  )
  await waitUntil(
    () => harness.engine.state.works['W-0001']?.runtimeStatus === 'idle',
    3_000,
    '崩溃后恢复',
  )
  const prompts = harness.driver.promptsFor('W-0001')
  assert.ok(prompts.some((prompt) => prompt.includes('请求失败后的恢复')))
})

test('重启后恢复参与 work、会话与共享状态，并修复缺失的 findings.md 记录', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.spawnWork('W-0001', { reason: '并行', start_prompt: '继续' })
  await harness.engine.whenQuiet()
  const finding = await harness.engine.appendFinding('W-0001', { text: '重启后仍需保留的发现' })
  await harness.engine.sendMessage('W-0001', { to: 'W-0002', body: '重启前发送的消息' })
  await harness.engine.whenQuiet()

  // Simulate a crash between the state commit and the Markdown append.
  const original = await (await import('node:fs/promises')).readFile(harness.paths.findingsFile, 'utf8')
  const headerEnd = original.indexOf('## ')
  assert.ok(headerEnd > 0)
  await writeFile(harness.paths.findingsFile, original.slice(0, headerEnd), 'utf8')

  await harness.engine.close('simulated-crash')
  assert.equal(harness.engine.state.status, 'active')
  assert.ok(harness.engine.state.interruptedAt)

  const driver = new FakeDriver()
  const engine = await Engine.open({
    paths: harness.paths,
    driver,
    logger: nullLogger,
    retry: { initialMs: 20, factor: 2, maxMs: 100, jitter: 0 },
  })
  t.after(() => engine.close('test-cleanup'))
  await engine.start()
  assert.equal(await engine.whenQuiet(), true)

  const active = Object.values(engine.state.works).filter(
    (work) => work.runtimeStatus !== 'exited' && work.runtimeStatus !== 'finished',
  )
  assert.deepEqual(active.map((work) => work.id).sort(), ['W-0001', 'W-0002'])
  assert.equal(engine.state.findings.length, 1)
  assert.equal(engine.state.findings[0]?.id, finding.id)
  assert.equal(engine.state.interruptedAt, undefined)

  const repaired = await (await import('node:fs/promises')).readFile(harness.paths.findingsFile, 'utf8')
  assert.match(repaired, new RegExp(finding.id))
  assert.match(repaired, /重启后仍需保留的发现/)

  assert.ok(driver.ensures.length >= 2, '每个参与 work 都重新建立 harness 会话')
  for (const workId of ['W-0001', 'W-0002']) {
    const prompts = driver.promptsFor(workId)
    assert.ok(prompts.some((prompt) => prompt.includes('请求失败后的恢复')), `${workId} 收到恢复提示`)
  }
  const worksMarkdown = await (await import('node:fs/promises')).readFile(harness.paths.worksFile, 'utf8')
  assert.match(worksMarkdown, /W-0001/)
  assert.match(worksMarkdown, /W-0002/)
})

test('已完成的任务重启后不会被重新拉起', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '完成' })
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '同意',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '完成')
  await harness.engine.close('after-completion')

  const driver = new FakeDriver()
  const engine = await Engine.open({ paths: harness.paths, driver, logger: nullLogger })
  t.after(() => engine.close('test-cleanup'))
  await engine.start()
  assert.equal(engine.state.status, 'completed')
  assert.equal(driver.ensures.length, 0)
  assert.equal(driver.prompts.length, 0)
})

test('会话缺失时回退到全新会话，并把历史不可用告知执行者', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const driver = new FakeDriver()
  driver.ensure = async (spec) => {
    driver.ensures.push({ workId: spec.workId, sessionStarted: spec.sessionStarted })
    return { resumed: false, freshFallback: spec.sessionStarted, generation: driver.generation }
  }
  const engine = await Engine.open({ paths: harness.paths, driver, logger: nullLogger })
  t.after(() => engine.close('test-cleanup'))
  await harness.engine.close('handover')
  await engine.start()
  assert.equal(await engine.whenQuiet(), true)
  assert.equal(engine.state.works['W-0001']?.recoveredFresh, true)
  const prompts = driver.promptsFor('W-0001')
  assert.ok(prompts.some((prompt) => prompt.includes('会话恢复')))
  assert.ok(prompts.some((prompt) => prompt.includes('新的空会话')))
})
