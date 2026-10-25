import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  activityBlockers,
  applyActivityEvent,
  emptyActivity,
  markActivityUnknown,
  reconcileActivity,
} from '../src/core/activity.ts'
import { Engine } from '../src/core/engine.ts'
import { nullLogger } from '../src/util/log.ts'
import type { ActivityEvent } from '../src/types.ts'
import { createHarness, waitUntil, type TestHarness } from './support/harness.ts'
import { FakeDriver } from './support/fake-driver.ts'

function event<T extends ActivityEvent['kind']>(
  base: { sessionId: string; generation: number; seq: number; at: string },
  kind: T,
  rest: Record<string, unknown>,
): ActivityEvent {
  return { kind, ...base, ...rest } as ActivityEvent
}

const base = { sessionId: 's-1', generation: 1, seq: 1, at: '2026-10-22T10:00:00+08:00' }

test('活动投影：前台任务结算由创建它的工具收取，不产生待接收通知', () => {
  const activity = emptyActivity(1)
  const call = event(base, 'tool-call', {
    callId: 'call-1',
    name: 'bash',
    arguments: '{"command":"id"}',
    turn: 1,
    step: 1,
  })
  const started = applyActivityEvent(activity, call)
  assert.equal(started.invalidateReason !== undefined, true, '真实执行工具启动应使旧共识失效')
  assert.equal(activityBlockers({ id: 'W-0001', activity } as never).length, 1)

  applyActivityEvent(activity, event({ ...base, seq: 2 }, 'job-registered', {
    jobId: 'bash-1',
    jobKind: 'bash',
    label: 'id',
    ownerSessionId: 's-1',
    startedAt: base.at,
    toolCallId: 'call-1',
    rootToolCallId: 'call-1',
  }))
  applyActivityEvent(activity, event({ ...base, seq: 3 }, 'job-settled', {
    jobId: 'bash-1',
    jobKind: 'bash',
    label: 'id',
    ownerSessionId: 's-1',
    startedAt: base.at,
    toolCallId: 'call-1',
    rootToolCallId: 'call-1',
    status: 'completed',
    cause: 'producer',
    producerReported: true,
    finishedAt: base.at,
  }))
  assert.equal(activity.jobs['bash-1']?.notice, 'none', '前台工具仍在等待结果，不需要额外通知')

  applyActivityEvent(activity, event({ ...base, seq: 4 }, 'tool-result', {
    callId: 'call-1',
    isError: false,
  }))
  assert.deepEqual(activityBlockers({ id: 'W-0001', activity } as never), [])
})

test('活动投影：后台任务结算需要通知模型，通知到达后才解除阻塞', () => {
  const activity = emptyActivity(1)
  applyActivityEvent(activity, event(base, 'tool-call', {
    callId: 'call-2',
    name: 'bash',
    arguments: '{"command":"sleep 60","run_in_background":true}',
    turn: 1,
    step: 1,
  }))
  applyActivityEvent(activity, event({ ...base, seq: 2 }, 'tool-result', {
    callId: 'call-2',
    isError: false,
  }))
  applyActivityEvent(activity, event({ ...base, seq: 3 }, 'job-registered', {
    jobId: 'bash-2',
    jobKind: 'bash',
    label: 'sleep 60',
    ownerSessionId: 's-1',
    startedAt: base.at,
    toolCallId: 'call-2',
    rootToolCallId: 'call-2',
  }))
  applyActivityEvent(activity, event({ ...base, seq: 4 }, 'job-settled', {
    jobId: 'bash-2',
    jobKind: 'bash',
    label: 'sleep 60',
    ownerSessionId: 's-1',
    startedAt: base.at,
    toolCallId: 'call-2',
    rootToolCallId: 'call-2',
    status: 'completed',
    cause: 'producer',
    producerReported: true,
    finishedAt: base.at,
  }))
  assert.equal(activity.jobs['bash-2']?.notice, 'pending')
  const blockers = activityBlockers({ id: 'W-0001', activity } as never)
  assert.ok(blockers.some((item) => item.includes('尚未进入模型上下文')))

  const delivered = applyActivityEvent(activity, event({ ...base, seq: 5 }, 'user-message', {
    messageId: 'notice-1',
    sourceKind: 'tool-jobs',
    form: 'notice',
    text: 'background job bash-2 finished (bash: sleep 60) completed. Read its output with job_output.',
  }))
  assert.equal(delivered.deliveredNotices.includes('bash-2'), true)
  assert.ok(delivered.invalidateReason)
  assert.equal(activity.jobs['bash-2']?.notice, 'delivered')
  assert.deepEqual(activityBlockers({ id: 'W-0001', activity } as never), [])
})

