import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createHarness, waitUntil, type TestHarness } from './support/harness.ts'

async function twoWorks(): Promise<TestHarness> {
  const harness = await createHarness()
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.spawnWork('W-0001', { reason: '并行验证', start_prompt: '继续探索' })
  await harness.engine.whenQuiet()
  return harness
}

test('全体参与 work 明确同意后才完成任务并保存共识记录', async (t) => {
  const harness = await twoWorks()
  t.after(() => harness.cleanup())
  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '认为终点已达成' })
  await harness.engine.whenQuiet()
  assert.equal(proposal.round.participants.length, 2)
  assert.equal(harness.engine.state.status, 'active')

  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '已获得管理员权限并有证据',
  })
  assert.equal(harness.engine.state.status, 'active', '单个 work 的同意不能结束任务')

  await harness.engine.respondCompletion('W-0002', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '复核证据后确认终点已达成',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '任务完成')

  const completion = harness.engine.state.completion
  assert.ok(completion)
  assert.equal(completion.roundId, proposal.round.id)
  assert.deepEqual([...completion.participants].sort(), ['W-0001', 'W-0002'])
  assert.equal(completion.opinions['W-0002']?.opinion, 'agree')
  assert.match(completion.opinions['W-0002']?.reason ?? '', /复核证据/)

  const recordFile = join(harness.paths.consensusDir, `${proposal.round.id}.json`)
  const record = JSON.parse(await readFile(recordFile, 'utf8')) as {
    roundId: string
    targetVersion: number
    participants: string[]
    opinions: Record<string, { opinion: string }>
  }
  assert.equal(record.roundId, proposal.round.id)
  assert.equal(record.targetVersion, 1)
  assert.deepEqual([...record.participants].sort(), ['W-0001', 'W-0002'])
  assert.equal(record.opinions['W-0001']?.opinion, 'agree')

  const consensusMarkdown = await readFile(join(harness.paths.consensusDir, 'consensus.md'), 'utf8')
  assert.match(consensusMarkdown, new RegExp(proposal.round.id))

  for (const work of Object.values(harness.engine.state.works)) {
    assert.equal(work.runtimeStatus, 'finished')
  }
  assert.equal(harness.engine.state.currentRoundId, null)
  await waitUntil(() => harness.driver.stops.length >= 2, 2_000, '结束后停止 harness 进程')
})

test('部分同意、部分反对、部分未回复时任务保持未完成', async (t) => {
  const harness = await twoWorks()
  t.after(() => harness.cleanup())
  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '尝试结束' })
  await harness.engine.whenQuiet()

  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '同意',
  })
  await harness.engine.respondCompletion('W-0002', {
    round_id: proposal.round.id,
    opinion: 'disagree',
    reason: '证据不足',
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(harness.engine.state.status, 'active')

  const status = await harness.engine.completionStatus('W-0001')
  assert.ok(status.blockers.some((blocker) => blocker.includes('尚未明确同意')))

  // Changing one's mind is allowed and can complete the round.
  await harness.engine.respondCompletion('W-0002', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '补充证据后同意',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '改为同意后完成')
})

test('共识后出现新发现，旧轮次失效并在新状态上重新征询', async (t) => {
  const harness = await twoWorks()
  t.after(() => harness.cleanup())
  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '准备结束' })
  await harness.engine.whenQuiet()
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '同意',
  })

  await harness.engine.appendFinding('W-0002', { text: '发现了一个未验证的入口', type: '待验证假设' })
  await harness.engine.whenQuiet()

  const oldRound = harness.engine.state.rounds.find((round) => round.id === proposal.round.id)
  assert.equal(oldRound?.status, 'invalidated')
  assert.match(oldRound?.invalidatedReason ?? '', /追加发现/)
  const reopened = harness.engine.state.rounds.find(
    (round) => round.id === harness.engine.state.currentRoundId,
  )
  assert.ok(reopened)
  assert.notEqual(reopened.id, proposal.round.id)
  assert.deepEqual(reopened.opinions, {})
  assert.equal(harness.engine.state.status, 'active')

  await assert.rejects(
    harness.engine.respondCompletion('W-0002', {
      round_id: proposal.round.id,
      opinion: 'agree',
      reason: '对旧轮次表态',
    }),
    (error: unknown) => (error as { code?: string }).code === 'ROUND_NOT_CURRENT',
  )

  // The new round was announced to every participant.
  assert.ok(harness.driver.promptsFor('W-0001').some((prompt) => prompt.includes(reopened.id)))
  assert.ok(harness.driver.promptsFor('W-0002').some((prompt) => prompt.includes(reopened.id)))

  await harness.engine.respondCompletion('W-0001', {
    round_id: reopened.id,
    opinion: 'agree',
    reason: '查看新发现后仍同意',
  })
  await harness.engine.respondCompletion('W-0002', {
    round_id: reopened.id,
    opinion: 'agree',
    reason: '同意',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '新轮次完成')
})

