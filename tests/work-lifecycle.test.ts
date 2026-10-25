import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createHarness, waitUntil } from './support/harness.ts'

test('裂变产生干净的新会话，并获得理由、起始提示和任务定义', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const finding = await harness.engine.appendFinding('W-0001', {
    text: '上传接口可能存在路径穿越',
    type: '待验证假设',
  })
  const spawned = await harness.engine.spawnWork('W-0001', {
    reason: '需要独立验证上传接口的路径穿越假设',
    start_prompt: '从 /upload 开始，先复现 F-0001 描述的现象，再尝试读取 /etc/passwd 之外的受限文件。',
    refs: [finding.id],
  })
  assert.equal(spawned.workId, 'W-0002')
  assert.equal(spawned.parentWorkId, 'W-0001')
  assert.equal(await harness.engine.whenQuiet(), true)

  const childPrompt = harness.driver.promptsFor('W-0002')[0]
  assert.ok(childPrompt)
  assert.match(childPrompt, /裂变来源/)
  assert.match(childPrompt, /需要独立验证上传接口的路径穿越假设/)
  assert.match(childPrompt, /从 \/upload 开始/)
  assert.match(childPrompt, new RegExp(finding.id))
  assert.match(childPrompt, /起始信息：目标站点为 example\.test/)

  const state = harness.engine.state
  assert.equal(state.works['W-0002']?.parentWorkId, 'W-0001')
  assert.equal(state.works['W-0002']?.sessionId.length > 0, true)
  assert.notEqual(state.works['W-0002']?.sessionId, state.works['W-0001']?.sessionId)

  // The source executor keeps working after fission.
  const after = await harness.engine.appendFinding('W-0001', { text: '原执行者继续推进' })
  assert.match(after.id, /^F-\d{4}$/)
  assert.equal(state.works['W-0001']?.runtimeStatus, 'idle')
})

test('裂变请求使用 request_id 幂等：响应丢失后重试不会重复创建 work', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const request = {
    reason: '并行验证同一方向',
    start_prompt: '从登录入口开始，独立验证。',
    refs: [],
    request_id: 'spawn-idem-1',
  }
  const first = await harness.engine.spawnWork('W-0001', request)
  assert.equal(first.workId, 'W-0002')
  assert.equal(first.idempotent, false)
  await harness.engine.whenQuiet()

  const replay = await harness.engine.spawnWork('W-0001', request)
  assert.equal(replay.idempotent, true)
  assert.equal(replay.workId, 'W-0002')
  assert.equal(Object.keys(harness.engine.state.works).length, 2)
  assert.equal(harness.driver.promptsFor('W-0002').length, 1, '幂等重试不会重新启动会话或重复写 prompt')
  assert.equal(harness.driver.ensures.filter((item) => item.workId === 'W-0002').length, 1)

  await assert.rejects(
    harness.engine.spawnWork('W-0001', { ...request, reason: '另一个理由' }),
    (error: unknown) => (error as { code?: string }).code === 'REQUEST_CONFLICT',
  )

  // A different request id is a new intent and may create another executor.
  const another = await harness.engine.spawnWork('W-0001', { ...request, request_id: 'spawn-idem-2' })
  assert.equal(another.workId, 'W-0003')
  assert.equal(another.idempotent, false)
})

test('裂变后源 work 可交接并退出，行从活跃表移除但发现保留', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.spawnWork('W-0001', { reason: '接续探索', start_prompt: '继续验证登录绕过' })
  await harness.engine.whenQuiet()

  const finding = await harness.engine.appendFinding('W-0001', { text: '登录接口允许枚举用户名' })
  await harness.engine.retireWork('W-0001', { reason: '已交接给 W-0002' })

  const state = harness.engine.state
  assert.equal(state.works['W-0001']?.runtimeStatus, 'exited')
  const worksMarkdown = await readFile(harness.paths.worksFile, 'utf8')
  assert.doesNotMatch(worksMarkdown, /W-0001/)
  assert.match(worksMarkdown, /W-0002/)

  // The published finding remains readable after its author retired, and its
  // author's session history is not expanded automatically.
  const read = await harness.engine.getFinding('W-0002', finding.id)
  assert.equal(read.authorWorkId, 'W-0001')
  assert.match(read.text, /登录接口允许枚举用户名/)

  await assert.rejects(
    harness.engine.sendMessage('W-0002', { to: 'W-0001', body: '还能收到吗？' }),
    (error: unknown) => {
      const appError = error as { code?: string; details?: { results?: { code?: string }[] } }
      return appError.code === 'MESSAGE_NOT_DELIVERED' && appError.details?.results?.[0]?.code === 'WORK_EXITED'
    },
  )

  await waitUntil(() => harness.driver.stops.includes('W-0001'), 2_000, '退出后停止 harness 进程')
})

