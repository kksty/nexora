import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { Engine } from '../src/core/engine.ts'
import { nullLogger } from '../src/util/log.ts'
import { createHarness, waitUntil, type TestHarness } from './support/harness.ts'
import { FakeDriver } from './support/fake-driver.ts'

/** Complete the task with its current participants. */
async function completeTask(harness: TestHarness): Promise<string> {
  const snapshot = await harness.engine.adminSnapshot()
  const proposal = await harness.engine.proposeCompletion(snapshot.participants[0]!, { reason: '测试完成' })
  for (const workId of proposal.round.participants) {
    await harness.engine.respondCompletion(workId, { round_id: proposal.round.id, opinion: 'agree' })
  }
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '任务完成')
  return proposal.round.id
}

/** Re-open the task with a fresh driver after the previous runtime closed. */
async function reopen(harness: TestHarness): Promise<{ engine: Engine; driver: FakeDriver }> {
  const driver = new FakeDriver()
  const engine = await Engine.open({
    paths: harness.paths,
    driver,
    logger: nullLogger,
    retry: { initialMs: 20, factor: 2, maxMs: 100, jitter: 0 },
  })
  return { engine, driver }
}

/**
 * Simulate the steering plugin: claim each saved human command, record the
 * harness receipt, and emit the `user/message` event that proves the command
 * entered the model context. Without this a saved command correctly blocks
 * completion.
 */
async function deliverCommands(engine: Engine, driver: FakeDriver, workId: string): Promise<void> {
  for (;;) {
    const { commands } = await engine.claimCommands(workId)
    if (commands.length === 0) return
    for (const command of commands) {
      const messageId = `fake-cmd-${command.id}`
      await engine.ackCommand(workId, { commandId: command.id, token: command.token, messageId })
      driver.emitUserMessage(workId, { messageId })
      await waitUntil(
        () =>
          engine.state.commands.find((item) => item.id === command.id)?.deliveries[workId]?.status ===
          'entered-context',
        2_000,
        `命令 ${command.id} 进入上下文`,
      )
    }
  }
}

test('完成后继续：同一任务、新轮次、新 work、空表态，旧完成记录与发现保留', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const finding = await harness.engine.appendFinding('W-0001', { text: '跨轮次保留的共享发现' })
  await completeTask(harness)
  const firstCompletion = harness.engine.state.completion
  assert.ok(firstCompletion)
  await harness.engine.close('completed')

  const second = await reopen(harness)
  t.after(() => second.engine.close('test-cleanup'))
  const result = await second.engine.continueTask({
    text: '基于已有发现继续验证第二条利用链。',
    requestId: 'continue-1',
    source: 'web',
    executionsStopped: true,
  })
  assert.equal(result.idempotent, false)
  assert.equal(result.run.id, 'R-0002')
  assert.equal(result.work.id, 'W-0002')
  const state = second.engine.state
  assert.equal(state.status, 'active')
  assert.equal(state.currentRunId, 'R-0002')
  assert.equal(state.runs.length, 2)
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(state.runs[0]?.completion?.roundId, firstCompletion.roundId)
  assert.equal(state.runs[0]?.cleanup, 'done')
  assert.equal(state.runs[1]?.status, 'active')
  assert.equal(state.runs[1]?.cleanup, 'none')
  assert.equal(state.completion, null, '新一轮不沿用旧完成记录')
  assert.equal(state.currentRoundId, null)
  assert.equal(state.findings[0]?.id, finding.id)
  assert.equal(state.works['W-0001']?.runtimeStatus, 'finished')
  assert.equal(state.works['W-0002']?.origin, 'continue')
  assert.equal(state.works['W-0002']?.runId, 'R-0002')
  assert.equal(state.commands.length, 1)
  assert.equal(state.commands[0]?.runId, 'R-0002')
  assert.equal(state.commands[0]?.text, '基于已有发现继续验证第二条利用链。')
  assert.equal(state.commands[0]?.deliveries['W-0002']?.status, 'saved')

  // continueTask boots the new work in-process; the prompt states that the new
  // run starts from an empty opinion set and that old works do not participate.
  assert.equal(await second.engine.whenQuiet(), true)
  const prompt = second.driver.lastPrompt('W-0002')
  assert.match(prompt, /新一轮继续/)
  assert.match(prompt, /R-0002/)
  assert.match(prompt, /第二条利用链/)
  assert.match(prompt, /不参与本轮共识/)
  await deliverCommands(second.engine, second.driver, 'W-0002')

  const snapshot = await second.engine.adminSnapshot()
  assert.deepEqual(snapshot.participants, ['W-0002'])
  const round = await second.engine.proposeCompletion('W-0002', { reason: '第二轮完成' })
  assert.deepEqual(round.round.participants, ['W-0002'])
  assert.deepEqual(Object.keys(round.round.opinions), [])
  await second.engine.respondCompletion('W-0002', { round_id: round.round.id, opinion: 'agree' })
  await waitUntil(() => second.engine.state.status === 'completed', 3_000, '第二轮完成')
  assert.equal(second.engine.state.runs.length, 2)
  assert.equal(second.engine.state.runs[1]?.completion?.roundId, round.round.id)
  assert.equal(second.engine.state.completion?.runId, 'R-0002')
  assert.equal(second.engine.state.completion?.roundId, round.round.id)
})

