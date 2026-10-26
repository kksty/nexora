import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeDaemonInfo } from '../src/core/daemon.ts'
import { Engine } from '../src/core/engine.ts'
import { loadState } from '../src/core/state.ts'
import { makeTaskPaths, type TaskPaths } from '../src/core/paths.ts'
import { nullLogger } from '../src/util/log.ts'
import { startWebServer, type WebServer } from '../src/web/server.ts'
import { startTaskRun } from '../src/web/task-service.ts'
import { FakeDriver } from './support/fake-driver.ts'

const TOKEN = 'test-web-token-7f1c'

interface WebHarness {
  root: string
  tasksRoot: string
  server: WebServer
}

async function createWebHarness(t: test.TestContext): Promise<WebHarness> {
  // Keep test data in the repository, alongside the other host-side data.
  const testRoot = fileURLToPath(new URL('../.scratch', import.meta.url))
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, 'liebian-web-'))
  const tasksRoot = join(root, 'tasks')
  const server = await startWebServer({ tasksRoot, logger: nullLogger, port: 0, token: TOKEN, tickMs: 100 })
  t.after(async () => {
    await server.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })
  return { root, tasksRoot, server }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-liebian-web-token': TOKEN, ...extra }
}

async function post(
  server: WebServer,
  path: string,
  body: unknown,
  options: { csrf?: boolean; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; cookie: string | null }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.csrf === false ? {} : { 'x-liebian-web': '1' }),
      ...authHeaders(options.headers),
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    body: (await response.json()) as any,
    cookie: response.headers.get('set-cookie'),
  }
}

async function del(server: WebServer, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'DELETE',
    headers: { 'x-liebian-web': '1', ...authHeaders() },
  })
  return { status: response.status, body: (await response.json()) as any }
}

/** POST with full header control, including a Host header a browser could send. */
function postWithHost(
  server: WebServer,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-liebian-web': '1',
          'x-liebian-web-token': TOKEN,
          ...headers,
        },
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (text += chunk))
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) })
        })
      },
    )
    request.on('error', reject)
    request.end(payload)
  })
}

async function createTask(server: WebServer, start = '起始信息：测试 Web UI。', end = '终点信息：完成 Web UI 验证。') {
  const created = await post(server, '/api/tasks', { start, end, autoStart: false })
  assert.equal(created.status, 200)
  assert.equal(created.body.ok, true)
  return created.body.taskId as string
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  timeoutMs = 4_000,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
      ),
    ])
    if (result.done) break
    text += decoder.decode(result.value, { stream: true })
    if (text.includes(marker)) return text
  }
  throw new Error(`SSE 等待 ${marker} 超时，已收到：${text}`)
}

async function startFakeDaemon(
  t: test.TestContext,
  taskId: string,
  blockers: string[],
): Promise<{ url: string; token: string; ops: string[] }> {
  const ops: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, taskId, status: 'active' }))
      return
    }
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      let payload: { op?: string } = {}
      try {
        payload = JSON.parse(body) as { op?: string }
      } catch {
        // The fake daemon only needs the operation name.
      }
      if (typeof payload.op === 'string') ops.push(payload.op)
      response.writeHead(200, { 'content-type': 'application/json' })
      if (payload.op === 'task.status') {
        response.end(
          JSON.stringify({ ok: true, result: { text: '', task: {}, participants: [], blockers } }),
        )
      } else {
        response.end(JSON.stringify({ ok: true, result: { text: '在线管理操作成功' } }))
      }
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('假 daemon 无端口'))
        return
      }
      resolve(address.port)
    })
  })
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  return { url: `http://127.0.0.1:${port}`, token: 'fake-daemon-token', ops }
}