test('用户修改终点信息后旧同意失效，并按新目标版本完成', async (t) => {
  const harness = await twoWorks()
  t.after(() => harness.cleanup())
  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '准备结束' })
  await harness.engine.whenQuiet()
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '同意旧终点',
  })

  const changed = await harness.engine.setEndInformation('新的终点：还需要取得数据库读写权限。')
  assert.equal(changed.targetVersion, 2)
  assert.equal(harness.engine.state.targetVersion, 2)
  const oldRound = harness.engine.state.rounds.find((round) => round.id === proposal.round.id)
  assert.equal(oldRound?.status, 'invalidated')
  assert.match(oldRound?.invalidatedReason ?? '', /终点信息/)

  const current = harness.engine.state.rounds.find((round) => round.id === harness.engine.state.currentRoundId)
  assert.ok(current)
  assert.equal(current.targetVersion, 2)
  assert.deepEqual(current.opinions, {})

  await harness.engine.whenQuiet()
  await harness.engine.respondCompletion('W-0001', {
    round_id: current.id,
    opinion: 'agree',
    reason: '已按新终点补充证据',
  })
  await harness.engine.respondCompletion('W-0002', {
    round_id: current.id,
    opinion: 'agree',
    reason: '同意',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '新目标版本完成')

  const record = JSON.parse(
    await readFile(join(harness.paths.consensusDir, `${current.id}.json`), 'utf8'),
  ) as { targetVersion: number; endInformation: string }
  assert.equal(record.targetVersion, 2)
  assert.match(record.endInformation, /数据库读写权限/)
})

test('撤回同意使轮次失效并要求全体重新判断', async (t) => {
  const harness = await twoWorks()
  t.after(() => harness.cleanup())
  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '准备结束' })
  await harness.engine.whenQuiet()
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '同意',
  })

  const withdrawn = await harness.engine.withdrawCompletion('W-0001', {
    round_id: proposal.round.id,
    reason: '重新检查发现证据不足',
  })
  assert.ok(withdrawn.newRound)
  assert.notEqual(withdrawn.newRound.id, proposal.round.id)
  const oldRound = harness.engine.state.rounds.find((round) => round.id === proposal.round.id)
  assert.equal(oldRound?.status, 'invalidated')
  assert.equal(harness.engine.state.status, 'active')

  await harness.engine.respondCompletion('W-0001', {
    round_id: withdrawn.newRound.id,
    opinion: 'agree',
    reason: '重新检查后仍同意',
  })
  await harness.engine.respondCompletion('W-0002', {
    round_id: withdrawn.newRound.id,
    opinion: 'agree',
    reason: '同意',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '重新表态后完成')
})

test('参与 work 全部退出且未达成共识时，空集合不会误判完成', async (t) => {
  const harness = await twoWorks()
  t.after(() => harness.cleanup())
  await harness.engine.retireWork('W-0001', { reason: '方向无人承接，先退出' })
  await harness.engine.retireWork('W-0002', { reason: '退出' })
  await harness.engine.whenQuiet()

  assert.equal(harness.engine.state.status, 'active')
  assert.equal(harness.engine.state.completion, null)
  const status = await harness.engine.completionStatus('W-0001').catch((error: unknown) => error)
  assert.ok(status instanceof Error, '已退出的 work 不能查询共识')

  const admin = await harness.engine.adminSnapshot()
  assert.equal(admin.participants.length, 0)
  assert.ok(admin.blockers.some((blocker) => blocker.includes('没有参与任务的 work')))

  await assert.rejects(
    harness.engine.proposeCompletion('W-0002', { reason: '空集合' }),
    (error: unknown) => (error as { code?: string }).code === 'WORK_EXITED',
  )

  const stopped = await harness.engine.stopTask('人工确认无后续工作')
  assert.match(stopped.text, /已停止/)
  assert.equal(harness.engine.state.status, 'stopped')
  assert.notEqual(harness.engine.state.status, 'completed')
  assert.equal(harness.engine.state.completion, null)
})

test('单个参与 work 可以在明确同意后独立完成任务', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '终点已达成' })
  assert.deepEqual(proposal.round.participants, ['W-0001'])
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '已完成并留存证据',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '单 work 完成')
  assert.deepEqual(harness.engine.state.completion?.participants, ['W-0001'])
})

test('最后一张同意票之后进入等待，可以在等待中原子提交完成', async (t) => {
  const harness = await createHarness({ autoFinish: false })
  t.after(() => harness.cleanup())
  await harness.engine.start()

  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '已达成' })
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '同意',
  })
  // The work is still inside its turn, so the commit is deferred.
  assert.equal(harness.engine.state.works['W-0001']?.runtimeStatus, 'running')
  assert.equal(harness.engine.state.status, 'active')

  // Clear the delivered round notice so the wait blocks on events instead of
  // returning immediately with pending inbox content.
  await harness.engine.readInbox('W-0001', {})
  const startedAt = Date.now()
  const waited = await harness.engine.waitForEvents('W-0001', { timeout_seconds: 10 })
  assert.ok(Date.now() - startedAt < 2_000, '等待不应等到超时才结束')
  assert.equal(harness.engine.state.status, 'completed')
  assert.ok(waited.events.some((event) => event.kind === 'task-completed'))
})

test('任务完成后不能再写入或表态', async (t) => {
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

  await assert.rejects(
    harness.engine.appendFinding('W-0001', { text: '完成后的写入' }),
    (error: unknown) => ['TASK_NOT_ACTIVE', 'WORK_EXITED'].includes((error as { code?: string }).code ?? ''),
  )
  await assert.rejects(
    harness.engine.respondCompletion('W-0001', {
      round_id: proposal.round.id,
      opinion: 'agree',
      reason: '重复表态',
    }),
    (error: unknown) => ['TASK_NOT_ACTIVE', 'WORK_EXITED'].includes((error as { code?: string }).code ?? ''),
  )
})

test('未回复不等于同意', async (t) => {
  const harness = await twoWorks()
  t.after(() => harness.cleanup())
  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '尝试结束' })
  await harness.engine.whenQuiet()
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '同意',
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(harness.engine.state.status, 'active')
  const status = await harness.engine.completionStatus('W-0001')
  assert.deepEqual(status.missingVotes, ['W-0002'])
})
