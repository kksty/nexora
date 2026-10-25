/**
 * Manual real-harness probe: drives the real `dsh --profile sdk` process
 * against a local fake Anthropic Messages endpoint. No model credential or
 * network access is used.
 *
 * The Windows host disables the harness `bash` tool, so run this inside the
 * Linux task image (see README "真实 harness 探针"). It verifies:
 *   - session/prompt returns a durable messageId,
 *   - the prompt's user/message id matches that receipt,
 *   - a real background bash job registers and settles,
 *   - the tool-jobs completion notice enters a new model turn,
 *   - session.status returns to idle and quiesce completes.
 *
 * It is not part of `npm test`; it is the recorded real-harness check for the
 * activity/consensus stage.
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

const scratch = fileURLToPath(new URL('../.scratch/probe-harness-root', import.meta.url))
await mkdir(scratch, { recursive: true })
const root = await mkdtemp(join(scratch, 'run-'))
const taskId = `T-probe-${Date.now()}`
const paths = makeTaskPaths(join(root, 'tasks'), taskId)
await createTask(paths, { startInformation: 'probe start', endInformation: 'probe end' })
await mkdir(paths.logsDir, { recursive: true })

let modelRequest = 0
const server = createServer((req, res) => {
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
    console.log(`[fake-llm] request=${modelRequest} ${req.method} ${req.url} bytes=${body.length}`)
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
    if (modelRequest === 1) {
      const input = {
        description: 'Run background probe command',
        command: 'sleep 3; echo background-done',
        run_in_background: true,
      }
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_probe_1', name: 'bash', input: {} },
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
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log(`[probe] fake LLM on 127.0.0.1:${port}`)

process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`
process.env.DEEPSEEK_API_KEY = 'probe-key'
await writeFile(paths.patchFile, '[]\n')
const logger = createLogger({ file: join(paths.logsDir, 'probe.log') })
const driver = new SdkHarnessDriver({
  taskDir: paths.taskDir,
  patchFile: paths.patchFile,
  mcpEntry: fileURLToPath(new URL('../bin/liebian-mcp.js', import.meta.url)),
  logDir: paths.logsDir,
  daemonUrl: 'http://127.0.0.1:1',
  daemonToken: 'unused',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  logger,
  dshBin: resolveDshBin(),
})

const events = []
driver.onActivity = (workId, batch) => {
  events.push(...batch)
  for (const event of batch) {
    console.log(`[activity] ${event.kind} ${JSON.stringify(event).slice(0, 220)}`)
  }
}

let failed = false
function check(condition, message) {
  if (condition) {
    console.log(`[pass] ${message}`)
  } else {
    failed = true
    console.error(`[fail] ${message}`)
  }
}

try {
  const sessionId = `liebian-${taskId}-W-0001`
  const ensure = await driver.ensure({
    workId: 'W-0001',
    sessionId,
    sessionStarted: false,
    taskDir: paths.taskDir,
  })
  console.log('[ensure]', ensure)
  const receipt = await driver.prompt('W-0001', 'Start a background command and then acknowledge.')
  console.log('[prompt]', receipt)
  await driver.waitForIdle('W-0001')

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const settled = events.some((event) => event.kind === 'job-settled')
    const notice = events.some(
      (event) => event.kind === 'user-message' && event.sourceKind === 'tool-jobs',
    )
    if (settled && notice) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await driver.waitForIdle('W-0001').catch(() => undefined)
  await driver.quiesce('W-0001')

  const kinds = events.reduce((acc, event) => {
    acc[event.kind] = (acc[event.kind] ?? 0) + 1
    return acc
  }, {})
  console.log('[kinds]', kinds)
  console.log(`[done] activity events=${events.length}`)

  const promptEvent = events.find(
    (event) => event.kind === 'user-message' && event.messageId === receipt.messageId,
  )
  const job = events.find((event) => event.kind === 'job-registered')
  const settlement = events.find((event) => event.kind === 'job-settled')
  const notice = events.find(
    (event) => event.kind === 'user-message' && event.sourceKind === 'tool-jobs',
  )
  const idle = events.filter((event) => event.kind === 'status' && event.status === 'idle').length

  check(typeof receipt.messageId === 'string' && receipt.messageId.length > 0, 'session/prompt 返回 messageId')
  check(promptEvent !== undefined, 'prompt 的 messageId 出现在 user/message 事件中')
  check(job?.kind === 'job-registered', '真实 bash 后台任务已登记')
  check(settlement?.kind === 'job-settled', '真实后台任务已结算')
  check(settlement !== undefined && settlement.seq > (job?.seq ?? 0), '结算事件晚于登记事件')
  check(notice !== undefined, 'tool-jobs 结算通知进入模型上下文')
  check(
    notice !== undefined && settlement !== undefined && notice.seq > settlement.seq,
    '通知事件晚于结算事件',
  )
  check(idle >= 2, '会话在请求与唤醒后都回到 idle')
  check(modelRequest >= 2, '后台任务唤醒触发了新的模型请求')
  await driver.stopAll()
} catch (error) {
  failed = true
  console.error('[probe failed]', error)
  await driver.stopAll().catch(() => undefined)
} finally {
  server.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (process.env.KEEP_PROBE === '1') console.log(`[kept] ${root}`)
  else await rm(root, { recursive: true, force: true })
  if (failed) process.exitCode = 1
}