test('Web UI：令牌、静态页面、建任务与文件边界', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)

  const health = await fetch(`${server.url}/health`)
  assert.equal(health.status, 200)
  assert.equal(((await health.json()) as { ok?: boolean }).ok, true)

  const unauthorized = await fetch(`${server.url}/api/tasks`)
  assert.equal(unauthorized.status, 401)

  const loginRedirect = await fetch(`${server.url}/?token=${TOKEN}`, { redirect: 'manual' })
  assert.equal(loginRedirect.status, 303)
  assert.equal(loginRedirect.headers.get('location'), '/')
  assert.match(loginRedirect.headers.get('set-cookie') ?? '', /liebian_web=/)

  const index = await fetch(`${server.url}/`, { headers: authHeaders() })
  assert.equal(index.status, 200)
  assert.match(await index.text(), /Nexora/)
  assert.match(index.headers.get('content-security-policy') ?? '', /script-src 'self'/)

  const app = await fetch(`${server.url}/assets/app.js`)
  assert.equal(app.status, 200)
  assert.match(app.headers.get('content-type') ?? '', /javascript/)

  const noCsrf = await post(server, '/api/tasks', { start: 'a', end: 'b' }, { csrf: false })
  assert.equal(noCsrf.status, 403)
  assert.equal(noCsrf.body.error.code, 'CSRF_REQUIRED')

  const badOrigin = await post(server, '/api/tasks', { start: 'a', end: 'b' }, { headers: { origin: 'http://evil.test' } })
  assert.equal(badOrigin.status, 403)
  assert.equal(badOrigin.body.error.code, 'FORBIDDEN_ORIGIN')

  const taskId = await createTask(server)
  const paths = makeTaskPaths(tasksRoot, taskId)
  const state = await loadState(paths)
  assert.equal(state.status, 'active')
  assert.equal(state.startInformation, '起始信息：测试 Web UI。')
  assert.match(await readFile(paths.patchFile, 'utf8'), /mcp-liebian/)

  const list = await fetch(`${server.url}/api/tasks`, { headers: authHeaders() }).then((response) => response.json())
  assert.equal((list as any).tasks.length, 1)
  assert.equal((list as any).tasks[0].taskId, taskId)
  assert.equal((list as any).tasks[0].online, false)

  const detail = await fetch(`${server.url}/api/tasks/${taskId}`, { headers: authHeaders() }).then((response) =>
    response.json(),
  )
  assert.equal((detail as any).detail.summary.taskId, taskId)
  assert.equal((detail as any).detail.runtime.online, false)
  assert.ok((detail as any).detail.files.some((file: { path: string }) => file.path === 'task.md'))

  const taskFile = await fetch(`${server.url}/api/tasks/${taskId}/file?path=task.md`, {
    headers: authHeaders(),
  }).then((response) => response.json())
  assert.match((taskFile as any).file.text, new RegExp(taskId))

  for (const forbidden of ['runtime/state.json', 'runtime/daemon.json', '../state.json', 'runtime/sessions/x.jsonl']) {
    const response = await fetch(`${server.url}/api/tasks/${taskId}/file?path=${encodeURIComponent(forbidden)}`, {
      headers: authHeaders(),
    })
    assert.equal(response.status, 403, forbidden)
  }
})

test('Web UI：容器端口映射下的 Host/Origin 校验', async (t) => {
  const { server } = await createWebHarness(t)

  // The browser reaches a published host port that differs from the container
  // port; the Origin matches the Host header, so mutation is allowed.
  const mapped = await postWithHost(
    server,
    '/api/tasks',
    { start: '端口映射起始', end: '端口映射终点' },
    { host: 'localhost:8080', origin: 'http://localhost:8080' },
  )
  assert.equal(mapped.status, 200)
  assert.equal(mapped.body.ok, true)

  // A cross-site page cannot forge the Host header, so it stays rejected.
  const crossSite = await postWithHost(
    server,
    '/api/tasks',
    { start: 'a', end: 'b' },
    { host: 'localhost:8080', origin: 'http://evil.test:8080' },
  )
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.body.error.code, 'FORBIDDEN_ORIGIN')

  // Loopback on the listening port remains allowed without a Host match.
  const loopback = await postWithHost(
    server,
    '/api/tasks',
    { start: 'c', end: 'd' },
    { host: '127.0.0.1:65500', origin: `http://127.0.0.1:${server.port}` },
  )
  assert.equal(loopback.status, 200)
})

