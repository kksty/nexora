import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { Client } from '@modelcontextprotocol/client'
import { startApiServer, type ApiServer } from '../src/api/server.ts'
import { daemonAlive } from '../src/core/daemon.ts'
import { nullLogger } from '../src/util/log.ts'
import { createHarness, type TestHarness } from './support/harness.ts'

/**
 * `@modelcontextprotocol/client` reaches us as a transitive dependency of the
 * harness SDK, so it is absent in a checkout that has not run `npm install`.
 * Importing it statically would abort this whole file, including the three API
 * tests that do not need it; load it lazily and skip only the MCP cases.
 */
type McpDeps = {
  Client: typeof import('@modelcontextprotocol/client').Client
  StdioClientTransport: typeof import('@modelcontextprotocol/client/stdio').StdioClientTransport
}

const mcp = await (async (): Promise<McpDeps | null> => {
  try {
    const [client, stdio] = await Promise.all([
      import('@modelcontextprotocol/client'),
      import('@modelcontextprotocol/client/stdio'),
    ])
    return { Client: client.Client, StdioClientTransport: stdio.StdioClientTransport }
  } catch {
    return null
  }
})()

const mcpTest = mcp === null ? test.skip : test

const MCP_ENTRY = fileURLToPath(new URL('../src/mcp/main.ts', import.meta.url))

test('本地 API：未就绪返回 503，host 端口被其他任务复用不能误判在线', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  let ready = false
  const server = await startApiServer({ getEngine: () => ready ? harness.engine : undefined, logger: nullLogger, portRange: '0' })
  t.after(() => server.close())
  assert.equal((await fetch(`${server.url}/health`)).status, 503)
  const info = { url: server.url, token: server.token, taskId: harness.paths.taskId, pid: 1, startedAt: '' }
  assert.equal(await daemonAlive(info), false)
  ready = true
  assert.equal(await daemonAlive(info), true)
  assert.equal(await daemonAlive({ ...info, taskId: 'T-another-task' }), false)
})

async function startRuntime(harness: TestHarness): Promise<ApiServer> {
  await harness.engine.start()
  await harness.engine.whenQuiet()
  return startApiServer({ getEngine: () => harness.engine, logger: nullLogger })
}

async function rpc(
  server: ApiServer,
  op: string,
  params: unknown,
  work = 'W-0001',
  token = server.token,
): Promise<{ status: number; body: { ok?: boolean; result?: any; error?: { code?: string; message?: string } } }> {
  const response = await fetch(`${server.url}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(work.length === 0 ? {} : { 'x-liebian-work': work }),
    },
    body: JSON.stringify({ op, params }),
  })
  return { status: response.status, body: (await response.json()) as any }
}

async function admin(
  server: ApiServer,
  op: string,
  params: unknown,
): Promise<{ status: number; body: { ok?: boolean; result?: any; error?: { code?: string; message?: string } } }> {
  const response = await fetch(`${server.url}/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ op, params }),
  })
  return { status: response.status, body: (await response.json()) as any }
}

test('本地 API：工作态写入、鉴权与管理员修改终点', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const server = await startRuntime(harness)
  t.after(() => server.close())

  const health = await fetch(`${server.url}/health`).then((response) => response.json())
  assert.equal((health as { ok?: boolean }).ok, true)

  const appended = await rpc(server, 'findings.append', { text: '通过 API 追加的发现' })
  assert.equal(appended.status, 200)
  assert.equal(appended.body.ok, true)
  assert.match(appended.body.result?.id ?? '', /^F-\d{4}$/)
  assert.equal(harness.engine.state.findings.length, 1)

  const unauthorized = await rpc(server, 'findings.append', { text: 'x' }, 'W-0001', 'wrong-token')
  assert.equal(unauthorized.status, 401)

  const missingWork = await rpc(server, 'findings.append', { text: 'x' }, '')
  assert.equal(missingWork.body.ok, false)
  assert.equal(missingWork.body.error?.code, 'INVALID_ARGUMENT')

  const badWork = await rpc(server, 'findings.append', { text: 'x' }, 'W-9999')
  assert.equal(badWork.body.ok, false)
  assert.equal(badWork.body.error?.code, 'WORK_NOT_FOUND')

  const admin = await fetch(`${server.url}/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ op: 'task.set_end', params: { text: '新的终点信息' } }),
  }).then((response) => response.json())
  assert.equal((admin as { ok?: boolean }).ok, true)
  assert.equal(harness.engine.state.targetVersion, 2)
  assert.equal(harness.engine.state.endInformation, '新的终点信息')
})

test('本地 API：请求体为 null 或必填参数类型错误时返回参数错误', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const server = await startRuntime(harness)
  t.after(() => server.close())

  const nullBody = await fetch(`${server.url}/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: 'null',
  }).then((response) => response.json() as Promise<{ ok?: boolean; error?: { code?: string } }>)
  assert.equal(nullBody.ok, false)
  assert.equal(nullBody.error?.code, 'INVALID_ARGUMENT')

  const numericText = await rpc(server, 'findings.append', { text: 123 })
  assert.equal(numericText.body.ok, false)
  assert.equal(numericText.body.error?.code, 'INVALID_ARGUMENT')
  assert.equal(harness.engine.state.findings.length, 0, '类型错误不能污染权威状态')

  const numericReason = await rpc(server, 'executor.spawn', { reason: 1, start_prompt: 'x' })
  assert.equal(numericReason.body.ok, false)
  assert.equal(numericReason.body.error?.code, 'INVALID_ARGUMENT')
})

