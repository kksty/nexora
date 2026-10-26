import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { apply } from '../src/harness/openai-compatible.ts'

type RequestRecord = { authorization: string | undefined; body: any }

async function startSseServer(t: test.TestContext): Promise<{ url: string; requests: RequestRecord[] }> {
  const requests: RequestRecord[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (raw += chunk))
    request.on('end', () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(raw),
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(requests.length === 1
        ? [
          'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\": "}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ].join('')
        : [
          'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''))
      response.end()
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('fake server has no address'))
      resolve(address.port)
    })
  })
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  return { url: `http://127.0.0.1:${port}`, requests }
}

function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function fakeContext(): { adapter: any; dispose: () => void } {
  let adapter: any
  let disposer: (() => void) | undefined
  const context = {
    llm: {
      registerAdapter(_providers: string[], value: any) {
        adapter = value
        const handle: any = () => undefined
        disposer = handle
        return handle
      },
    },
    effect(callback: () => (() => void) | void) {
      callback()
    },
  }
  apply(context as any)
  assert.ok(adapter)
  return { adapter, dispose: () => disposer?.() }
}

function options(messages: any[] = [], model = 'custom-qwen-model-id'): any {
  return {
    provider: 'liebian-openai-compatible',
    model,
    messages,
    tools: [{ name: 'lookup', description: 'look up a value', parameters: { type: 'object' } }],
    reasoningEffort: 'high',
  }
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('OpenAI-compatible adapter supports keyless SSE tool loop and preserves block contents', async (t) => {
  const fake = await startSseServer(t)
  const restore = withEnv({
    LIEBIAN_BASE_URL: `${fake.url}/v1`,
    LIEBIAN_API_KEY: '',
    LIEBIAN_MODEL: 'custom-qwen-model-id',
    LIEBIAN_MODEL_CONTEXT_WINDOW: '64000',
    LIEBIAN_MODEL_MAX_TOKENS: '6144',
    LIEBIAN_MODEL_THINKING_ADAPTER: 'none',
  })
  t.after(restore)
  const runtime = fakeContext()
  t.after(runtime.dispose)

  const first = await collect(runtime.adapter.stream(options([
    { role: 'user', content: [{ type: 'text', text: 'find it' }] },
  ])))
  assert.equal(fake.requests.length, 1)
  assert.equal(fake.requests[0]?.authorization, undefined)
  assert.equal(fake.requests[0]?.body.model, 'custom-qwen-model-id')
  assert.equal(fake.requests[0]?.body.stream, true)
  assert.equal(fake.requests[0]?.body.tools[0].function.name, 'lookup')
  assert.equal(first.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')?.block.text, 'think ')
  assert.equal(first.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')?.block.text, 'hello')
  const tool = first.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.deepEqual(tool?.block, { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"q": "x"}' })
  assert.deepEqual(first.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })

  const second = await collect(runtime.adapter.stream(options([
    { role: 'user', content: [{ type: 'text', text: 'find it' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"q": "x"}' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'result-value' }] },
  ])))
  assert.equal(fake.requests.length, 2)
  assert.equal(fake.requests[1]?.authorization, undefined)
  assert.deepEqual(fake.requests[1]?.body.messages.at(-2), {
    role: 'assistant',
    content: 'hello',
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q": "x"}' } }],
  })
  assert.deepEqual(fake.requests[1]?.body.messages.at(-1), { role: 'tool', tool_call_id: 'call-1', content: 'result-value' })
  assert.equal(second.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')?.block.text, 'done')
})

test('OpenAI-compatible adapter sends only the configured Bearer key', async (t) => {
  const fake = await startSseServer(t)
  const restore = withEnv({ LIEBIAN_BASE_URL: fake.url, LIEBIAN_API_KEY: 'configured-key', LIEBIAN_MODEL: 'arbitrary-id' })
  t.after(restore)
  const runtime = fakeContext()
  t.after(runtime.dispose)
  await collect(runtime.adapter.stream(options([], 'arbitrary-id')))
  assert.equal(fake.requests[0]?.authorization, 'Bearer configured-key')
  assert.equal(fake.requests[0]?.body.model, 'arbitrary-id')
})