test('Web UI：API 配置保存、清除且不回显 key', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)

  const initial = await fetch(`${server.url}/api/settings`, { headers: authHeaders() }).then((response) => response.json())
  assert.equal((initial as any).settings.apiKeySet, false)
  assert.equal((initial as any).settings.provider, 'deepseek-official')
  assert.equal((initial as any).settings.model, 'deepseek-flash')
  assert.equal((initial as any).settings.modelConcurrency, 4)

  const saved = await post(server, '/api/settings', {
    apiKey: 'sk-test-secret-123',
    provider: 'custom-provider',
    model: 'custom-model',
    baseUrl: 'https://example.test/v1',
    modelConcurrency: 6,
    modelMaxTokens: 4096,
    modelThinking: 'low',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.apiKeySet, true)
  assert.equal(saved.body.settings.provider, 'custom-provider')
  assert.equal(saved.body.settings.model, 'custom-model')
  assert.equal(saved.body.settings.baseUrl, 'https://example.test/v1')
  assert.equal(saved.body.settings.modelConcurrency, 6)
  assert.equal(saved.body.settings.modelMaxTokens, 4096)
  assert.equal(saved.body.settings.modelThinking, 'low')
  assert.equal(saved.body.settings.sources.modelMaxTokens, 'saved')
  assert.equal(saved.body.settings.sources.modelThinking, 'saved')
  assert.equal(Object.prototype.hasOwnProperty.call(saved.body.settings, 'apiKey'), false)

  const invalid = await post(server, '/api/settings', { modelConcurrency: 0 })
  assert.equal(invalid.body.ok, false)
  assert.equal(invalid.body.error?.code, 'INVALID_ARGUMENT')

  const persisted = JSON.parse(await readFile(join(tasksRoot, '.web-settings.json'), 'utf8')) as { apiKey: string }
  assert.equal(persisted.apiKey, 'sk-test-secret-123')

  const cleared = await post(server, '/api/settings', { clearApiKey: true, provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.settings.apiKeySet, false)
  const afterClear = JSON.parse(await readFile(join(tasksRoot, '.web-settings.json'), 'utf8')) as { apiKey: string }
  assert.equal(afterClear.apiKey, '')
})

