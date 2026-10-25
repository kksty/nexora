import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { startApiServer, type ApiServer } from '../src/api/server.ts'
import { writeDaemonInfo } from '../src/core/daemon.ts'
import { Engine } from '../src/core/engine.ts'
import { nullLogger } from '../src/util/log.ts'
import type { CommandRecord } from '../src/types.ts'
import { FakeDriver } from './support/fake-driver.ts'
import { createHarness, waitUntil, type TestHarness } from './support/harness.ts'

/** Simulate the steering plugin's claim → steer ack → context-entry report. */
async function steer(
  harness: TestHarness,
  workId: string,
  commandId: string,
  messageId: string,
): Promise<void> {
  const claim = await harness.engine.claimCommands(workId, {})
  const item = claim.commands.find((command) => command.id === commandId)
  assert.ok(item, '命令应可被 claim')
  await harness.engine.ackCommand(workId, { commandId, token: item.token, messageId })
  harness.driver.emitUserMessage(workId, { messageId })
  await waitUntil(
    () => harness.engine.state.commands.find((command) => command.id === commandId)?.deliveries[workId]?.status === 'entered-context',
    3_000,
    '命令进入模型上下文',
  )
}

function deliveryOf(harness: TestHarness, commandId: string, workId: string) {
  return harness.engine.state.commands.find((command) => command.id === commandId)?.deliveries[workId]
}

test('人工命令持久化、逐 work 投递状态与完成阻塞', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '准备结束' })
  await harness.engine.whenQuiet()
  assert.equal(proposal.round.status, 'open')

  const sent = await harness.engine.sendCommand({
    text: '先检查登录入口的注入点，再决定是否继续扫描。',
    requestId: 'cmd-request-1',
    source: 'web',
  })
  assert.match(sent.command.id, /^CMD-\d{4}$/)
  assert.equal(sent.idempotent, false)
  assert.match(sent.text, /已保存用户命令/)

  // The old round must be invalidated and a replacement opened.
  const oldRound = harness.engine.state.rounds.find((round) => round.id === proposal.round.id)
  assert.equal(oldRound?.status, 'invalidated')
  assert.match(oldRound?.invalidatedReason ?? '', /用户命令/)

  // The command is visible to agents in task.md.
  const taskMarkdown = await readFile(harness.paths.taskFile, 'utf8')
  assert.match(taskMarkdown, new RegExp(sent.command.id))
  assert.match(taskMarkdown, /先检查登录入口的注入点/)

  // Everyone can agree, but an undelivered command still blocks completion.
  await harness.engine.whenQuiet()
  const current = harness.engine.state.rounds.find((round) => round.id === harness.engine.state.currentRoundId)
  assert.ok(current)
  await harness.engine.respondCompletion('W-0001', { round_id: current.id, opinion: 'agree' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(harness.engine.state.status, 'active', '命令未进入上下文时不能完成')
  const status = await harness.engine.completionStatus('W-0001')
  assert.ok(status.blockers.some((blocker) => blocker.includes('人工命令')), status.blockers.join('\n'))
  assert.match((await harness.engine.inspectSelf('W-0001')).text, /尚未进入上下文的人工命令：1/)

  const claim = await harness.engine.claimCommands('W-0001', {})
  const item = claim.commands.find((command) => command.id === sent.command.id)
  assert.ok(item)
  assert.match(item.text, new RegExp(sent.command.id))
  assert.equal(deliveryOf(harness, sent.command.id, 'W-0001')?.status, 'saved')

  await harness.engine.ackCommand('W-0001', {
    commandId: sent.command.id,
    token: item.token,
    messageId: 'harness-message-1',
  })
  assert.equal(deliveryOf(harness, sent.command.id, 'W-0001')?.status, 'enqueued')

  // Enqueued is still not "entered context".
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(harness.engine.state.status, 'active')

  harness.driver.emitUserMessage('W-0001', { messageId: 'harness-message-1' })
  await waitUntil(
    () => deliveryOf(harness, sent.command.id, 'W-0001')?.status === 'entered-context',
    3_000,
    '命令进入上下文',
  )
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '命令送达后完成')
  assert.equal(harness.engine.state.completion?.roundId, current.id)
})