test('继续操作幂等：同一 request ID 返回原轮次，同 ID 不同正文冲突', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await completeTask(harness)
  await harness.engine.close('completed')

  const { engine } = await reopen(harness)
  t.after(() => engine.close('test-cleanup'))
  const first = await engine.continueTask({
    text: '继续处理报告',
    requestId: 'continue-idem',
    executionsStopped: true,
  })
  const again = await engine.continueTask({
    text: '继续处理报告',
    requestId: 'continue-idem',
    executionsStopped: true,
  })
  assert.equal(again.idempotent, true)
  assert.equal(again.run.id, first.run.id)
  assert.equal(again.work.id, first.work.id)
  assert.equal(again.command.id, first.command.id)
  assert.equal(engine.state.runs.length, 2)
  assert.equal(Object.keys(engine.state.works).length, 2)

  await assert.rejects(
    engine.continueTask({ text: '不同正文', requestId: 'continue-idem', executionsStopped: true }),
    (error: unknown) => (error as { code?: string }).code === 'REQUEST_CONFLICT',
  )

  // A second, distinct request while the task is active must not create a run.
  await assert.rejects(
    engine.continueTask({ text: '另一条', requestId: 'continue-2', executionsStopped: true }),
    (error: unknown) => (error as { code?: string }).code === 'TASK_ACTIVE',
  )
  assert.equal(engine.state.runs.length, 2)
})

test('已停止任务继续：旧轮次遗留活动不阻塞新一轮，旧终态不改写', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  harness.driver.emitJobRegistered('W-0001', { jobId: 'job-old', label: '旧轮次服务' })
  await waitUntil(
    () => Object.keys(harness.engine.state.works['W-0001']?.activity.jobs ?? {}).length === 1,
    2_000,
    '旧 job 已登记',
  )
  await harness.engine.stopTask('测试停止')
  assert.equal(harness.engine.state.status, 'stopped')
  const oldRun = harness.engine.state.runs[0]
  assert.equal(oldRun?.status, 'stopped')
  assert.equal(oldRun?.stopReason, '测试停止')
  await harness.engine.close('stopped')

  const { engine, driver } = await reopen(harness)
  t.after(() => engine.close('test-cleanup'))
  const result = await engine.continueTask({
    text: '继续未完成的方向',
    requestId: 'continue-stopped',
    executionsStopped: true,
  })
  assert.equal(result.run.id, 'R-0002')
  assert.equal(engine.state.runs[0]?.status, 'stopped')
  assert.equal(engine.state.runs[0]?.completion, null)
  assert.ok(engine.state.works['W-0001']?.activity.jobs['job-old'], '旧活动仅作历史保留')
  assert.equal(engine.state.runs[1]?.status, 'active')
  assert.equal(engine.state.runs[1]?.targetVersion, 1)

  await engine.whenQuiet()
  await deliverCommands(engine, driver, 'W-0002')
  const proposal = await engine.proposeCompletion('W-0002', { reason: '新一轮完成' })
  await engine.respondCompletion('W-0002', { round_id: proposal.round.id, opinion: 'agree' })
  await waitUntil(() => engine.state.status === 'completed', 3_000, '旧遗留活动不阻塞新一轮')
  assert.equal(engine.state.completion?.runId, 'R-0002')
})

test('旧轮次延迟事件不能修改新轮次的活动、投票或共享版本', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await completeTask(harness)
  await harness.engine.close('completed')

  const { engine, driver } = await reopen(harness)
  t.after(() => engine.close('test-cleanup'))
  await engine.continueTask({ text: '继续', requestId: 'continue-isolation', executionsStopped: true })
  await engine.whenQuiet()

  const oldWork = engine.state.works['W-0001']
  assert.ok(oldWork)
  const beforeVersion = engine.state.sharedStateVersion
  const beforeOldTools = Object.keys(oldWork.activity.tools).length
  // Deliver the event under the work's real session id/generation, so only the
  // run-scope check can keep the stale projection out of the new run.
  driver.onActivity?.('W-0001', [
    {
      kind: 'tool-call',
      sessionId: oldWork.sessionId,
      generation: oldWork.activity.generation,
      seq: 9_999,
      at: new Date().toISOString(),
      callId: 'old-call',
      name: 'bash',
      turn: 1,
      step: 1,
    },
  ])
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(engine.state.sharedStateVersion, beforeVersion)
  assert.equal(Object.keys(oldWork.activity.tools).length, beforeOldTools)
  assert.equal(engine.state.currentRoundId, null)
  assert.equal(engine.state.runs[0]?.status, 'completed')

  // The old work cannot act in the new run.
  await assert.rejects(
    engine.proposeCompletion('W-0001', { reason: '旧 work 不应参与' }),
    (error: unknown) => (error as { code?: string }).code === 'WORK_EXITED',
  )
  const round = await engine.proposeCompletion('W-0002', { reason: '新轮次' })
  assert.deepEqual(round.round.participants, ['W-0002'])
})