test('Web UI：环境变量可配置任意 provider，且前端保存后覆盖它、删除后回退', async (t) => {
  const previous = {
    apiKey: process.env.LIEBIAN_API_KEY,
    legacyKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.LIEBIAN_BASE_URL,
    legacyBaseUrl: process.env.DEEPSEEK_BASE_URL,
    provider: process.env.LIEBIAN_PROVIDER,
    model: process.env.LIEBIAN_MODEL,
  }
  process.env.LIEBIAN_API_KEY = 'sk-env-gateway'
  process.env.LIEBIAN_BASE_URL = 'http://192.168.1.10:8080/v1'
  process.env.LIEBIAN_PROVIDER = 'pai'
  process.env.LIEBIAN_MODEL = 'qwen3.8-27b'
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_BASE_URL
  t.after(() => {
    for (const [key, value] of [
      ['LIEBIAN_API_KEY', previous.apiKey],
      ['DEEPSEEK_API_KEY', previous.legacyKey],
      ['LIEBIAN_BASE_URL', previous.baseUrl],
      ['DEEPSEEK_BASE_URL', previous.legacyBaseUrl],
      ['LIEBIAN_PROVIDER', previous.provider],
      ['LIEBIAN_MODEL', previous.model],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const { tasksRoot, server } = await createWebHarness(t)

  // 1. Nothing saved yet: every field is served straight from the environment,
  //    including a provider name the code has never heard of.
  const fromEnv = await fetch(`${server.url}/api/settings`, { headers: authHeaders() }).then((response) => response.json())
  assert.equal((fromEnv as any).settings.provider, 'pai')
  assert.equal((fromEnv as any).settings.model, 'qwen3.8-27b')
  assert.equal((fromEnv as any).settings.baseUrl, 'http://192.168.1.10:8080/v1')
  assert.equal((fromEnv as any).settings.apiKeySet, true)
  assert.equal((fromEnv as any).settings.apiKeySource, 'environment')
  assert.equal((fromEnv as any).settings.savedOverride, false)
  assert.equal((fromEnv as any).settings.sources.baseUrl, 'environment')

  // 2. Saving in the UI wins over the environment.
  const saved = await post(server, '/api/settings', {
    provider: 'openai-compatible',
    model: 'glm-5',
    baseUrl: 'http://10.0.0.5:8000/v1',
    apiKey: 'sk-ui-key',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.provider, 'openai-compatible')
  assert.equal(saved.body.settings.baseUrl, 'http://10.0.0.5:8000/v1')
  assert.equal(saved.body.settings.apiKeySource, 'saved')
  assert.equal(saved.body.settings.savedOverride, true)

  const afterSave = await fetch(`${server.url}/api/settings`, { headers: authHeaders() }).then((response) => response.json())
  assert.equal((afterSave as any).settings.baseUrl, 'http://10.0.0.5:8000/v1')
  assert.equal((afterSave as any).settings.model, 'glm-5')

  // 3. Deleting the saved override hands control back to the environment.
  const reset = await fetch(`${server.url}/api/settings`, {
    method: 'DELETE',
    headers: { ...authHeaders(), 'x-liebian-web': '1' },
  })
  assert.equal(reset.status, 200)
  const resetBody = (await reset.json()) as any
  assert.equal(resetBody.settings.provider, 'pai')
  assert.equal(resetBody.settings.baseUrl, 'http://192.168.1.10:8080/v1')
  assert.equal(resetBody.settings.savedOverride, false)
  await assert.rejects(readFile(join(tasksRoot, '.web-settings.json'), 'utf8'))
})

test('Web UI：保存的空值可以关闭环境变量提供的 Key 与 Base URL', async (t) => {
  const previousKey = process.env.LIEBIAN_API_KEY
  const previousBase = process.env.LIEBIAN_BASE_URL
  process.env.LIEBIAN_API_KEY = 'sk-env-only'
  process.env.LIEBIAN_BASE_URL = 'http://env.example/v1'
  t.after(() => {
    if (previousKey === undefined) delete process.env.LIEBIAN_API_KEY
    else process.env.LIEBIAN_API_KEY = previousKey
    if (previousBase === undefined) delete process.env.LIEBIAN_BASE_URL
    else process.env.LIEBIAN_BASE_URL = previousBase
  })

  const { server } = await createWebHarness(t)
  const saved = await post(server, '/api/settings', { clearApiKey: true, baseUrl: '', provider: 'pai', model: 'm' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.apiKeySet, false)
  assert.equal(saved.body.settings.apiKeySource, 'none')
  assert.equal(saved.body.settings.baseUrl, '')
})

test('Web UI：获取模型列表并检测模型连通性', async (t) => {
  const { server } = await createWebHarness(t)
  const seen: string[] = []
  const fake = createServer((request, response) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`)
    response.writeHead(200, { 'content-type': 'application/json' })
    if ((request.url ?? '').endsWith('/models')) {
      response.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }))
    } else {
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
    }
  })
  const port = await new Promise<number>((resolve, reject) => {
    fake.once('error', reject)
    fake.listen(0, '127.0.0.1', () => {
      const address = fake.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('fake model server has no port'))
        return
      }
      resolve(address.port)
    })
  })
  t.after(
    () =>
      new Promise<void>((resolve) => {
        fake.close(() => resolve())
        fake.closeAllConnections()
      }),
  )
  const url = `http://127.0.0.1:${port}`

  const models = await post(server, '/api/settings/models', { apiKey: 'sk-test', baseUrl: `${url}/v1` })
  assert.equal(models.status, 200)
  assert.deepEqual(models.body.result.models, ['deepseek-chat', 'deepseek-reasoner'])

  const probe = await post(server, '/api/settings/test', {
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    baseUrl: `${url}/v1`,
  })
  assert.equal(probe.status, 200)
  assert.equal(probe.body.result.success, true)
  assert.equal(probe.body.result.reply, 'OK')

  const noCsrf = await post(server, '/api/settings/models', { baseUrl: url }, { csrf: false })
  assert.equal(noCsrf.status, 403)
  assert.ok(seen.some((entry) => entry.endsWith('/v1/models')))
})

test('Web UI：删除任务目录，运行中拒绝', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)
  const taskId = await createTask(server)
  const paths = makeTaskPaths(tasksRoot, taskId)
  const fake = await startFakeDaemon(t, taskId, [])
  await writeDaemonInfo(paths, { url: fake.url, token: fake.token, pid: 4321, taskId })

  const refused = await del(server, `/api/tasks/${taskId}`)
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'TASK_RUNNING')

  await rm(paths.daemonFile, { force: true })
  const deleted = await del(server, `/api/tasks/${taskId}`)
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.ok, true)
  await assert.rejects(readFile(paths.stateFile, 'utf8'))
  const list = await fetch(`${server.url}/api/tasks`, { headers: authHeaders() }).then((response) => response.json())
  assert.equal((list as any).tasks.length, 0)
})

test('Web UI：运行时在线时读取 daemon 阻塞项并走管理 API', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)
  const taskId = await createTask(server)
  const paths = makeTaskPaths(tasksRoot, taskId)
  const fake = await startFakeDaemon(t, taskId, ['尚未明确同意：W-0001'])
  await writeDaemonInfo(paths, {
    url: fake.url,
    token: fake.token,
    pid: 4321,
    taskId,
  })

  const detail = await fetch(`${server.url}/api/tasks/${taskId}`, { headers: authHeaders() }).then((response) =>
    response.json(),
  )
  assert.equal((detail as any).detail.runtime.online, true)
  assert.equal((detail as any).detail.runtime.pid, 4321)
  assert.deepEqual((detail as any).detail.runtime.blockers, ['尚未明确同意：W-0001'])
  assert.deepEqual((detail as any).detail.runtime.participants, [])

  const end = await post(server, `/api/tasks/${taskId}/end-info`, { text: '在线更新的终点' })
  assert.equal(end.status, 200)
  assert.equal(end.body.result.text, '在线管理操作成功')
  assert.equal(end.body.result.online, true)

  const stop = await post(server, `/api/tasks/${taskId}/stop`, { reason: '在线停止' })
  assert.equal(stop.status, 200)
  assert.equal(stop.body.result.online, true)
  assert.ok(fake.ops.includes('task.set_end'))
  assert.ok(fake.ops.includes('task.stop'))
})

test('Web UI：daemon 健康但管理调用断链时回退离线停止', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)
  const taskId = await createTask(server)
  const paths = makeTaskPaths(tasksRoot, taskId)
  const fake = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, taskId, status: 'active' }))
      return
    }
    // The daemon died between the health probe and the admin call.
    request.socket.destroy()
  })
  const port = await new Promise<number>((resolve, reject) => {
    fake.once('error', reject)
    fake.listen(0, '127.0.0.1', () => {
      const address = fake.address()
      if (address === null || typeof address === 'string') reject(new Error('假 daemon 无端口'))
      else resolve(address.port)
    })
  })
  t.after(
    () =>
      new Promise<void>((resolve) => {
        fake.close(() => resolve())
        fake.closeAllConnections()
      }),
  )
  await writeDaemonInfo(paths, { url: `http://127.0.0.1:${port}`, token: 'x', pid: 999, taskId })

  const stop = await post(server, `/api/tasks/${taskId}/stop`, { reason: '断链后离线停止' })
  assert.equal(stop.status, 200)
  assert.equal(stop.body.ok, true)
  assert.equal(stop.body.result.online, false)
  const state = await loadState(paths)
  assert.equal(state.status, 'stopped')
  assert.equal(state.statusReason, '断链后离线停止')
})