test('同一 request ID 幂等，同 ID 不同正文冲突，不同 ID 不做语义去重', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const first = await harness.engine.sendCommand({ text: '补充要求 A', requestId: 'same-id', source: 'cli' })
  const version = harness.engine.state.sharedStateVersion
  const second = await harness.engine.sendCommand({ text: '补充要求 A', requestId: 'same-id', source: 'cli' })
  assert.equal(second.idempotent, true)
  assert.equal(second.command.id, first.command.id)
  assert.equal(harness.engine.state.commands.length, 1)
  assert.equal(harness.engine.state.sharedStateVersion, version, '幂等重放不再递增共享状态版本')

  await assert.rejects(
    harness.engine.sendCommand({ text: '补充要求 B', requestId: 'same-id', source: 'cli' }),
    (error: unknown) => (error as { code?: string }).code === 'REQUEST_CONFLICT',
  )

  const other = await harness.engine.sendCommand({ text: '补充要求 A', requestId: 'other-id', source: 'cli' })
  assert.notEqual(other.command.id, first.command.id)
  assert.equal(harness.engine.state.commands.length, 2)
  assert.equal(harness.engine.state.counters.command, 2)
})

test('命令投递只接受当前 work、当前会话与进程代次', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.sendCommand({ text: '只发给当前 work', requestId: 'scope-1' })

  const work = harness.engine.state.works['W-0001']
  assert.ok(work)
  assert.equal((await harness.engine.claimCommands('W-0001', { sessionId: 'other-session' })).commands.length, 0)
  assert.equal(
    (await harness.engine.claimCommands('W-0001', { generation: work.activity.generation + 1 })).commands.length,
    0,
  )
  assert.equal((await harness.engine.claimCommands('W-9999', {})).commands.length, 0)
  assert.equal(
    (await harness.engine.claimCommands('W-0001', {
      sessionId: work.sessionId,
      generation: work.activity.generation,
    })).commands.length,
    1,
  )
})

test('新加入的 work 自动获得当前用户命令', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const sent = await harness.engine.sendCommand({ text: '新 work 也必须看到这条要求', requestId: 'join-1' })
  await harness.engine.whenQuiet()
  await harness.engine.spawnWork('W-0001', { reason: '并行验证', start_prompt: '从命令开始' })
  await harness.engine.whenQuiet()

  const delivery = deliveryOf(harness, sent.command.id, 'W-0002')
  assert.ok(delivery, '新 work 应有投递记录')
  assert.equal(delivery.status, 'saved')
  const claim = await harness.engine.claimCommands('W-0002', {})
  assert.equal(claim.commands.some((command) => command.id === sent.command.id), true)
  assert.equal(
    claim.commands.some((command) => command.id === sent.command.id && command.text.includes(sent.command.id)),
    true,
  )
})

test('work 退出后命令投递标记为收件人已退出，其他 work 仍保留', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.spawnWork('W-0001', { reason: '并行', start_prompt: '继续' })
  await harness.engine.whenQuiet()

  const sent = await harness.engine.sendCommand({ text: '两个 work 都要看到', requestId: 'exit-1' })
  await harness.engine.whenQuiet()
  await harness.engine.retireWork('W-0002', { reason: '方向结束' })
  await harness.engine.whenQuiet()

  assert.equal(deliveryOf(harness, sent.command.id, 'W-0002')?.status, 'recipient-exited')
  assert.equal(deliveryOf(harness, sent.command.id, 'W-0001')?.status, 'saved')
  const claim = await harness.engine.claimCommands('W-0001', {})
  assert.equal(claim.commands.some((command) => command.id === sent.command.id), true)
  assert.equal((await harness.engine.claimCommands('W-0002', {})).commands.length, 0)
})

/** Start a replacement engine for the same task with a chosen driver. */
async function reopenEngine(
  t: { after: (fn: () => Promise<void> | void) => void },
  paths: TestHarness['paths'],
  driver: FakeDriver,
): Promise<Engine> {
  const engine = await Engine.open({ paths, driver, logger: nullLogger })
  t.after(() => engine.close('test-cleanup'))
  await engine.start()
  assert.equal(await engine.whenQuiet(), true)
  return engine
}

test('重启清除遗留 claim，未 ack 的命令仍可重新 claim', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const sent = await harness.engine.sendCommand({ text: '重启前只 claim 未 ack', requestId: 'restart-claim-1' })
  assert.equal((await harness.engine.claimCommands('W-0001', {})).commands.length, 1)
  await harness.engine.close('simulated-crash')

  // The replacement process has a new generation; the dead process' claim
  // must not survive, and the still-saved command is claimable again.
  const driver = new FakeDriver()
  driver.generation = 2
  const engine = await reopenEngine(t, harness.paths, driver)
  const reopened = engine.state.commands.find((command) => command.id === sent.command.id)
  assert.equal(reopened?.deliveries['W-0001']?.claim, undefined)
  assert.equal(reopened?.deliveries['W-0001']?.status, 'saved')
  assert.equal((await engine.claimCommands('W-0001', {})).commands.length, 1)
})