test('活动投影：结算通知按完整 job ID 匹配，不被互为前缀的其他 job 误消除', () => {
  const activity = emptyActivity(1)
  const register = (seq: number, jobId: string): void => {
    applyActivityEvent(activity, event({ ...base, seq }, 'job-registered', {
      jobId,
      jobKind: 'bash',
      label: jobId,
      ownerSessionId: 's-1',
      startedAt: base.at,
    }))
  }
  const settle = (seq: number, jobId: string): void => {
    applyActivityEvent(activity, event({ ...base, seq }, 'job-settled', {
      jobId,
      jobKind: 'bash',
      label: jobId,
      ownerSessionId: 's-1',
      startedAt: base.at,
      status: 'completed',
      cause: 'producer',
      producerReported: true,
      finishedAt: base.at,
    }))
  }
  register(1, 'bash-1')
  settle(2, 'bash-1')
  register(3, 'bash-10')
  settle(4, 'bash-10')
  assert.equal(activity.jobs['bash-1']?.notice, 'pending')
  assert.equal(activity.jobs['bash-10']?.notice, 'pending')

  const delivered = applyActivityEvent(activity, event({ ...base, seq: 5 }, 'user-message', {
    messageId: 'notice-10',
    sourceKind: 'tool-jobs',
    form: 'notice',
    text: 'background job bash-10 finished (bash: bash-10) completed.',
  }))
  assert.deepEqual(delivered.deliveredNotices, ['bash-10'])
  assert.equal(activity.jobs['bash-10']?.notice, 'delivered')
  assert.equal(activity.jobs['bash-1']?.notice, 'pending', 'bash-1 的结果并未进入模型上下文')
  assert.ok(
    activityBlockers({ id: 'W-0001', activity } as never).some((item) => item.includes('bash-1')),
  )
})

test('活动投影：job_output wait 收取结算结果时不重复要求通知', () => {
  const activity = emptyActivity(1)
  applyActivityEvent(activity, event(base, 'tool-call', {
    callId: 'call-3',
    name: 'bash',
    arguments: '{"command":"sleep 5","run_in_background":true}',
    turn: 1,
    step: 1,
  }))
  applyActivityEvent(activity, event({ ...base, seq: 2 }, 'tool-result', {
    callId: 'call-3',
    isError: false,
  }))
  applyActivityEvent(activity, event({ ...base, seq: 3 }, 'job-registered', {
    jobId: 'bash-3',
    jobKind: 'bash',
    label: 'sleep 5',
    ownerSessionId: 's-1',
    startedAt: base.at,
    toolCallId: 'call-3',
  }))
  applyActivityEvent(activity, event({ ...base, seq: 4 }, 'tool-call', {
    callId: 'call-4',
    name: 'job_output',
    arguments: '{"job_id":"bash-3","wait":true}',
    turn: 1,
    step: 2,
  }))
  applyActivityEvent(activity, event({ ...base, seq: 5 }, 'job-settled', {
    jobId: 'bash-3',
    jobKind: 'bash',
    label: 'sleep 5',
    ownerSessionId: 's-1',
    startedAt: base.at,
    toolCallId: 'call-3',
    status: 'completed',
    cause: 'producer',
    producerReported: true,
    finishedAt: base.at,
  }))
  assert.equal(activity.jobs['bash-3']?.notice, 'none')
  assert.deepEqual(
    activityBlockers({ id: 'W-0001', activity } as never),
    [],
    '等待中的 job_output 是协议等待，不应阻止完成',
  )
  applyActivityEvent(activity, event({ ...base, seq: 6 }, 'tool-result', {
    callId: 'call-4',
    isError: false,
  }))
  assert.deepEqual(activityBlockers({ id: 'W-0001', activity } as never), [])
})

test('活动投影：进程丢失后活动变为结果未知，核对后解除阻塞', () => {
  const activity = emptyActivity(1)
  applyActivityEvent(activity, event(base, 'tool-call', {
    callId: 'call-x',
    name: 'bash',
    arguments: '{"command":"curl"}',
    turn: 1,
    step: 1,
  }))
  applyActivityEvent(activity, event({ ...base, seq: 2 }, 'job-registered', {
    jobId: 'bash-x',
    jobKind: 'bash',
    label: 'curl',
    ownerSessionId: 's-1',
    startedAt: base.at,
    toolCallId: 'call-x',
  }))
  assert.ok(markActivityUnknown(activity))
  assert.equal(activity.tools['call-x']?.orphaned, true)
  assert.equal(activity.jobs['bash-x']?.status, 'unknown')
  const work = { id: 'W-0001', activity } as never
  assert.ok(activityBlockers(work).some((item) => item.includes('尚未核对')))
  const result = reconcileActivity(activity, ['call-x', 'bash-x'], 'checked externally')
  assert.deepEqual(result.resolved.sort(), ['bash-x', 'call-x'])
  assert.deepEqual(activityBlockers(work), [])
})

