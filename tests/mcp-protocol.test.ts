import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const MCP_ENTRY = fileURLToPath(new URL('../src/mcp/main.ts', import.meta.url))

interface Bridge {
  child: ChildProcessWithoutNullStreams
  send(message: unknown): void
  sendRaw(line: string): void
  next(timeoutMs?: number): Promise<Record<string, unknown> | undefined>
  close(): Promise<void>
  stderr(): string
}

function nodeArgs(): string[] {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  return major >= 23 ? [MCP_ENTRY] : ['--experimental-strip-types', MCP_ENTRY]
}

function startBridge(): Bridge {
  const child = spawn(process.execPath, nodeArgs(), {
    env: {
      ...process.env,
      LIEBIAN_DAEMON_URL: 'http://127.0.0.1:1',
      LIEBIAN_DAEMON_TOKEN: 'test-token',
      LIEBIAN_WORK: 'W-0001',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  const frames: Record<string, unknown>[] = []
  const waiters: ((frame: Record<string, unknown> | undefined) => void)[] = []
  let stderrText = ''
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const frame = JSON.parse(line) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter === undefined) frames.push(frame)
    else waiter(frame)
  })

  return {
    child,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    sendRaw(line) {
      child.stdin.write(`${line}\n`)
    },
    next(timeoutMs = 2_000) {
      if (frames.length > 0) return Promise.resolve(frames.shift())
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(done)
          if (index >= 0) waiters.splice(index, 1)
          resolve(undefined)
        }, timeoutMs)
        const done = (frame: Record<string, unknown> | undefined): void => {
          clearTimeout(timer)
          resolve(frame)
        }
        waiters.push(done)
      })
    },
    async close() {
      if (child.exitCode !== null) return
      child.stdin.end()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill()
          resolve()
        }, 2_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
    stderr() {
      return stderrText
    },
  }
}

async function withBridge(t: test.TestContext): Promise<Bridge> {
  const bridge = startBridge()
  t.after(() => bridge.close())
  return bridge
}

function initialize(id: number | string, protocolVersion: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'mcp-protocol-test', version: '1.0.0' },
    },
  }
}

test('MCP stdio 桥接：启动、DSH 探测回退、合法版本初始化、通知和工具发现', async (t) => {
  const bridge = await withBridge(t)

  // The harness SDK's auto negotiation probes modern MCP first. A method-not-
  // found response is its documented signal to fall back to legacy initialize.
  bridge.send({
    jsonrpc: '2.0',
    id: 'discover',
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'mcp-protocol-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  })
  const discovery = await bridge.next()
  assert.equal(discovery?.id, 'discover')
  assert.equal((discovery?.error as { code?: number } | undefined)?.code, -32601)

  bridge.send(initialize(1, '2025-11-25'))

  const initialized = await bridge.next()
  assert.deepEqual(initialized, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'liebian-runtime', version: '0.1.0' },
    },
  })

  bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(await bridge.next(100), undefined, '通知不能产生响应')

  bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const listed = await bridge.next()
  assert.equal(listed?.id, 2)
  const result = listed?.result as { tools?: unknown[] } | undefined
  assert.equal(result?.tools?.length, 18)
})

test('MCP stdio 桥接：未知新版本协商到真实支持版本', async (t) => {
  const bridge = await withBridge(t)
  bridge.send(initialize('future', '2099-01-01'))

  const response = await bridge.next()
  const result = response?.result as { protocolVersion?: string } | undefined
  assert.equal(response?.id, 'future')
  assert.equal(result?.protocolVersion, '2025-11-25')
})

test('MCP stdio 桥接：initialize 必填参数和 JSON-RPC 生命周期校验', async (t) => {
  const bridge = await withBridge(t)

  bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const beforeInitialize = await bridge.next()
  assert.equal((beforeInitialize?.error as { code?: number } | undefined)?.code, -32600)

  const invalidParameters: unknown[] = [
    undefined,
    {},
    { protocolVersion: 1, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    { protocolVersion: '2025-11-25', capabilities: [], clientInfo: { name: 'test', version: '1' } },
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} },
  ]
  for (let index = 0; index < invalidParameters.length; index += 1) {
    bridge.send({ jsonrpc: '2.0', id: index + 10, method: 'initialize', params: invalidParameters[index] })
    const response = await bridge.next()
    assert.equal(response?.id, index + 10)
    assert.equal((response?.error as { code?: number } | undefined)?.code, -32602)
  }

  bridge.send(initialize(20, '2025-11-25'))
  assert.equal(((await bridge.next())?.result as { protocolVersion?: string } | undefined)?.protocolVersion, '2025-11-25')
  bridge.send(initialize(21, '2025-11-25'))
  const duplicate = await bridge.next()
  assert.equal((duplicate?.error as { code?: number } | undefined)?.code, -32600)
})

test('MCP stdio 桥接：未知通知静默，JSON-RPC 错误可诊断', async (t) => {
  const bridge = await withBridge(t)

  bridge.send({ jsonrpc: '2.0', method: 'notifications/unknown' })
  assert.equal(await bridge.next(100), undefined)

  bridge.sendRaw('{not-json')
  const parseError = await bridge.next()
  assert.equal(parseError?.id, null)
  assert.equal((parseError?.error as { code?: number } | undefined)?.code, -32700)

  bridge.send({ jsonrpc: '1.0', id: 1, method: 'ping' })
  const invalidRequest = await bridge.next()
  assert.equal(invalidRequest?.id, null)
  assert.equal((invalidRequest?.error as { code?: number } | undefined)?.code, -32600)

  bridge.send(initialize(2, '2025-11-25'))
  await bridge.next()
  bridge.send({ jsonrpc: '2.0', id: 3, method: 'unknown/method' })
  const methodNotFound = await bridge.next()
  assert.equal((methodNotFound?.error as { code?: number } | undefined)?.code, -32601)
  assert.doesNotMatch(bridge.stderr(), /Unhandled|TypeError|SyntaxError/)
})