test('Web UI：离线修改起始/终点、停止任务与证据读取', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)
  const taskId = await createTask(server)
  const paths: TaskPaths = makeTaskPaths(tasksRoot, taskId)

  const end = await post(server, `/api/tasks/${taskId}/end-info`, { text: '终点信息：第二版目标。' })
  assert.equal(end.status, 200)
  assert.equal(end.body.result.online, false)
  let state = await loadState(paths)
  assert.equal(state.targetVersion, 2)
  assert.equal(state.endInformation, '终点信息：第二版目标。')

  const start = await post(server, `/api/tasks/${taskId}/start-info`, { text: '起始信息：第二版起始。' })
  assert.equal(start.status, 200)
  state = await loadState(paths)
  assert.equal(state.startHistory.at(-1)?.text, '起始信息：第二版起始。')

  await writeFile(join(paths.evidenceDir, 'proof.txt'), 'raw evidence body\n', 'utf8')
  const evidence = await fetch(`${server.url}/api/tasks/${taskId}/file?path=evidence/proof.txt`, {
    headers: authHeaders(),
  }).then((response) => response.json())
  assert.equal((evidence as any).file.text, 'raw evidence body\n')

  const stop = await post(server, `/api/tasks/${taskId}/stop`, { reason: '测试停止' })
  assert.equal(stop.status, 200)
  assert.equal(stop.body.result.online, false)
  state = await loadState(paths)
  assert.equal(state.status, 'stopped')
  assert.equal(state.statusReason, '测试停止')

  const run = await post(server, `/api/tasks/${taskId}/run`, {})
  assert.equal(run.status, 400)
  assert.equal(run.body.error.code, 'TASK_NOT_ACTIVE')

  const detail = await fetch(`${server.url}/api/tasks/${taskId}`, { headers: authHeaders() }).then((response) =>
    response.json(),
  )
  assert.equal((detail as any).detail.summary.status, 'stopped')
})

