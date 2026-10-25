/** Host-side Docker smoke test with isolated tasks and a local fake model. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTaskPaths } from '../src/core/paths.ts'
import { createTask } from '../src/core/task.ts'
import { readDaemonInfo, callDaemon } from '../src/core/daemon.ts'
import { loadState } from '../src/core/state.ts'
import { startDockerTask, stopDockerTask, readTasksCompose } from '../src/web/docker-launcher.ts'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('..', import.meta.url))
const scratch = join(repo, '.scratch')
await mkdir(scratch, { recursive: true })
const root = await mkdtemp(join(scratch, 'compose-probe-'))
const tasksRoot = join(root, 'tasks')
const generated = join(root, 'tasks.json')
const composeFile = join(root, 'compose.json')
const home = join(root, 'dsh')
const project = `liebian-probe-${Date.now()}`
await mkdir(home, { recursive: true })
await writeFile(generated, JSON.stringify({ services: {} }))
await writeFile(composeFile, JSON.stringify({ name: project, include: [{ path: './tasks.json' }], services: {} }))
let requests = 0
const model = createServer(async (req, res) => {
  for await (const _chunk of req) { /* drain */ }
  requests++
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  emit('message_start', { message: { id: `m${requests}`, type: 'message', role: 'assistant', model: 'deepseek-flash',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'local smoke ok' } })
  emit('content_block_stop', { index: 0 })
  emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
  emit('message_stop', {})
  res.end()
})
await new Promise((r) => model.listen(0, '127.0.0.1', r))
Object.assign(process.env, {
  LIEBIAN_COMPOSE_FILE: composeFile, LIEBIAN_TASKS_COMPOSE_FILE: generated, LIEBIAN_COMPOSE_PROJECT: project,
  LIEBIAN_HOST_TASKS_DIR: tasksRoot, LIEBIAN_HOST_DSH_HOME: home, DSH_HOME: home,
  DEEPSEEK_API_KEY: 'local-probe-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}`,
  LIEBIAN_PROVIDER: 'deepseek-official', LIEBIAN_MODEL: 'deepseek-flash', LIEBIAN_API_PORT_RANGE: '44388-44487',
  LIEBIAN_TASK_START_TIMEOUT_MS: '60000',
  LIEBIAN_DIAGNOSTICS_INTERVAL_MS: '250',
})
const paths = ['a', 'b'].map((suffix) => makeTaskPaths(tasksRoot, `T-net-${Date.now()}-${suffix}`))
async function until(fn) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('smoke predicate timed out')
}
let listener
try {
  for (const path of paths) await createTask(path, { startInformation: 'local smoke only', endInformation: 'wait for human stop' })
  const started = await Promise.all(paths.map((path) => startDockerTask(path)))
  assert.ok(started.every((result) => result.pid > 0))
  const infos = await Promise.all(paths.map(readDaemonInfo))
  assert.notEqual(infos[0].url, infos[1].url)
  for (const info of infos) assert.match(info.url, /127\.0\.0\.1:44[34]\d\d/)
  const services = await readTasksCompose()
  assert.ok(Object.values(services.services).every((service) => service.network_mode === 'host'))
  console.log('[pass] two host-network tasks ready on distinct custom management ports')
  await until(async () => requests >= 2 && (await loadState(paths[0])).works['W-0001']?.runtimeStatus === 'idle')
  const work = (op, params) => callDaemon(infos[0], '/rpc', op, params, { headers: { 'x-liebian-work': 'W-0001' }, timeoutMs: 60000 })
  await work('executor.spawn', { reason: 'local peer probe', start_prompt: 'wait', request_id: 'peer' })
  const params = { text: 'local finding', request_id: 'finding' }
  const first = await work('findings.append', params)
  assert.deepEqual(await work('findings.append', params), first)
  const message = { to: 'W-0002', body: 'local peer message', request_id: 'message' }
  const sent = await work('peer.send', message)
  assert.deepEqual(await work('peer.send', message), sent)
  await callDaemon(infos[0], '/admin', 'task.command', { text: 'local input probe', request_id: 'command' })
  await until(async () => {
    const state = await loadState(paths[0])
    return state.commands.length === 1 && Object.values(state.commands[0].deliveries).every((d) => d.status === 'entered-context')
  })
  console.log('[pass] real fission, findings/message idempotency and command context receipts')
  // A benign echo listener opened inside the task, reached from the host.
  const source = "const s=require('net').createServer(c=>c.on('data',b=>c.end('echo:'+b)));s.listen(0,'0.0.0.0',()=>console.log(s.address().port))"
  listener = spawn('docker', ['exec', `liebian-${paths[0].taskId}`, 'node', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('listener startup timeout')), 10000)
    listener.stdout.once('data', (data) => { clearTimeout(timer); resolvePort(Number(data.toString().trim())) })
    listener.once('error', reject)
  })
  let echoed
  await until(async () => {
    try {
      echoed = await new Promise((resolveEcho, reject) => {
        const socket = connect({ port, host: '127.0.0.1' }, () => socket.write('host-callback'))
        socket.setTimeout(2000, () => socket.destroy(new Error('callback timeout')))
        let text = ''
        socket.on('data', (data) => { text += data })
        socket.on('end', () => resolveEcho(text))
        socket.on('error', reject)
      })
      return true
    } catch { return false }
  })
  assert.equal(echoed, 'echo:host-callback')
  console.log('[pass] task chooses its own listener port, host connects without port publishing')
  for (const path of paths) assert.equal(await stopDockerTask(path, 'smoke complete'), true)
  assert.equal(Object.keys((await readTasksCompose()).services).length, 0)
  console.log('[pass] stop commits state and removes task containers/services')
  const diagnostics = (await readFile(join(paths[0].logsDir, 'diagnostics.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const finished = diagnostics.filter((event) => event.event === 'model-finished')
  assert.ok(finished.length > 0)
  assert.ok(finished.every((event) => event.data.generation > 0 && event.data.runId && event.data.metrics.usage.inputTokens >= 0))
  assert.ok(finished.some((event) => event.data.metrics.firstTextMs >= 0))
  assert.ok(diagnostics.some((event) => event.event === 'runtime-sample' && event.data.processes?.some((worker) => worker.rssKiB > 0)))
  assert.ok(diagnostics.every((event) => event.dropped === 0 && event.failedWrites === 0))
  console.log('[pass] real harness diagnostics: request identity, usage, latency, worker memory and zero dropped records')
  const failed = makeTaskPaths(tasksRoot, `T-start-failure-${Date.now()}`)
  paths.push(failed)
  await createTask(failed, { startInformation: 'local failure probe', endInformation: 'wait' })
  process.env.LIEBIAN_API_PORT_RANGE = 'invalid-port'
  await assert.rejects(startDockerTask(failed), { code: 'TASK_START_FAILED' })
  assert.equal((await loadState(failed)).status, 'active')
  assert.equal(Object.keys((await readTasksCompose()).services).length, 0)
  process.env.LIEBIAN_API_PORT_RANGE = '44388-44487'
  assert.ok((await startDockerTask(failed)).pid > 0)
  assert.equal(await stopDockerTask(failed, 'retry verified'), true)
  console.log('[pass] failed startup is reported, cleaned up and retryable on the same task')
} finally {
  await exec('docker', ['compose', '-p', project, '-f', composeFile, 'down', '--remove-orphans'], { windowsHide: true }).catch(() => {})
  for (const path of paths) await exec('docker', ['rm', '-f', `liebian-${path.taskId}`], { windowsHide: true }).catch(() => {})
  listener?.kill()
  model.closeAllConnections()
  model.close()
  if (process.env.KEEP_PROBE === '1') console.log(`[kept] ${root}`)
  else {
    assert.ok(!relative(resolve(scratch), resolve(root)).startsWith('..'))
    await rm(root, { recursive: true, force: true })
  }
}