test('定向消息持久化后投递，接收方自行读取', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  await harness.engine.spawnWork('W-0001', { reason: '并行', start_prompt: '开始' })
  await harness.engine.whenQuiet()

  const finding = await harness.engine.appendFinding('W-0001', { text: '发现一个可能的注入点' })
  const sent = await harness.engine.sendMessage('W-0001', {
    to: 'W-0002',
    kind: 'hint',
    body: `这条发现可能与你当前工作有关，请查看 ${finding.id}。`,
    refs: [finding.id],
  })
  assert.equal(sent.results[0]?.ok, true)
  const messageId = sent.results[0]?.messageId
  assert.ok(messageId)

  await waitUntil(
    () => harness.driver.promptsFor('W-0002').some((prompt) => prompt.includes(messageId)),
    3_000,
    '消息进入接收方上下文',
  )

  const inbox = await harness.engine.readInbox('W-0002', { include_delivered: true })
  const message = inbox.messages.find((item) => item.id === messageId)
  assert.ok(message)
  assert.equal(message.fromWorkId, 'W-0001')
  assert.equal(message.kind, 'hint')
  assert.equal(message.status, 'read')
  assert.deepEqual(message.refs, [finding.id])

  // Self-addressed messages are rejected instead of being silently dropped.
  await assert.rejects(harness.engine.sendMessage('W-0001', { to: 'W-0001', body: '自己' }), (error: unknown) => {
    const appError = error as { code?: string; details?: { results?: { code?: string }[] } }
    return appError.code === 'MESSAGE_NOT_DELIVERED' && appError.details?.results?.[0]?.code === 'INVALID_ARGUMENT'
  })
})

test('收件方退出时，未投递消息被标记并通知发送方', async (t) => {
  const harness = await createHarness({ autoFinish: false })
  t.after(() => harness.cleanup())
  await harness.engine.start()
  harness.driver.finishTurn('W-0001')
  await waitUntil(() => harness.engine.state.works['W-0001']?.runtimeStatus === 'idle')

  await harness.engine.spawnWork('W-0001', { reason: '并行', start_prompt: '开始' })
  harness.driver.finishTurn('W-0002')
  await waitUntil(() => harness.engine.state.works['W-0002']?.runtimeStatus === 'idle')

  const sent = await harness.engine.sendMessage('W-0002', { to: 'W-0001', body: '这条消息将遇到退出' })
  const messageId = sent.results[0]?.messageId
  assert.ok(messageId)

  await harness.engine.retireWork('W-0001', { reason: '交接完成' })
  const message = harness.engine.state.messages.find((item) => item.id === messageId)
  assert.equal(message?.status, 'recipient-exited')
  assert.equal(message?.note, '收件方已退出')

  const notice = harness.engine.state.messages.find(
    (item) => item.toWorkId === 'W-0002' && item.system && item.body.includes('W-0001'),
  )
  assert.ok(notice)
  assert.match(notice.body, /已退出/)

  harness.driver.finishTurn('W-0002')
  await waitUntil(() => harness.driver.stops.includes('W-0001'), 2_000, '退出后停止进程')
  assert.equal(await harness.engine.whenQuiet(), true)

  const inbox = await harness.engine.readInbox('W-0002', { include_delivered: true })
  assert.ok(inbox.messages.some((item) => item.id === notice.id))
})