test('Web UI：任务只能由 Docker Compose 启动', async (t) => {
  const { server, tasksRoot } = await createWebHarness(t)
  const taskId = await createTask(server)
  const previous = process.env.LIEBIAN_WEB_LAUNCHER
  delete process.env.LIEBIAN_WEB_LAUNCHER
  try {
    await assert.rejects(
      startTaskRun({ tasksRoot, taskId, logger: nullLogger }),
      (error: unknown) =>
        error instanceof Error && (error as Error & { code?: string }).code === 'COMPOSE_REQUIRED',
    )
  } finally {
    if (previous !== undefined) process.env.LIEBIAN_WEB_LAUNCHER = previous
  }
})

test('Web UI：人工命令在运行时在线时经管理 API 提交，离线时拒绝且不写 state', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)
  const taskId = await createTask(server)
  const paths = makeTaskPaths(tasksRoot, taskId)

  // Offline: explicitly not saved, no state mutation.
  const offline = await post(server, `/api/tasks/${taskId}/command`, {
    text: '离线命令不应落盘',
    requestId: 'web-offline-1',
  })
  assert.equal(offline.status, 409)
  assert.equal(offline.body.error.code, 'RUNTIME_OFFLINE')
  assert.equal((await loadState(paths)).commands.length, 0)

  // Missing request id is rejected before reaching a runtime.
  const missingId = await post(server, `/api/tasks/${taskId}/command`, { text: '缺少 ID' })
  assert.equal(missingId.status, 400)
  assert.equal(missingId.body.error.code, 'INVALID_ARGUMENT')

  const fake = await startFakeDaemon(t, taskId, [])
  await writeDaemonInfo(paths, { url: fake.url, token: fake.token, pid: 4321, taskId })
  const online = await post(server, `/api/tasks/${taskId}/command`, {
    text: '在线命令',
    requestId: 'web-online-1',
  })
  assert.equal(online.status, 200)
  assert.equal(online.body.result.online, true)
  assert.match(online.body.result.text, /在线管理操作成功/)
  assert.ok(fake.ops.includes('task.command'))
})

