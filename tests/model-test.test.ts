import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chatCompletionsUrl, listModelConfig, modelsUrl, parseVllmMaxModelLen, resolveModelConfig, testModelConfig, vllmMetricsUrl } from '../src/web/model-test.ts'
import { effectiveWebSettings } from '../src/web/settings.ts'

interface ModelRequest {
  authorization: string | undefined
  body: any
}

async function startModelServer(
  t: test.TestContext,
  responder: (request: ModelRequest) => { status: number; body: unknown },
): Promise<{ url: string; requests: ModelRequest[] }> {
  const requests: ModelRequest[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (raw += chunk))
    request.on('end', () => {
      let body: unknown = null
      try {
        body = JSON.parse(raw)
      } catch {
        // The probe always sends JSON; keep the test server tolerant.
      }
      const entry: ModelRequest = { authorization: request.headers.authorization, body }
      requests.push(entry)
      const result = responder(entry)
      response.writeHead(result.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result.body))
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
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
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  return { url: `http://127.0.0.1:${port}`, requests }
}

async function createTasksRoot(t: test.TestContext): Promise<string> {
  const base = fileURLToPath(new URL('../.scratch', import.meta.url))
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'liebian-model-'))
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined))
  return root
}

test('模型检测：成功时返回延迟、回复并发送最小请求', async (t) => {
  const fake = await startModelServer(t, () => ({
    status: 200,
    body: { choices: [{ message: { content: 'OK' } }] },
  }))
  const tasksRoot = await createTasksRoot(t)

  const result = await testModelConfig(tasksRoot, {
    apiKey: 'sk-test-secret',
    modelApiProtocol: 'openai-compatible',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    baseUrl: `${fake.url}/v1/`,
  })

  assert.equal(result.success, true)
  assert.equal(result.reply, 'OK')
  assert.equal(result.endpoint, `${fake.url}/v1/chat/completions`)
  assert.equal(result.apiKeySource, 'request')
  assert.ok(result.latencyMs >= 0)
  assert.match(result.message, /连接成功/)
  assert.equal(fake.requests.length, 1)
  assert.equal(fake.requests[0]?.authorization, 'Bearer sk-test-secret')
  assert.equal(fake.requests[0]?.body.model, 'deepseek-chat')
  assert.equal(fake.requests[0]?.body.stream, false)
  assert.equal(fake.requests[0]?.body.max_tokens, 8)
})

test('模型检测：HTTP 错误保留服务端原因且不回显 key', async (t) => {
  const fake = await startModelServer(t, () => ({
    status: 401,
    body: { error: { message: 'invalid api key' } },
  }))
  const tasksRoot = await createTasksRoot(t)

  const result = await testModelConfig(tasksRoot, {
    apiKey: 'sk-super-secret-value',
    modelApiProtocol: 'openai-compatible',
    model: 'deepseek-chat',
    baseUrl: fake.url,
  })

  assert.equal(result.success, false)
  assert.equal(result.status, 401)
  assert.match(result.message, /HTTP 401/)
  assert.match(result.message, /invalid api key/)
  assert.equal(JSON.stringify(result).includes('sk-super-secret-value'), false)
})