test('active 但没有参与 work 时人工恢复：同轮次创建承接 work，空集合不完成', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.retireWork('W-0001', { reason: '完成交接后退出' })
  assert.deepEqual(await harness.engine.adminSnapshot().then((s) => s.participants), [])
  assert.equal(harness.engine.state.status, 'active')
  assert.equal(harness.engine.state.completion, null)

  // No participants: the task must not complete despite an empty set.
  const snapshot = await harness.engine.adminSnapshot()
  assert.ok(snapshot.blockers.some((blocker) => blocker.includes('没有参与任务的 work')))

  const recovered = await harness.engine.recoverTask({ requestId: 'recover-1', source: 'web' })
  assert.equal(recovered.created, true)
  assert.equal(recovered.run.id, 'R-0001')
  assert.equal(recovered.work?.id, 'W-0002')
  assert.equal(recovered.work?.origin, 'recover')
  assert.equal(recovered.work?.runId, 'R-0001')
  const repeated = await harness.engine.recoverTask({ requestId: 'recover-1', source: 'web' })
  assert.equal(repeated.idempotent, true)
  assert.equal(repeated.work?.id, 'W-0002')
  assert.equal(Object.keys(harness.engine.state.works).length, 2)

  await harness.engine.whenQuiet()
  assert.match(harness.driver.lastPrompt('W-0002'), /人工恢复/)
  const proposal = await harness.engine.proposeCompletion('W-0002', { reason: '恢复后完成' })
  assert.deepEqual(proposal.round.participants, ['W-0002'])
  await harness.engine.respondCompletion('W-0002', { round_id: proposal.round.id, opinion: 'agree' })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '恢复后完成')
})

test('已有参与 work 时恢复不创建新 work', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const result = await harness.engine.recoverTask({ requestId: 'recover-existing', source: 'cli' })
  assert.equal(result.created, false)
  assert.deepEqual(result.participants, ['W-0001'])
  assert.equal(result.work, null)
  assert.equal(Object.keys(harness.engine.state.works).length, 1)
})

test('完成与继续在同一运行时中交错：旧清理定时器不会停止新 work', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await completeTask(harness)
  // Continue before the deferred stop timer from the first completion fires.
  const result = await harness.engine.continueTask({
    text: '同一进程内立即继续',
    requestId: 'continue-interleaved',
    executionsStopped: true,
  })
  assert.equal(result.run.id, 'R-0002')
  await harness.engine.whenQuiet()
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(harness.driver.stops.includes('W-0002'), false, '新 work 的会话没有被旧清理停掉')
  await deliverCommands(harness.engine, harness.driver, 'W-0002')
  const proposal = await harness.engine.proposeCompletion('W-0002', { reason: '交错后完成' })
  await harness.engine.respondCompletion('W-0002', { round_id: proposal.round.id, opinion: 'agree' })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '交错后的新轮次完成')
  assert.equal(harness.engine.state.completion?.runId, 'R-0002')
})

test('完成提交后重启只补清理，不重新建立会话或再次探索', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await completeTask(harness)
  await harness.engine.close('crash-after-completion')

  // Simulate a crash between the completion commit and the cleanup record by
  // rewriting the persisted run as still pending.
  const raw = JSON.parse(await readFile(harness.paths.stateFile, 'utf8')) as {
    runs: { cleanup: string; cleanupAt?: string; cleanupNote?: string }[]
  }
  raw.runs[0]!.cleanup = 'pending'
  delete raw.runs[0]!.cleanupAt
  delete raw.runs[0]!.cleanupNote
  await writeFile(harness.paths.stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

  const { engine, driver } = await reopen(harness)
  t.after(() => engine.close('test-cleanup'))
  await engine.start()
  assert.equal(engine.state.status, 'completed')
  assert.equal(driver.ensures.length, 0)
  assert.equal(driver.prompts.length, 0)
  assert.equal(engine.state.runs[0]?.cleanup, 'done')
  assert.equal(engine.state.status, 'completed')
})