test('运行中打开真实工具时阻止完成，工具结果与静止后完成', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  harness.driver.emitToolCall('W-0001', { callId: 'call-live', name: 'bash', arguments: '{}' })
  harness.driver.emitStatus('W-0001', 'running')
  await harness.engine.whenQuiet()

  const proposal = await harness.engine.proposeCompletion('W-0001', {})
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(harness.engine.state.status, 'active')
  const status = await harness.engine.completionStatus('W-0001')
  assert.ok(status.blockers.some((item) => item.includes('仍有工具在执行')))

  harness.driver.emitToolResult('W-0001', 'call-live')
  harness.driver.emitStatus('W-0001', 'idle')
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '工具结束后完成')
  assert.equal(harness.engine.state.completion?.opinions['W-0001']?.opinion, 'agree')
})

test('executor_wait 的协议等待不会永久阻止完成', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  harness.driver.emitToolCall('W-0001', {
    callId: 'call-wait',
    name: 'mcp__liebian__executor_wait',
    arguments: '{"timeout_seconds":120}',
  })
  harness.driver.emitStatus('W-0001', 'running')
  await harness.engine.whenQuiet()

  const proposal = await harness.engine.proposeCompletion('W-0001', {})
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '等待中完成')
  assert.equal(harness.engine.state.works['W-0001']?.activity.tools['call-wait']?.name, 'mcp__liebian__executor_wait')
})

test('后台 job 运行和通知到达期间阻止完成，通知使旧轮次失效', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  harness.driver.emitToolCall('W-0001', {
    callId: 'call-bg',
    name: 'bash',
    arguments: '{"run_in_background":true}',
  })
  harness.driver.emitToolResult('W-0001', 'call-bg')
  harness.driver.emitJobRegistered('W-0001', { jobId: 'bash-bg', toolCallId: 'call-bg' })
  await harness.engine.whenQuiet()

  const proposal = await harness.engine.proposeCompletion('W-0001', {})
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(harness.engine.state.status, 'active')
  let status = await harness.engine.completionStatus('W-0001')
  assert.ok(status.blockers.some((item) => item.includes('后台任务仍在运行')))

  harness.driver.emitJobSettled('W-0001', { jobId: 'bash-bg', toolCallId: 'call-bg' })
  await harness.engine.whenQuiet()
  status = await harness.engine.completionStatus('W-0001')
  assert.ok(status.blockers.some((item) => item.includes('尚未进入模型上下文')))

  harness.driver.emitUserMessage('W-0001', {
    sourceKind: 'tool-jobs',
    form: 'notice',
    text: 'background job bash-bg finished (bash: bash-bg) completed. Read its output with job_output.',
  })
  await harness.engine.whenQuiet()

  const oldRound = harness.engine.state.rounds.find((round) => round.id === proposal.round.id)
  assert.equal(oldRound?.status, 'invalidated')
  const reopened = harness.engine.state.rounds.find((round) => round.id === harness.engine.state.currentRoundId)
  assert.ok(reopened)
  assert.notEqual(reopened.id, proposal.round.id)
  assert.deepEqual(reopened.opinions, {})

  await harness.engine.respondCompletion('W-0001', {
    round_id: reopened.id,
    opinion: 'agree',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '重新表态后完成')
})

test('完成理由可选，未填写理由也能完成并保存记录', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const proposal = await harness.engine.proposeCompletion('W-0001', {})
  assert.equal(proposal.round.reason, undefined)
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '无理由完成')
  assert.equal(harness.engine.state.completion?.opinions['W-0001']?.reason, undefined)
  const record = JSON.parse(
    await readFile(join(harness.paths.consensusDir, `${proposal.round.id}.json`), 'utf8'),
  ) as { opinions: Record<string, { opinion: string; reason?: string }> }
  assert.equal(record.opinions['W-0001']?.opinion, 'agree')
  assert.equal(record.opinions['W-0001']?.reason, undefined)
})

test('旧进程代次的事件不会污染当前活动', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const activityBefore = JSON.stringify(harness.engine.state.works['W-0001']?.activity)
  const current = harness.driver.generation
  harness.driver.generation = current + 1
  harness.driver.emitToolCall('W-0001', { callId: 'call-stale', name: 'bash', arguments: '{}' })
  await harness.engine.whenQuiet()
  assert.equal(JSON.stringify(harness.engine.state.works['W-0001']?.activity), activityBefore)
  harness.driver.generation = current
})