test('模型检测：缺少 key 或自定义 provider 缺少 Base URL 时给出明确提示', async (t) => {
  const tasksRoot = await createTasksRoot(t)
  const previousKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  try {
    const missing = await testModelConfig(tasksRoot, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.equal(missing.success, false)
    assert.equal(missing.apiKeySource, 'none')
    assert.match(missing.message, /API Key/)
  } finally {
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
  }

  const custom = await testModelConfig(tasksRoot, {
    apiKey: 'sk-test',
    modelApiProtocol: 'openai-compatible',
    provider: 'custom-provider',
    model: 'custom-model',
  })
  assert.equal(custom.success, false)
  assert.match(custom.message, /Base URL/)
})

test('模型检测：非 deepseek-official 的 provider 只要配了 Base URL 就可用，且已保存配置覆盖环境变量', async (t) => {
  const fake = await startModelServer(t, () => ({
    status: 200,
    body: { choices: [{ message: { content: 'gateway-ok' } }] },
  }))
  const tasksRoot = await createTasksRoot(t)
  const previous = {
    provider: process.env.LIEBIAN_PROVIDER,
    model: process.env.LIEBIAN_MODEL,
    baseUrl: process.env.LIEBIAN_BASE_URL,
    apiKey: process.env.LIEBIAN_API_KEY,
  }
  process.env.LIEBIAN_PROVIDER = 'pai'
  process.env.LIEBIAN_MODEL = 'qwen3.8-27b'
  process.env.LIEBIAN_BASE_URL = 'http://env.invalid/v1'
  process.env.LIEBIAN_API_KEY = 'sk-env'
  t.after(() => {
    for (const [key, value] of [
      ['LIEBIAN_PROVIDER', previous.provider],
      ['LIEBIAN_MODEL', previous.model],
      ['LIEBIAN_BASE_URL', previous.baseUrl],
      ['LIEBIAN_API_KEY', previous.apiKey],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  // Environment-only: an arbitrary provider name resolves as long as a Base URL
  // exists, and it is used instead of the built-in DeepSeek endpoint.
  const fromEnv = await resolveModelConfig(tasksRoot, {})
  assert.equal(fromEnv.ok, true)
  assert.equal(fromEnv.ok && fromEnv.config.provider, 'pai')
  assert.equal(fromEnv.ok && fromEnv.config.model, 'qwen3.8-27b')
  assert.equal(fromEnv.ok && fromEnv.config.baseUrl, 'http://env.invalid/v1')

  // Saved settings (the Web UI) win over the environment for every field.
  await writeFile(
    join(tasksRoot, '.web-settings.json'),
    JSON.stringify({
      apiKey: 'sk-saved',
      modelApiProtocol: 'openai-compatible',
      provider: 'custom-gateway',
      model: 'glm-5',
      baseUrl: fake.url,
      modelConcurrency: 4,
    }),
    'utf8',
  )
  const fromSaved = await resolveModelConfig(tasksRoot, {})
  assert.equal(fromSaved.ok, true)
  assert.equal(fromSaved.ok && fromSaved.config.provider, 'custom-gateway')
  assert.equal(fromSaved.ok && fromSaved.config.model, 'glm-5')
  assert.equal(fromSaved.ok && fromSaved.config.baseUrl, fake.url)

  const result = await testModelConfig(tasksRoot, {})
  assert.equal(result.success, true)
  assert.equal(result.reply, 'gateway-ok')
  assert.equal(fake.requests[0]?.authorization, 'Bearer sk-saved')
})

test('模型检测：未填写的字段回退到已保存配置', async (t) => {
  const fake = await startModelServer(t, () => ({
    status: 200,
    body: { choices: [{ message: { content: 'saved-ok' } }] },
  }))
  const tasksRoot = await createTasksRoot(t)
  await writeFile(
    join(tasksRoot, '.web-settings.json'),
    JSON.stringify({
      apiKey: 'sk-saved-key',
      modelApiProtocol: 'openai-compatible',
      provider: 'deepseek-official',
      model: 'saved-model',
      baseUrl: fake.url,
      modelConcurrency: 4,
    }),
    'utf8',
  )

  const result = await testModelConfig(tasksRoot, {})
  assert.equal(result.success, true)
  assert.equal(result.apiKeySource, 'saved')
  assert.equal(result.reply, 'saved-ok')
  assert.equal(fake.requests[0]?.body.model, 'saved-model')
  assert.equal(fake.requests[0]?.authorization, 'Bearer sk-saved-key')
})

test('模型检测：Base URL 归一化为 chat/completions 端点', () => {
  assert.equal(chatCompletionsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions')
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions')
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(chatCompletionsUrl('https://proxy.test/v1/'), 'https://proxy.test/v1/chat/completions')
  assert.equal(
    chatCompletionsUrl('https://proxy.test/chat/completions'),
    'https://proxy.test/chat/completions',
  )
})

test('模型列表：获取、去重并排序可用模型', async (t) => {
  const fake = await startModelServer(t, () => ({
    status: 200,
    body: {
      data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }, { id: 'deepseek-chat' }, { id: '  ' }],
    },
  }))
  const tasksRoot = await createTasksRoot(t)

  const result = await listModelConfig(tasksRoot, {
    apiKey: 'sk-list-secret',
    modelApiProtocol: 'openai-compatible',
    provider: 'deepseek-official',
    baseUrl: `${fake.url}/v1/`,
  })

  assert.equal(result.success, true)
  assert.deepEqual(result.models, ['deepseek-chat', 'deepseek-reasoner'])
  assert.equal(result.endpoint, `${fake.url}/v1/models`)
  assert.equal(result.apiKeySource, 'request')
  assert.match(result.message, /2 个可用模型/)
  assert.equal(fake.requests[0]?.authorization, 'Bearer sk-list-secret')
})

test('模型列表：接口不支持或返回空列表时提示手动填写', async (t) => {
  const notFound = await startModelServer(t, () => ({
    status: 404,
    body: { error: { message: 'Not Found' } },
  }))
  const tasksRoot = await createTasksRoot(t)
  const missing = await listModelConfig(tasksRoot, { apiKey: 'sk-test', modelApiProtocol: 'openai-compatible', baseUrl: notFound.url })
  assert.equal(missing.success, false)
  assert.equal(missing.models.length, 0)
  assert.match(missing.message, /手动填写/)

  const emptyServer = await startModelServer(t, () => ({ status: 200, body: { data: [] } }))
  const empty = await listModelConfig(tasksRoot, { apiKey: 'sk-test', modelApiProtocol: 'openai-compatible', baseUrl: emptyServer.url })
  assert.equal(empty.success, true)
  assert.deepEqual(empty.models, [])
  assert.match(empty.message, /手动填写/)
})

test('模型列表：Base URL 归一化为 models 端点', () => {
  assert.equal(modelsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/models')
  assert.equal(modelsUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/models')
  assert.equal(modelsUrl('https://proxy.test/chat/completions'), 'https://proxy.test/models')
  assert.equal(modelsUrl('https://proxy.test/v1/models'), 'https://proxy.test/v1/models')
})

test('vLLM context discovery only trusts cache_config_info max_model_len', async (t) => {
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(request.url ?? '')
    if (request.url === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('# HELP vllm:cache_config_info Cache configuration\nvllm:cache_config_info{gpu_cache_size="1",max_model_len="65536"} 1\n')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: 'metrics-ok' } }] }))
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('metrics server has no address'))
      resolve(address.port)
    })
  })
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  const tasksRoot = await createTasksRoot(t)
  const result = await testModelConfig(tasksRoot, {
    modelApiProtocol: 'openai-compatible',
    modelThinkingAdapter: 'vllm',
    apiKey: '',
    provider: 'local-vllm',
    model: 'qwen-custom-id',
    baseUrl: `http://127.0.0.1:${port}/v1`,
  })
  assert.equal(result.success, true)
  assert.equal(result.contextWindow.contextWindowEffective, 65_536)
  assert.equal(result.contextWindow.contextWindowSource, 'server-metrics')
  assert.equal(result.contextWindow.contextWindowKnown, true)
  assert.deepEqual(seen, ['/metrics', '/v1/chat/completions'])
  assert.equal(vllmMetricsUrl(`http://127.0.0.1:${port}/v1/`), `http://127.0.0.1:${port}/metrics`)
  assert.equal(parseVllmMaxModelLen('vllm:other_metric{max_model_len="123"} 1\n'), null)
  assert.equal(parseVllmMaxModelLen('vllm:cache_config_info{max_model_len="32768"} 1\n'), 32_768)
})