test('进程更换后未观察到进入上下文的已入队命令重新投递（至少一次）', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const sent = await harness.engine.sendCommand({ text: '长步骤期间下发', requestId: 'restart-enqueued-1' })
  const claim = await harness.engine.claimCommands('W-0001', {})
  const item = claim.commands.find((command) => command.id === sent.command.id)
  assert.ok(item)
  await harness.engine.ackCommand('W-0001', {
    commandId: sent.command.id,
    token: item.token,
    messageId: 'lost-with-old-process',
  })
  await harness.engine.close('simulated-crash')

  // A new generation resumed the session, but the steered message was never
  // written to its log: the ack died with the old process. Leaving it at
  // `enqueued` would block completion forever, so it is delivered again.
  const driver = new FakeDriver()
  driver.generation = 2
  driver.replay = []
  const engine = await reopenEngine(t, harness.paths, driver)
  const delivery = engine.state.commands.find((command) => command.id === sent.command.id)?.deliveries['W-0001']
  assert.equal(delivery?.status, 'saved')
  assert.equal(delivery?.harnessMessageId, undefined)
  assert.equal(delivery?.enqueuedAt, undefined)
  assert.match(delivery?.note ?? '', /重新投递/)
  assert.equal((await engine.claimCommands('W-0001', {})).commands.length, 1)
})

test('恢复日志已包含命令的 user/message 时保持 entered-context，不重复投递', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const sent = await harness.engine.sendCommand({ text: '已写入会话日志', requestId: 'restart-observed-1' })
  const claim = await harness.engine.claimCommands('W-0001', {})
  const item = claim.commands.find((command) => command.id === sent.command.id)
  assert.ok(item)
  await harness.engine.ackCommand('W-0001', {
    commandId: sent.command.id,
    token: item.token,
    messageId: 'persisted-before-crash',
  })
  await harness.engine.close('simulated-crash')

  // The resumed session log contains the user/message the runtime never got to
  // apply before the crash. Replay proves the model already saw it.
  const work = harness.engine.state.works['W-0001']
  assert.ok(work)
  const driver = new FakeDriver()
  driver.generation = 2
  driver.replay = [
    {
      kind: 'user-message',
      sessionId: work.sessionId,
      generation: 2,
      seq: 1,
      at: new Date().toISOString(),
      messageId: 'persisted-before-crash',
    },
  ]
  const engine = await reopenEngine(t, harness.paths, driver)
  const delivery = engine.state.commands.find((command) => command.id === sent.command.id)?.deliveries['W-0001']
  assert.equal(delivery?.status, 'entered-context')
  assert.equal((await engine.claimCommands('W-0001', {})).commands.length, 0)
})

test('会话丢失时已入队命令重新投递', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const sent = await harness.engine.sendCommand({ text: '会话丢失后仍需送达', requestId: 'restart-fresh-1' })
  const claim = await harness.engine.claimCommands('W-0001', {})
  const item = claim.commands.find((command) => command.id === sent.command.id)
  assert.ok(item)
  await harness.engine.ackCommand('W-0001', {
    commandId: sent.command.id,
    token: item.token,
    messageId: 'pre-crash-message',
  })
  await harness.engine.close('simulated-crash')

  // A fresh session loses the queued input, so the delivery returns to saved.
  const freshDriver = new FakeDriver()
  freshDriver.ensure = async (spec) => {
    freshDriver.ensures.push({ workId: spec.workId, sessionStarted: spec.sessionStarted })
    return { resumed: false, freshFallback: spec.sessionStarted, generation: freshDriver.generation }
  }
  const freshEngine = await reopenEngine(t, harness.paths, freshDriver)
  const reset = freshEngine.state.commands.find((command) => command.id === sent.command.id)
  assert.equal(reset?.deliveries['W-0001']?.status, 'saved')
  assert.equal(reset?.deliveries['W-0001']?.harnessMessageId, undefined)
  assert.match(reset?.deliveries['W-0001']?.note ?? '', /会话丢失/)
  assert.equal((await freshEngine.claimCommands('W-0001', {})).commands.length, 1)
})

