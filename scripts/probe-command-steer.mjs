/**
 * Manual real-harness probe: verifies that a human command submitted through
 * the steering plugin enters a *running* model turn at a step boundary.
 *
 * It starts a real `dsh --profile sdk` process with the repository's
 * `command-steer` plugin and one bash tool call per step, while a local fake
 * Anthropic Messages endpoint supplies the model. The fake runtime offers one
 * command only after the first model request, so steering must be claimed
 * between the first and second step of the same turn.
 *
 * The host disables the harness bash tool on Windows, so run this inside the
 * Linux task image (see README "真实 harness 探针"). No model credential or
 * network access is used.
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SdkHarnessDriver, resolveDshBin } from '../src/harness/sdk-driver.ts'
import { makeTaskPaths } from '../src/core/paths.ts'
import { createTask } from '../src/core/task.ts'
import { createLogger } from '../src/util/log.ts'

if (process.platform === 'win32') {
  console.error('此探针需要 Linux 的 harness bash 工具；请在 task 镜像内运行（见 README）。')
  process.exit(2)
}

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginPath = join(here, '..', 'src', 'harness', 'command-steer.ts')
const scratch = fileURLToPath(new URL('../.scratch/probe-steer-root', import.meta.url))
await mkdir(scratch, { recursive: true })
const root = await mkdtemp(join(scratch, 'run-'))
const taskId = `T-probe-steer-${Date.now()}`
const paths = makeTaskPaths(join(root, 'tasks'), taskId)
await createTask(paths, { startInformation: 'steer probe start', endInformation: 'steer probe end' })
await mkdir(paths.logsDir, { recursive: true })

// ---------------------------------------------------------------------------
// Fake runtime command API
// ---------------------------------------------------------------------------

let commandAvailable = false
let claimed = 0
let ackedMessageId = ''
let ackCount = 0
let releaseCount = 0
let commandPhase = 1
const commandDefs = {
  1: { id: 'CMD-9001', text: '用户命令：请先记录登录入口，再继续下一步。' },
  2: { id: 'CMD-9002', text: '恢复后的用户命令：请继续检查管理员入口。' },
}

const commandServer = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    const send = (payload) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (!request.url?.startsWith('/command/')) {
      response.writeHead(404).end()
      return
    }
    let parsed = {}
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      parsed = {}
    }
    if (request.url === '/command/claim') {
      if (!commandAvailable || ackedMessageId.length > 0) {
        send({ ok: true, result: { commands: [] } })
        return
      }
      claimed += 1
      const command = commandDefs[commandPhase]
      send({
        ok: true,
        result: {
          commands: [{ id: command.id, text: command.text, token: `claim-token-${claimed}` }],
        },
      })
      return
    }
    if (request.url === '/command/ack') {
      if (parsed.commandId !== commandDefs[commandPhase].id) {
        send({ ok: false, error: { code: 'COMMAND_NOT_FOUND', message: 'unexpected command' } })
        return
      }
      ackCount += 1
      ackedMessageId = String(parsed.messageId ?? '')
      send({ ok: true, result: { text: 'acked', delivery: { status: 'enqueued' } } })
      return
    }
    if (request.url === '/command/release') {
      releaseCount += 1
      send({ ok: true, result: { text: 'released' } })
      return
    }
    response.writeHead(404).end()
  })
})
await new Promise((resolve) => commandServer.listen(0, '127.0.0.1', resolve))
const commandPort = commandServer.address().port
console.log(`[probe] fake command API on 127.0.0.1:${commandPort}`)

// ---------------------------------------------------------------------------
// Fake Anthropic Messages endpoint: three steps in one turn
// ---------------------------------------------------------------------------

let modelRequest = 0
const seenBodies = []
const llmServer = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/messages')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    modelRequest += 1
    seenBodies.push(body)
    console.log(`[fake-llm] request=${modelRequest} bytes=${body.length}`)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'request-id': `probe-request-${modelRequest}`,
    })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    const base = {
      id: `msg_probe_${modelRequest}`,
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    }
    send('message_start', { type: 'message_start', message: base })
    if (modelRequest <= 2) {
      const input = {
        description: `probe step ${modelRequest}`,
        command: 'sleep 2; echo step-done',
      }
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `toolu_steer_${modelRequest}`, name: 'bash', input: {} },
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 20 },
      })
    } else {
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `ack from fake model ${modelRequest}` },
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      })
    }
    send('message_stop', { type: 'message_stop' })
    res.end()
    // The command becomes available only while the first turn is running, so
    // claims cannot be queued before the prompt starts.
    if (modelRequest === 1) commandAvailable = true
  })
})
await new Promise((resolve) => llmServer.listen(0, '127.0.0.1', resolve))
const llmPort = llmServer.address().port
console.log(`[probe] fake LLM on 127.0.0.1:${llmPort}`)

process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${llmPort}`
process.env.DEEPSEEK_API_KEY = 'probe-key'

// The patch mirrors the production one for the pieces this probe needs.
const patch = `# Generated by the command-steer probe for ${taskId}.
- id: session-persistence-jsonl
  config:
    root: ${JSON.stringify(paths.sessionsDir)}
    compression: none
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: bash-sandbox
  disabled: false
  config:
    timeoutMs: 900000
- id: tool-bash
  disabled: false
  config:
    enableRunInBackground: true
    promoteOnTimeout: true
- id: tool-fs
  config:
    read: true
    write: true
    edit: true
    readImage: false
- insert:
    - id: command-steer
      name: ${JSON.stringify(pluginPath)}
`
await writeFile(paths.patchFile, patch)

const logger = createLogger({ file: join(paths.logsDir, 'probe-steer.log') })
const driverOptions = {
  taskDir: paths.taskDir,
  patchFile: paths.patchFile,
  mcpEntry: fileURLToPath(new URL('../bin/liebian-mcp.js', import.meta.url)),
  logDir: paths.logsDir,
  daemonUrl: `http://127.0.0.1:${commandPort}`,
  daemonToken: 'probe-command-token',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  logger,
  dshBin: resolveDshBin(),
}
const driver = new SdkHarnessDriver(driverOptions)

const events = []
driver.onActivity = (workId, batch) => {
  events.push(...batch)
  for (const event of batch) {
    console.log(`[activity] ${event.kind} ${JSON.stringify(event).slice(0, 200)}`)
  }
}
driver.onUnexpectedExit = (workId, reason) => {
  console.error(`[harness-exit] ${workId}: ${reason}`)
}
driver.onWorkerExit = (workId, reason) => {
  console.error(`[worker-exit] ${workId}: ${reason}`)
}

let failed = false
function check(condition, message) {
  if (condition) console.log(`[pass] ${message}`)
  else {
    failed = true
    console.error(`[fail] ${message}`)
  }
}

try {
  const sessionId = `liebian-${taskId}-W-0001`
  const ensure = await driver.ensure({ workId: 'W-0001', sessionId, sessionStarted: false, taskDir: paths.taskDir })
  console.log('[ensure]', ensure)
  await driver.prompt(
    'W-0001',
    'Run two steps, then acknowledge. A user command may arrive mid-turn.',
  )
  await driver.waitForIdle('W-0001')
  await driver.quiesce('W-0001')

  // The steered command may be processed in extra steps; wait briefly for the
  // ack and its user/message event to settle.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && (ackCount === 0 || ackedMessageId.length === 0)) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const userMessage = events.find(
    (event) => event.kind === 'user-message' && event.messageId === ackedMessageId,
  )
  const turnStart = events.find((event) => event.kind === 'turn-start')
  const turnEnd = [...events].reverse().find((event) => event.kind === 'turn-end')
  const commandInBody = seenBodies.findIndex((body) => body.includes('用户命令：请先记录登录入口'))
  const kinds = events.reduce((acc, event) => {
    acc[event.kind] = (acc[event.kind] ?? 0) + 1
    return acc
  }, {})
  console.log('[kinds]', kinds)
  console.log(`[requests] ${modelRequest}; command in request #${commandInBody + 1}`)
  console.log(`[ack] count=${ackCount} messageId=${ackedMessageId} release=${releaseCount}`)

  check(claimed > 0, '命令插件向运行时 claim 了待投递命令')
  check(ackCount > 0 && ackedMessageId.length > 0, '插件把 steer 的 messageId 回执给运行时')
  check(userMessage !== undefined, 'steer 的 user/message 事件出现在会话日志')
  check(
    userMessage !== undefined &&
      turnStart !== undefined &&
      turnEnd !== undefined &&
      userMessage.seq > turnStart.seq &&
      userMessage.seq < turnEnd.seq,
    '命令在同一个 turn 内、turn 结束前进入上下文（步骤边界）',
  )
  check(commandInBody === 1, '第二条模型请求已包含用户命令（第一步之后、turn 结束之前）')
  check(kinds['step-start'] >= 2, '该 turn 至少有 2 个模型步骤')
  await driver.stopAll()

  // -------------------------------------------------------------------------
  // Phase 2: resume the same persisted session in a new process and verify the
  // plugin still receives this work's agent and delivers a command.
  // -------------------------------------------------------------------------
  const resumedEvents = []
  const resumedDriver = new SdkHarnessDriver(driverOptions)
  resumedDriver.onActivity = (workId, batch) => {
    resumedEvents.push(...batch)
    for (const event of batch) {
      console.log(`[resumed-activity] ${event.kind} ${JSON.stringify(event).slice(0, 160)}`)
    }
  }
  const ensure2 = await resumedDriver.ensure({
    workId: 'W-0001',
    sessionId,
    sessionStarted: true,
    taskDir: paths.taskDir,
  })
  console.log('[resume]', ensure2)
  check(ensure2.resumed === true, '第二个进程恢复了持久会话')
  commandPhase = 2
  ackedMessageId = ''
  commandAvailable = true
  const deadline2 = Date.now() + 20_000
  // The queue receipt can precede user/message and the next model request.
  // Wait for the facts being asserted, not merely for admission into steer.
  while (Date.now() < deadline2 && (
    ackCount < 2 || ackedMessageId.length === 0 ||
    !resumedEvents.some((event) => event.kind === 'user-message' && event.messageId === ackedMessageId) ||
    !seenBodies.some((body) => body.includes('恢复后的用户命令'))
  )) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const resumedMessage = resumedEvents.find(
    (event) => event.kind === 'user-message' && event.messageId === ackedMessageId,
  )
  check(ackCount >= 2 && ackedMessageId.length > 0, '恢复后的进程把 steer 的 messageId 回执给运行时')
  check(resumedMessage !== undefined, '恢复后的命令 user/message 事件出现在同一会话日志')
  check(
    seenBodies.some((body) => body.includes('恢复后的用户命令')),
    '恢复后的模型请求包含新命令',
  )
  await resumedDriver.waitForIdle('W-0001').catch(() => undefined)
  await resumedDriver.stopAll()
} catch (error) {
  failed = true
  console.error('[probe failed]', error)
  await driver.stopAll().catch(() => undefined)
} finally {
  llmServer.close()
  commandServer.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (process.env.KEEP_PROBE === '1') console.log(`[kept] ${root}`)
  else await rm(root, { recursive: true, force: true })
  if (failed) process.exitCode = 1
}