test('API 配置：未保存时回退到 LIEBIAN_PROVIDER / LIEBIAN_MODEL 环境变量', async (t) => {
  const tasksRoot = await createTasksRoot(t)
  const previous = {
    provider: process.env.LIEBIAN_PROVIDER,
    model: process.env.LIEBIAN_MODEL,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
  }
  process.env.LIEBIAN_PROVIDER = 'env-provider'
  process.env.LIEBIAN_MODEL = 'env-model'
  process.env.DEEPSEEK_BASE_URL = 'https://env.example/v1'
  t.after(() => {
    for (const [key, value] of [
      ['LIEBIAN_PROVIDER', previous.provider],
      ['LIEBIAN_MODEL', previous.model],
      ['DEEPSEEK_BASE_URL', previous.baseUrl],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const settings = await effectiveWebSettings(tasksRoot)
  assert.equal(settings.provider, 'env-provider')
  assert.equal(settings.model, 'env-model')
  assert.equal(settings.baseUrl, 'https://env.example/v1')
  const resolved = await resolveModelConfig(tasksRoot, { apiKey: 'sk-env' })
  assert.equal(resolved.config.provider, 'env-provider')
  assert.equal(resolved.config.model, 'env-model')
})

test('API 配置：损坏设置文件与非法数值不会伪装成环境来源', async (t) => {
  const tasksRoot = await createTasksRoot(t)
  const previous = {
    concurrency: process.env.LIEBIAN_MODEL_CONCURRENCY,
    tokens: process.env.LIEBIAN_MODEL_MAX_TOKENS,
    thinking: process.env.LIEBIAN_MODEL_THINKING,
  }
  process.env.LIEBIAN_MODEL_CONCURRENCY = '0'
  process.env.LIEBIAN_MODEL_MAX_TOKENS = 'abc'
  process.env.LIEBIAN_MODEL_THINKING = 'turbo'
  t.after(() => {
    for (const [key, value] of [
      ['LIEBIAN_MODEL_CONCURRENCY', previous.concurrency],
      ['LIEBIAN_MODEL_MAX_TOKENS', previous.tokens],
      ['LIEBIAN_MODEL_THINKING', previous.thinking],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const settings = await effectiveWebSettings(tasksRoot)
  assert.equal(settings.modelConcurrency, 2)
  assert.equal(settings.modelMaxTokens, 6_144)
  assert.equal(settings.modelThinking, 'high')

  await writeFile(join(tasksRoot, '.web-settings.json'), '{bad json', 'utf8')
  const { resolved } = await import('../src/web/settings.ts').then(async (module) => ({
    resolved: await module.resolveWebSettings(tasksRoot),
  }))
  assert.equal(resolved.savedInvalid, true)
  assert.equal(resolved.savedOverride, true)
})