test('命令提交与完成竞争：先完成则拒绝新命令，幂等重放仍返回原命令', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const sent = await harness.engine.sendCommand({ text: '完成前发送', requestId: 'race-1' })
  await harness.engine.whenQuiet()
  await steer(harness, 'W-0001', sent.command.id, 'race-message-1')

  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '完成' })
  await harness.engine.respondCompletion('W-0001', {
    round_id: proposal.round.id,
    opinion: 'agree',
    reason: '同意',
  })
  await waitUntil(() => harness.engine.state.status === 'completed', 3_000, '任务完成')

  await assert.rejects(
    harness.engine.sendCommand({ text: '完成后的新命令', requestId: 'race-2' }),
    (error: unknown) => (error as { code?: string }).code === 'TASK_NOT_ACTIVE',
  )
  const replay = await harness.engine.sendCommand({ text: '完成前发送', requestId: 'race-1' })
  assert.equal(replay.idempotent, true)
  assert.equal(replay.command.id, sent.command.id)
  assert.equal(harness.engine.state.status, 'completed')
})

test('命令作为任务级记录保留并出现在管理快照与列表中', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const sent = await harness.engine.sendCommand({
    text: '管理快照必须显示这条命令',
    requestId: 'snapshot-1',
    source: 'api',
  })
  await harness.engine.whenQuiet()

  const snapshot = await harness.engine.adminSnapshot()
  assert.match(snapshot.text, new RegExp(sent.command.id))
  assert.match(snapshot.text, /管理快照必须显示这条命令/)
  const list = await harness.engine.listCommands()
  assert.equal(list.length, 1)
  const record = list[0] as CommandRecord
  assert.equal(record.requestId, 'snapshot-1')
  assert.equal(record.source, 'api')
  assert.equal(record.deliveries['W-0001']?.status, 'saved')
  // listCommands returns a defensive copy.
  record.deliveries['W-0001']!.status = 'recipient-exited'
  assert.equal(harness.engine.state.commands[0]?.deliveries['W-0001']?.status, 'saved')
})

test('claim 与 ack 不改变共享状态版本，不产生自我失效循环', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const sent = await harness.engine.sendCommand({ text: '协议投递不应反复失效', requestId: 'version-1' })
  await harness.engine.whenQuiet()
  const version = harness.engine.state.sharedStateVersion
  await steer(harness, 'W-0001', sent.command.id, 'version-message-1')
  await harness.engine.whenQuiet()
  assert.equal(harness.engine.state.sharedStateVersion, version)
})

test('命令唤醒处于 executor_wait 的 work，并在其后的边界投递', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const startedAt = Date.now()
  const waiting = harness.engine.waitForEvents('W-0001', { timeout_seconds: 30 })
  await waitUntil(
    () => harness.engine.state.works['W-0001']?.runtimeStatus === 'waiting',
    2_000,
    '进入 waiting',
  )
  const sent = await harness.engine.sendCommand({ text: '等待中的 work 也要收到', requestId: 'waiting-1' })
  const waited = await waiting
  assert.ok(Date.now() - startedAt < 2_000, '命令不应等到 wait 超时')
  assert.ok(waited.events.some((event) => event.kind === 'user-command'), '等待事件包含用户命令提示')
  assert.notEqual(harness.engine.state.works['W-0001']?.runtimeStatus, 'waiting')

  const claim = await harness.engine.claimCommands('W-0001', {})
  assert.equal(claim.commands.some((command) => command.id === sent.command.id), true)
})

test('retrying 期间命令保持待投递，恢复后才能 claim', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const sent = await harness.engine.sendCommand({ text: '重试期间不要丢', requestId: 'retry-1' })
  const work = harness.engine.state.works['W-0001']
  assert.ok(work)

  work.runtimeStatus = 'retrying'
  assert.equal((await harness.engine.claimCommands('W-0001', {})).commands.length, 0)
  assert.equal(deliveryOf(harness, sent.command.id, 'W-0001')?.status, 'saved')

  work.runtimeStatus = 'idle'
  const claim = await harness.engine.claimCommands('W-0001', {})
  assert.equal(claim.commands.some((command) => command.id === sent.command.id), true)
})

