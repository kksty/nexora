import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createHarness, DEFAULT_END, DEFAULT_START } from './support/harness.ts'

test('首个执行者由起始/终点信息启动，并生成共享文档', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())

  await harness.engine.start()
  assert.equal(await harness.engine.whenQuiet(), true)

  const state = harness.engine.state
  assert.equal(state.status, 'active')
  assert.equal(Object.keys(state.works).length, 1)
  const work = state.works['W-0001']
  assert.ok(work)
  assert.equal(work.runtimeStatus, 'idle')
  assert.equal(work.sessionStarted, true)
  assert.equal(work.parentWorkId, null)

  const prompt = harness.driver.lastPrompt('W-0001')
  assert.match(prompt, /Nexora/)
  assert.match(prompt, /你与其他执行者地位相同|所有执行者地位相同/)
  assert.match(prompt, new RegExp(DEFAULT_START.slice(0, 12)))
  assert.match(prompt, /终点信息/)
  assert.match(prompt, /shared_read/)
  assert.match(prompt, /executor_spawn/)
  assert.match(prompt, /completion_respond/)
  assert.match(prompt, /没有 token、费用、步数或时间预算/)
  assert.match(prompt, new RegExp(harness.paths.taskDir.replace(/\\/g, '\\\\')))

  const task = await readFile(harness.paths.taskFile, 'utf8')
  assert.match(task, /目标版本：v1/)
  assert.match(task, /起始信息/)
  assert.match(task, new RegExp(DEFAULT_END.slice(0, 10)))

  const works = await readFile(harness.paths.worksFile, 'utf8')
  assert.match(works, /W-0001/)
  assert.match(works, /idle/)

  const findings = await readFile(harness.paths.findingsFile, 'utf8')
  assert.match(findings, /共享发现/)
})

test('重复调用 start 不会再次创建首个执行者', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())

  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.start()
  await harness.engine.whenQuiet()

  assert.equal(Object.keys(harness.engine.state.works).length, 1)
  assert.equal(harness.engine.state.status, 'active')
})
