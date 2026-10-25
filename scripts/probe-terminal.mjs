/** Real harness + PTY + local TCP echo; no external model or external target. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SdkHarnessDriver } from '../src/harness/sdk-driver.ts'
import { renderHarnessPatch } from '../src/harness/patch.ts'
import { makeTaskPaths } from '../src/core/paths.ts'
import { createTask } from '../src/core/task.ts'
import { nullLogger } from '../src/util/log.ts'
import { applyActivityEvent, emptyActivity } from '../src/core/activity.ts'

if (process.platform === 'win32') throw new Error('请在 Linux task 镜像内执行此探针')
const scratch = fileURLToPath(new URL('../.scratch', import.meta.url))
await mkdir(scratch, { recursive: true })
const root = await mkdtemp(join(scratch, 'terminal-probe-'))
const paths = makeTaskPaths(root, `T-pty-${Date.now()}`)
await createTask(paths, { startInformation: 'local PTY probe', endInformation: 'close all terminals' })
await mkdir(paths.logsDir, { recursive: true })
const mcpEntry = fileURLToPath(new URL('../src/mcp/main.ts', import.meta.url))
await writeFile(paths.patchFile, renderHarnessPatch({ paths, mcpEntry, nodeExecutable: process.execPath }))
let nextTool
let requestCount = 0
let lastBody
const api = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const parsed = JSON.parse(body || '{}')
  if (!req.url.includes('/messages')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: { commands: [], permitId: parsed.permitId, released: true } }))
    return
  }
  lastBody = parsed
  const id = ++requestCount
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  emit('message_start', { message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'deepseek-flash',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  const tool = nextTool
  nextTool = undefined
  emit('content_block_start', { index: 0, content_block: tool
    ? { type: 'tool_use', id: `call_${id}`, name: tool.name, input: {} } : { type: 'text', text: '' } })
  emit('content_block_delta', { index: 0, delta: tool
    ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } : { type: 'text_delta', text: 'ok' } })
  emit('content_block_stop', { index: 0 })
  emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  emit('message_stop', {})
  res.end()
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${api.address().port}`
process.env.DEEPSEEK_BASE_URL = url
process.env.DEEPSEEK_API_KEY = 'local-probe-key'
const driver = new SdkHarnessDriver({ taskDir: paths.taskDir, patchFile: paths.patchFile, mcpEntry,
  logDir: paths.logsDir, daemonUrl: url, daemonToken: 'local-probe', provider: 'deepseek-official', model: 'deepseek-flash', logger: nullLogger })
const events = []
let activity
driver.onActivity = (_work, batch) => {
  for (const event of batch) {
    events.push(event)
    activity ??= emptyActivity(event.generation)
    applyActivityEvent(activity, event)
  }
}
const sockets = new Set()
const echo = createTcpServer((socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => {})
  socket.on('data', (bytes) => socket.write(`RECEIVED:${bytes}`))
})
await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
async function call(name, args) {
  const before = events.length
  nextTool = { name, args }
  await driver.prompt('W-0001', `Probe ${name}`)
  await driver.waitForIdle('W-0001')
  await driver.quiesce('W-0001')
  assert.ok(!events.slice(before).some((event) => event.kind === 'tool-result' && event.isError), `${name} failed: ${JSON.stringify(lastBody?.messages?.at(-1))}`)
  const results = lastBody.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'tool_result')
  return JSON.stringify(results.at(-1)?.content)
}
try {
  await driver.ensure({ workId: 'W-0001', sessionId: `liebian-${paths.taskId}-W-0001`, sessionStarted: false, taskDir: paths.taskDir })
  const opened = await call('terminal_open', { type: 'shell', name: 'probe' })
  const terminal = events.filter((event) => event.kind === 'terminal-snapshot').at(-1)?.terminals[0]?.id
  assert.ok(terminal, `terminal snapshot missing: ${opened}`)
  await call('terminal_send', { sessionId: terminal, text: 'export PTY_PROBE_VALUE=state-survives' })
  assert.match(await call('terminal_send', { sessionId: terminal, text: 'printf "%s\\n" "$PTY_PROBE_VALUE"' }), /state-survives/)
  console.log('[pass] PTY preserves state across tool calls')
  await call('terminal_send', { sessionId: terminal, text: `nc 127.0.0.1 ${echo.address().port}` })
  assert.match(await call('terminal_send', { sessionId: terminal, text: 'tcp-probe-line' }), /RECEIVED:tcp-probe-line/)
  assert.ok(Object.values(activity.jobs).some((job) => job.kind === 'terminal' && job.status === 'running'))
  console.log('[pass] interactive TCP input/output works; open terminal remains a completion blocker')
  await call('terminal_signal', { sessionId: terminal, signal: 'SIGINT' })
  assert.match(await call('terminal_send', { sessionId: terminal, text: 'printf "%s\\n" "$PTY_PROBE_VALUE"' }), /state-survives/)
  await call('terminal_read', { sessionId: terminal })
  await call('terminal_list', {})
  await call('terminal_close', { sessionId: terminal })
  assert.ok(Object.values(activity.jobs).filter((job) => job.kind === 'terminal').every((job) => job.status === 'completed'))
  console.log('[pass] SIGINT returns to the same shell; close clears terminal blockers')
} finally {
  await driver.stopAll()
  for (const socket of sockets) socket.destroy()
  echo.close()
  api.closeAllConnections()
  api.close()
  if (process.env.KEEP_PROBE === '1') console.log(`[kept] ${root}`)
  else await rm(root, { recursive: true, force: true })
}