test('退出的 work 仍有遗留活动时，剩余 work 必须核对后才能完成', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.spawnWork('W-0001', { reason: '并行验证', start_prompt: '继续' })
  await harness.engine.whenQuiet()

  harness.driver.emitToolCall('W-0001', { callId: 'call-left', name: 'bash', arguments: '{}' })
  harness.driver.emitJobRegistered('W-0001', { jobId: 'bash-left', toolCallId: 'call-left' })
  await harness.engine.whenQuiet()
  await harness.engine.retireWork('W-0001', { reason: '交接后退出' })
  await harness.engine.whenQuiet()

  const proposal = await harness.engine.proposeCompletion('W-0002', {})
  await harness.engine.respondCompletion('W-0002', {
    round_id: proposal.round.id,
    opinion: 'agree',
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(harness.engine.state.status, 'active')
  let status = await harness.engine.completionStatus('W-0002')
  assert.ok(status.blockers.some((item) => item.includes('已退出 work 的遗留活动')))

  const reconciled = await harness.engine.reconcileWorkActivity('W-0002', {
    action_ids: ['call-left', 'bash-left'],
    note: '确认遗留命令已结束',
  })
  assert.deepEqual(reconciled.resolved.sort(), ['bash-left', 'call-left'])
  status = await harness.engine.completionStatus('W-0002')
  assert.equal(status.blockers.some((item) => item.includes('已退出 work 的遗留活动')), false)
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '遗留活动核对后完成')
})

test('恢复时读取持久会话事件，已提交的工具结果不再标为未知', async (t) => {
  const harness = await createHarness()
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const sessionId = harness.engine.state.works['W-0001']!.sessionId
  harness.driver.emitToolCall('W-0001', { callId: 'call-logged', name: 'bash', arguments: '{}' })
  await harness.engine.whenQuiet()
  const cursor = harness.engine.state.works['W-0001']!.activity.lastEventSeq
  await harness.engine.close('crash-simulation')

  const driver = new FakeDriver()
  driver.generation = 42
  driver.replay = [
    {
      kind: 'tool-result',
      sessionId,
      generation: 42,
      seq: cursor + 1,
      at: new Date().toISOString(),
      callId: 'call-logged',
      isError: false,
    },
  ]
  const engine = await Engine.open({ paths: harness.paths, driver, logger: nullLogger })
  t.after(async () => {
    await engine.close('test-cleanup')
    await rm(harness.root, { recursive: true, force: true })
  })
  await engine.start()
  assert.equal(await engine.whenQuiet(), true)
  assert.equal(engine.state.works['W-0001']?.activity.tools['call-logged'], undefined)
  const inspect = await engine.inspectSelf('W-0001')
  assert.doesNotMatch(inspect.text, /结果未知/)
})

test('重启把未结算活动标为未知，核对后可以完成', async (t) => {
  const harness = await createHarness()
  await harness.engine.start()
  await harness.engine.whenQuiet()
  harness.driver.emitToolCall('W-0001', { callId: 'call-crash', name: 'bash', arguments: '{}' })
  harness.driver.emitJobRegistered('W-0001', { jobId: 'bash-crash', toolCallId: 'call-crash' })
  await harness.engine.whenQuiet()
  await harness.engine.close('crash-simulation')

  const driver = new FakeDriver()
  driver.generation = 99
  const engine = await Engine.open({ paths: harness.paths, driver, logger: nullLogger })
  t.after(async () => {
    await engine.close('test-cleanup')
    await rm(harness.root, { recursive: true, force: true })
  })
  await engine.start()
  assert.equal(await engine.whenQuiet(), true)

  const recovered = engine.state.works['W-0001']
  assert.equal(recovered?.activity.generation, 99)
  assert.equal(recovered?.activity.tools['call-crash']?.orphaned, true)
  assert.equal(recovered?.activity.jobs['bash-crash']?.status, 'unknown')
  assert.ok(driver.promptsFor('W-0001').some((prompt) => prompt.includes('恢复后的活动核对')))

  const inspect = await engine.inspectSelf('W-0001')
  assert.match(inspect.text, /结果未知|待核对/)

  const proposal = await engine.proposeCompletion('W-0001', {})
  let status = await engine.completionStatus('W-0001')
  assert.ok(status.blockers.some((item) => item.includes('尚未核对')))

  const reconciled = await engine.reconcileWorkActivity('W-0001', {
    action_ids: ['call-crash', 'bash-crash'],
    note: '已在外部检查，命令没有留下未完成副作用',
  })
  assert.deepEqual(reconciled.resolved.sort(), ['bash-crash', 'call-crash'])

  status = await engine.completionStatus('W-0001')
  assert.equal(status.blockers.some((item) => item.includes('尚未核对')), false)
  await engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
  })
  await waitUntil(() => engine.state.status === 'completed', 3_000, '核对后完成')
})