mcpTest('MCP 桥接：harness 客户端可以发现并调用运行时工具', async (t) => {
  if (mcp === null) return
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const server = await startRuntime(harness)
  t.after(() => server.close())

  const transport = new mcp.StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: {
      ...process.env,
      LIEBIAN_DAEMON_URL: server.url,
      LIEBIAN_DAEMON_TOKEN: server.token,
      LIEBIAN_WORK: 'W-0001',
    } as Record<string, string>,
    stderr: 'pipe',
  })
  const client = new mcp.Client(
    { name: 'liebian-test-client', version: '0.0.1' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  )
  t.after(async () => {
    await client.close().catch(() => undefined)
  })
  await client.connect(transport)

  const listed = await client.listTools()
  const names = listed.tools.map((tool) => tool.name).sort()
  assert.equal(names.length, 18)
  for (const expected of [
    'activity_reconcile',
    'completion_respond',
    'completion_status',
    'executor_retire',
    'executor_spawn',
    'findings_append',
    'peer_inbox',
    'peer_send',
    'report_publish',
    'report_read',
    'self_inspect',
    'shared_read',
    'work_update',
  ]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`)
  }

  const inspected = await client.callTool({ name: 'self_inspect', arguments: {} })
  const inspectText = (inspected.content as { type: string; text?: string }[])[0]?.text ?? ''
  assert.match(inspectText, /W-0001/)
  assert.match(inspectText, /上下文容量\/已用：未知/)

  const appended = await client.callTool({
    name: 'findings_append',
    arguments: { text: '通过 MCP 写入的发现', type: '已验证事实' },
  })
  const appendText = (appended.content as { type: string; text?: string }[])[0]?.text ?? ''
  assert.match(appendText, /已追加发现 F-\d{4}/)
  assert.equal(harness.engine.state.findings.length, 1)

  const failed = await client.callTool({ name: 'findings_get', arguments: { id: 'F-9999' } })
  assert.equal(failed.isError, true)
  const failedText = (failed.content as { type: string; text?: string }[])[0]?.text ?? ''
  assert.match(failedText, /FINDING_NOT_FOUND/)

  await writeFile(join(harness.paths.taskDir, 'draft.md'), '# MCP 报告\n\n内容。\n', 'utf8')
  const published = await client.callTool({
    name: 'report_publish',
    arguments: {
      draft_path: 'draft.md',
      path: 'report.md',
      base_revision: 0,
      request_id: 'mcp-report-1',
    },
  })
  const publishedText = (published.content as { type: string; text?: string }[])[0]?.text ?? ''
  assert.match(publishedText, /已发布报告 report r1/)
  const report = await client.callTool({ name: 'report_read', arguments: {} })
  const reportText = (report.content as { type: string; text?: string }[])[0]?.text ?? ''
  assert.match(reportText, /MCP 报告/)
  assert.match(reportText, /版本：r1/)
})

mcpTest('MCP 工具：裂变、通信、等待与共识闭环', async (t) => {
  if (mcp === null) return
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const server = await startRuntime(harness)
  t.after(() => server.close())

  const connect = async (work: string): Promise<Client> => {
    const transport = new mcp.StdioClientTransport({
      command: process.execPath,
      args: [MCP_ENTRY],
      env: {
        ...process.env,
        LIEBIAN_DAEMON_URL: server.url,
        LIEBIAN_DAEMON_TOKEN: server.token,
        LIEBIAN_WORK: work,
      } as Record<string, string>,
      stderr: 'pipe',
    })
    const client = new mcp.Client(
      { name: `liebian-test-${work}`, version: '0.0.1' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    )
    await client.connect(transport)
    return client
  }

  const first = await connect('W-0001')
  t.after(async () => {
    await first.close().catch(() => undefined)
  })

  const spawned = await first.callTool({
    name: 'executor_spawn',
    arguments: { reason: '并行验证', start_prompt: '从登录入口继续' },
  })
  const spawnText = (spawned.content as { type: string; text?: string }[])[0]?.text ?? ''
  assert.match(spawnText, /已创建执行者 W-0002/)
  await harness.engine.whenQuiet()

  const second = await connect('W-0002')
  t.after(async () => {
    await second.close().catch(() => undefined)
  })

  const sent = await second.callTool({
    name: 'peer_send',
    arguments: { to: 'W-0001', kind: 'hint', body: '请确认这条线索' },
  })
  const sentText = (sent.content as { type: string; text?: string }[])[0]?.text ?? ''
  assert.match(sentText, /已发送：M-\d{4}/)
  await harness.engine.whenQuiet()

  const inbox = await first.callTool({ name: 'peer_inbox', arguments: { include_delivered: true } })
  const inboxText = (inbox.content as { type: string; text?: string }[])[0]?.text ?? ''
  assert.match(inboxText, /请确认这条线索/)

  const wait = await first.callTool({
    name: 'executor_wait',
    arguments: { timeout_seconds: 1 },
  })
  const waitText = (wait.content as { type: string; text?: string }[])[0]?.text ?? ''
  assert.match(waitText, /等待超时|收到/)

  const proposal = await first.callTool({
    name: 'completion_propose',
    arguments: { reason: '终点目标已达成' },
  })
  const proposalText = (proposal.content as { type: string; text?: string }[])[0]?.text ?? ''
  const roundId = /C-\d{4}/.exec(proposalText)?.[0]
  assert.ok(roundId)
  await harness.engine.whenQuiet()

  await first.callTool({
    name: 'completion_respond',
    arguments: { round_id: roundId, opinion: 'agree', reason: '同意' },
  })
  await second.callTool({
    name: 'completion_respond',
    arguments: { round_id: roundId, opinion: 'agree', reason: '复核后同意' },
  })
  const deadline = Date.now() + 3_000
  while (harness.engine.state.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(harness.engine.state.status, 'completed')
  assert.equal(harness.engine.state.completion?.roundId, roundId)
})

test('管理 API：已结束任务继续与空集合恢复', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const server = await startRuntime(harness)
  t.after(() => server.close())

  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '管理 API 完成' })
  await harness.engine.respondCompletion('W-0001', { round_id: proposal.round.id, opinion: 'agree' })
  const deadline = Date.now() + 3_000
  while (harness.engine.state.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(harness.engine.state.status, 'completed')

  const continued = await admin(server, 'task.continue', {
    text: '管理 API 继续任务',
    request_id: 'api-continue-1',
    executions_stopped: true,
  })
  assert.equal(continued.body.ok, true, JSON.stringify(continued.body))
  assert.equal(continued.body.result.run.id, 'R-0002')
  assert.equal(continued.body.result.work.id, 'W-0002')
  assert.equal(harness.engine.state.status, 'active')
  assert.equal(harness.engine.state.currentRunId, 'R-0002')

  const replay = await admin(server, 'task.continue', {
    text: '管理 API 继续任务',
    request_id: 'api-continue-1',
    executions_stopped: true,
  })
  assert.equal(replay.body.ok, true)
  assert.equal(replay.body.result.idempotent, true)
  assert.equal(harness.engine.state.runs.length, 2)

  // A separate active task with no participants can be recovered via admin API.
  const empty = await createHarness()
  t.after(() => empty.cleanup())
  const emptyServer = await startRuntime(empty)
  t.after(() => emptyServer.close())
  await empty.engine.retireWork('W-0001', { reason: '让出任务' })
  const recovered = await admin(emptyServer, 'task.recover', {
    request_id: 'api-recover-1',
    source: 'api',
  })
  assert.equal(recovered.body.ok, true, JSON.stringify(recovered.body))
  assert.equal(recovered.body.result.created, true)
  assert.equal(recovered.body.result.work.id, 'W-0002')
  assert.equal(empty.engine.state.status, 'active')
  assert.equal(empty.engine.state.currentRunId, 'R-0001')
})