test('内部命令端点：管理提交、claim、ack 与鉴权', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  let server: ApiServer | undefined
  t.after(async () => {
    await server?.close()
  })
  server = await startApiServer({ getEngine: () => harness.engine, logger: nullLogger })

  const admin = async (op: string, params: unknown): Promise<any> => {
    const response = await fetch(`${server.url}/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ op, params }),
    })
    return response.json()
  }
  const workOp = async (path: string, body: unknown, token = server.token): Promise<any> => {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-liebian-work': 'W-0001',
      },
      body: JSON.stringify(body),
    })
    return response.json()
  }

  const sent = await admin('task.command', {
    text: '通过管理 API 发送',
    request_id: 'api-command-1',
    source: 'web',
  })
  assert.equal(sent.ok, true)
  assert.match(sent.result.command.id, /^CMD-\d{4}$/)
  assert.equal(sent.result.idempotent, false)

  const replay = await admin('task.command', {
    text: '通过管理 API 发送',
    request_id: 'api-command-1',
    source: 'web',
  })
  assert.equal(replay.result.idempotent, true)

  const conflict = await admin('task.command', {
    text: '不同正文',
    request_id: 'api-command-1',
    source: 'web',
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'REQUEST_CONFLICT')

  const list = await admin('commands.list', {})
  assert.equal(list.result.commands.length, 1)

  const unauthorized = await workOp('/command/claim', {}, 'wrong-token')
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.error.code, 'UNAUTHORIZED')

  const claim = await workOp('/command/claim', {})
  assert.equal(claim.ok, true)
  const item = claim.result.commands.find((command: { id: string }) => command.id === sent.result.command.id)
  assert.ok(item)
  assert.match(item.text, /用户命令 CMD-/)

  const ack = await workOp('/command/ack', {
    commandId: item.id,
    token: item.token,
    messageId: 'api-steer-message-1',
  })
  assert.equal(ack.ok, true)
  assert.equal(ack.result.delivery.status, 'enqueued')

  const staleAck = await workOp('/command/ack', {
    commandId: item.id,
    token: 'stale-token',
    messageId: 'another-message',
  })
  assert.equal(staleAck.ok, false)
  assert.equal(staleAck.error.code, 'COMMAND_CLAIM_STALE')

  harness.driver.emitUserMessage('W-0001', { messageId: 'api-steer-message-1' })
  await waitUntil(
    () =>
      harness.engine.state.commands[0]?.deliveries['W-0001']?.status === 'entered-context',
    3_000,
    'API 投递进入上下文',
  )
})

test('CLI：运行时在线时提交命令，离线时拒绝且不落盘', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const server = await startApiServer({ getEngine: () => harness.engine, logger: nullLogger })
  t.after(() => server.close())
  await writeDaemonInfo(harness.paths, {
    url: server.url,
    token: server.token,
    pid: process.pid,
    taskId: harness.paths.taskId,
  })

  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  const execFileAsync = promisify(execFile)
  const run = async (...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
        timeout: 30_000,
        encoding: 'utf8',
      })
      return { status: 0, stdout, stderr }
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string }
      return {
        status: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      }
    }
  }

  const online = await run(
    'command',
    '--task',
    harness.paths.taskDir,
    '--text',
    'CLI 发送的命令',
    '--request-id',
    'cli-request-1',
  )
  assert.equal(online.status, 0, online.stderr)
  assert.match(online.stdout, /已保存用户命令 CMD-\d{4}/)
  assert.equal(harness.engine.state.commands.length, 1)

  const listed = await run('commands', '--task', harness.paths.taskDir)
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /CLI 发送的命令/)
  assert.match(listed.stdout, /已保存，等待投递/)

  // Missing input must not silently wait on stdin, and a valueless
  // --request-id must not quietly become a fresh UUID.
  const missingInput = await run('command', '--task', harness.paths.taskDir)
  assert.equal(missingInput.status, 1)
  assert.match(missingInput.stderr, /缺少命令输入/)
  const missingRequestValue = await run(
    'command',
    '--task',
    harness.paths.taskDir,
    '--text',
    '缺少 request-id 的值',
    '--request-id',
  )
  assert.equal(missingRequestValue.status, 1)
  assert.match(missingRequestValue.stderr, /--request-id/)
  assert.equal(harness.engine.state.commands.length, 1)

  // Remove the daemon descriptor: the CLI must not edit state offline.
  await rm(harness.paths.daemonFile, { force: true })
  const offline = await run(
    'command',
    '--task',
    harness.paths.taskDir,
    '--text',
    '离线命令',
    '--request-id',
    'cli-request-2',
  )
  assert.equal(offline.status, 1)
  assert.match(offline.stderr, /RUNTIME_OFFLINE/)
  assert.match(offline.stderr, /命令未保存/)
  assert.equal(harness.engine.state.commands.length, 1)
})