test('Web UI：事件流在状态文件变化后推送 change', async (t) => {
  const { server } = await createWebHarness(t)
  const taskId = await createTask(server)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  t.after(() => {
    clearTimeout(timer)
    controller.abort()
  })
  const response = await fetch(`${server.url}/api/tasks/${taskId}/events`, {
    headers: authHeaders(),
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = response.body?.getReader()
  assert.ok(reader !== undefined)
  if (reader === undefined) return
  t.after(() => void reader.cancel().catch(() => undefined))

  const ready = await readUntil(reader, 'event: ready')
  assert.match(ready, /"revision"/)

  await post(server, `/api/tasks/${taskId}/end-info`, { text: '事件流触发的新终点。' })
  const changed = await readUntil(reader, 'event: change')
  assert.match(changed, /event: change/)
})

test('Web UI：登录表单设置 Cookie 并拒绝错误令牌', async (t) => {
  const { server } = await createWebHarness(t)

  const wrong = await fetch(`${server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'wrong' }),
  })
  assert.equal(wrong.status, 401)

  const good = await fetch(`${server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TOKEN }),
    redirect: 'manual',
  })
  assert.equal(good.status, 303)
  const cookie = good.headers.get('set-cookie') ?? ''
  assert.match(cookie, /liebian_web=/)
  assert.match(cookie, /HttpOnly/)

  const withCookie = await fetch(`${server.url}/api/tasks`, { headers: { cookie: cookie.split(';')[0] ?? '' } })
  assert.equal(withCookie.status, 200)
})

/** Finish a Web-created task with a real Engine + FakeDriver. */
async function finishTask(paths: TaskPaths): Promise<void> {
  const engine = await Engine.open({
    paths,
    driver: new FakeDriver(),
    logger: nullLogger,
    retry: { initialMs: 20, factor: 2, maxMs: 100, jitter: 0 },
  })
  await engine.start()
  await engine.whenQuiet()
  const proposal = await engine.proposeCompletion('W-0001', { reason: 'Web 测试完成' })
  await engine.respondCompletion('W-0001', { round_id: proposal.round.id, opinion: 'agree' })
  const deadline = Date.now() + 3_000
  while (engine.state.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await engine.close('web-test')
  assert.equal(engine.state.status, 'completed')
}

test('Web UI：已结束任务“继续并发送”创建新轮次且幂等', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)
  const taskId = await createTask(server)
  const paths = makeTaskPaths(tasksRoot, taskId)
  await finishTask(paths)

  const continued = await post(server, `/api/tasks/${taskId}/continue`, {
    text: '继续验证第二条路径。',
    requestId: 'web-continue-1',
  })
  assert.equal(continued.status, 200)
  assert.equal(continued.body.ok, true)
  assert.equal(continued.body.result.runId, 'R-0002')
  assert.equal(continued.body.result.workId, 'W-0002')
  assert.equal(continued.body.result.started, false)
  let state = await loadState(paths)
  assert.equal(state.status, 'active')
  assert.equal(state.currentRunId, 'R-0002')
  assert.equal(state.runs.length, 2)
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(state.completion, null)
  assert.equal(state.commands[0]?.text, '继续验证第二条路径。')
  assert.equal(state.works['W-0002']?.origin, 'continue')
  assert.equal(state.works['W-0001']?.runtimeStatus, 'finished')

  // Retrying the same request does not create another run.
  const replay = await post(server, `/api/tasks/${taskId}/continue`, {
    text: '继续验证第二条路径。',
    requestId: 'web-continue-1',
  })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.result.idempotent, true)
  assert.equal(replay.body.result.runId, 'R-0002')
  state = await loadState(paths)
  assert.equal(state.runs.length, 2)

  // Same request id with different text is a conflict.
  const conflict = await post(server, `/api/tasks/${taskId}/continue`, {
    text: '不同的指令',
    requestId: 'web-continue-1',
  })
  assert.equal(conflict.status, 400)
  assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT')

  // The task is active now: continue is rejected, sending a command is the way.
  const active = await post(server, `/api/tasks/${taskId}/continue`, {
    text: '第三条',
    requestId: 'web-continue-2',
  })
  assert.equal(active.status, 409)
  assert.equal(active.body.error.code, 'TASK_ACTIVE')

  // Missing request id is rejected before any state change.
  const missing = await post(server, `/api/tasks/${taskId}/continue`, { text: '缺少 ID' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'INVALID_ARGUMENT')
})

test('Web UI：已结束任务“继续”不开命令也能重启，且幂等', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)
  const taskId = await createTask(server)
  const paths = makeTaskPaths(tasksRoot, taskId)
  await finishTask(paths)

  const resumed = await post(server, `/api/tasks/${taskId}/resume`, { requestId: 'web-resume-1' })
  assert.equal(resumed.status, 200)
  assert.equal(resumed.body.ok, true)
  assert.equal(resumed.body.result.runId, 'R-0002')
  assert.equal(resumed.body.result.workId, 'W-0002')
  let state = await loadState(paths)
  assert.equal(state.status, 'active')
  assert.equal(state.currentRunId, 'R-0002')
  // No command is recorded: the executor resumes from shared state alone.
  assert.equal(state.commands.length, 0)
  assert.equal(state.runs[1]?.resumeRequestId, 'web-resume-1')
  assert.equal(state.runs[1]?.commandIds.length, 0)
  assert.equal(state.works['W-0002']?.origin, 'continue')

  const replay = await post(server, `/api/tasks/${taskId}/resume`, { requestId: 'web-resume-1' })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.result.idempotent, true)
  state = await loadState(paths)
  assert.equal(state.runs.length, 2)

  // An active task must not be reopened a second time.
  const active = await post(server, `/api/tasks/${taskId}/resume`, { requestId: 'web-resume-2' })
  assert.equal(active.status, 409)
  assert.equal(active.body.error.code, 'TASK_ACTIVE')

  const missing = await post(server, `/api/tasks/${taskId}/resume`, {})
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'INVALID_ARGUMENT')
})

test('Web UI：active 且无参与 work 时“恢复工作”创建承接 work', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)
  const taskId = await createTask(server)
  const paths = makeTaskPaths(tasksRoot, taskId)
  const engine = await Engine.open({
    paths,
    driver: new FakeDriver(),
    logger: nullLogger,
    retry: { initialMs: 20, factor: 2, maxMs: 100, jitter: 0 },
  })
  await engine.start()
  await engine.whenQuiet()
  await engine.retireWork('W-0001', { reason: '让出方向后退出' })
  await engine.close('leave-empty')

  const stateBefore = await loadState(paths)
  assert.equal(stateBefore.status, 'active')
  assert.equal(
    Object.values(stateBefore.works).filter(
      (work) => work.runtimeStatus !== 'exited' && work.runtimeStatus !== 'finished',
    ).length,
    0,
  )

  const recovered = await post(server, `/api/tasks/${taskId}/recover`, { requestId: 'web-recover-1' })
  assert.equal(recovered.status, 200)
  assert.equal(recovered.body.result.created, true)
  assert.equal(recovered.body.result.workId, 'W-0002')
  assert.equal(recovered.body.result.runId, 'R-0001')
  const state = await loadState(paths)
  assert.equal(state.status, 'active')
  assert.equal(state.runs.length, 1)
  assert.equal(state.works['W-0002']?.origin, 'recover')

  // A second click is idempotent: participants exist, so nothing is created.
  const again = await post(server, `/api/tasks/${taskId}/recover`, { requestId: 'web-recover-2' })
  assert.equal(again.status, 200)
  assert.equal(again.body.result.created, false)
  assert.equal(Object.keys((await loadState(paths)).works).length, 2)
})

test('Web UI：离线编辑取得并释放任务写入所有权', async (t) => {
  const { tasksRoot, server } = await createWebHarness(t)
  const taskId = await createTask(server)
  const paths = makeTaskPaths(tasksRoot, taskId)
  const response = await post(server, `/api/tasks/${taskId}/end-info`, { text: '所有权测试终点' })
  assert.equal(response.status, 200)
  assert.equal((await loadState(paths)).targetVersion, 2)
  assert.equal(await readFile(paths.ownerFile, 'utf8').catch(() => null), null)
})
