/**
 * Minimal MCP stdio bridge for one executor.
 *
 * The harness launches one bridge per work process (`LIEBIAN_WORK`). The bridge
 * speaks newline-delimited JSON-RPC (the MCP stdio transport), advertises the
 * runtime tools, and forwards each call to the local runtime HTTP API. It owns
 * only the MCP lifecycle state and writes nothing to stdout except protocol
 * frames.
 */

import { MCP_TOOLS, MCP_TOOL_BY_NAME } from './tools.ts'
import { AppError, describeError, errorPayload } from '../util/errors.ts'

const SERVER_NAME = 'liebian-runtime'
const SERVER_VERSION = '0.1.0'
// This bridge implements the 2025-11-25 legacy lifecycle and tool surface. A
// different requested revision must be negotiated down to this value.
const SUPPORTED_PROTOCOL_VERSION = '2025-11-25'
const DEFAULT_TIMEOUT_MS = 120_000
const WAIT_TIMEOUT_MS = 900_000

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

type RequestId = number | string
type LifecycleState = 'new' | 'initialized' | 'ready'

const daemonUrl = process.env.LIEBIAN_DAEMON_URL
const daemonToken = process.env.LIEBIAN_DAEMON_TOKEN
const workId = process.env.LIEBIAN_WORK
let lifecycleState: LifecycleState = 'new'

function log(message: string): void {
  process.stderr.write(`[liebian-mcp] ${message}\n`)
}

function writeFrame(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function reply(id: RequestId, result: unknown): void {
  writeFrame({ jsonrpc: '2.0', id, result })
}

function replyError(id: RequestId | null, code: number, message: string, data?: unknown): void {
  const error: { code: number; message: string; data?: unknown } = { code, message }
  if (data !== undefined) error.data = data
  writeFrame({ jsonrpc: '2.0', id, error })
}

async function callRuntime(op: string, params: unknown): Promise<unknown> {
  if (daemonUrl === undefined || daemonToken === undefined || workId === undefined) {
    throw new AppError('NOT_CONFIGURED', 'MCP 桥接缺少 LIEBIAN_DAEMON_URL / LIEBIAN_DAEMON_TOKEN / LIEBIAN_WORK')
  }
  const timeout = op === 'executor.wait' ? WAIT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  let response: Response
  try {
    response = await fetch(`${daemonUrl}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemonToken}`,
        'x-liebian-work': workId,
      },
      body: JSON.stringify({ op, params }),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    throw new AppError('RUNTIME_UNAVAILABLE', `无法连接运行时：${describeError(error)}`)
  }
  let payload: { ok?: boolean; result?: unknown; error?: unknown }
  try {
    payload = (await response.json()) as typeof payload
  } catch {
    throw new AppError('RUNTIME_BAD_RESPONSE', `运行时返回了非 JSON 响应（HTTP ${response.status}）`)
  }
  if (payload.ok !== true) {
    const error = payload.error as { code?: string; message?: string; details?: unknown } | undefined
    throw new AppError(error?.code ?? 'RUNTIME_ERROR', error?.message ?? '运行时调用失败', error?.details)
  }
  return payload.result
}

function formatResult(value: unknown): string {
  if (typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string') {
    return (value as { text: string }).text
  }
  return JSON.stringify(value, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
}

function validateInitialize(params: unknown): { protocolVersion: string } | { error: string } {
  if (!isRecord(params)) return { error: 'params 必须是 JSON 对象' }
  if (typeof params.protocolVersion !== 'string' || params.protocolVersion.length === 0) {
    return { error: 'protocolVersion 必须是非空字符串' }
  }
  if (!isRecord(params.capabilities)) return { error: 'capabilities 必须是 JSON 对象' }
  if (!isRecord(params.clientInfo)) return { error: 'clientInfo 必须是 JSON 对象' }
  if (typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
    return { error: 'clientInfo.name 和 clientInfo.version 必须是字符串' }
  }
  if (params._meta !== undefined && !isRecord(params._meta)) return { error: '_meta 必须是 JSON 对象' }
  return { protocolVersion: params.protocolVersion }
}

function requireInitialized(id: RequestId): boolean {
  if (lifecycleState !== 'new') return true
  replyError(id, -32600, 'Invalid Request: initialize 必须首先调用')
  return false
}

async function handleCall(id: RequestId, params: unknown): Promise<void> {
  if (!isRecord(params)) {
    replyError(id, -32602, 'Invalid params: tools/call params 必须是 JSON 对象')
    return
  }
  const name = typeof params.name === 'string' ? params.name : ''
  const args = params.arguments ?? {}
  if (name.length === 0 || !isRecord(args)) {
    replyError(id, -32602, 'Invalid params: tools/call 需要字符串 name 和对象 arguments')
    return
  }
  const tool = MCP_TOOL_BY_NAME.get(name)
  if (tool === undefined) {
    replyError(id, -32602, `未知工具：${name}`)
    return
  }
  try {
    const result = await callRuntime(tool.op, args)
    reply(id, { content: [{ type: 'text', text: formatResult(result) }] })
  } catch (error) {
    const payload = errorPayload(error)
    log(`工具 ${name} 失败：${payload.code} ${payload.message}`)
    const text =
      payload.details === undefined
        ? `[${payload.code}] ${payload.message}`
        : `[${payload.code}] ${payload.message}\n\n${JSON.stringify(payload.details, null, 2)}`
    reply(id, { content: [{ type: 'text', text }], isError: true })
  }
}

async function handleRequest(message: JsonRpcRequest): Promise<void> {
  const { id, method, params } = message
  switch (method) {
    case 'initialize': {
      if (lifecycleState !== 'new') {
        replyError(id, -32600, 'Invalid Request: 重复的 initialize 请求')
        return
      }
      const validated = validateInitialize(params)
      if ('error' in validated) {
        replyError(id, -32602, `Invalid params: ${validated.error}`)
        return
      }
      const negotiated =
        validated.protocolVersion === SUPPORTED_PROTOCOL_VERSION
          ? validated.protocolVersion
          : SUPPORTED_PROTOCOL_VERSION
      reply(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      })
      lifecycleState = 'initialized'
      return
    }
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      if (!requireInitialized(id)) return
      reply(id, {
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
      return
    case 'tools/call':
      if (!requireInitialized(id)) return
      await handleCall(id, params)
      return
    case 'server/discover':
      // Explicitly mark this server as a legacy-revision server so the harness
      // client performs the 2025-era initialize handshake.
      replyError(id, -32601, 'Method not found')
      return
    default:
      replyError(id, -32601, `Method not found: ${method}`)
  }
}

function handleNotification(method: string, params: unknown): void {
  if (params !== undefined && !isRecord(params)) {
    log(`忽略参数无效的通知：${method}`)
    return
  }
  if (method === 'notifications/initialized') {
    if (lifecycleState === 'initialized') {
      lifecycleState = 'ready'
      return
    }
    log(`忽略状态外的 notifications/initialized（当前 ${lifecycleState}）`)
  }
}

function handleFrame(line: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    replyError(null, -32700, 'Parse error')
    return
  }
  if (!isRecord(parsed)) {
    replyError(null, -32600, 'Invalid Request')
    return
  }

  const hasId = Object.hasOwn(parsed, 'id')
  if (!hasId) {
    if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      replyError(null, -32600, 'Invalid Request')
      return
    }
    // A JSON-RPC notification must never receive a response, including for an
    // unknown or ignored method.
    handleNotification(parsed.method, parsed.params)
    return
  }

  if (parsed.jsonrpc !== '2.0') {
    replyError(null, -32600, 'Invalid Request')
    return
  }
  if (!isRequestId(parsed.id)) {
    replyError(null, -32600, 'Invalid Request: id 必须是字符串或整数')
    return
  }
  if (typeof parsed.method !== 'string') {
    replyError(null, -32600, 'Invalid Request: method 必须是字符串')
    return
  }
  const message: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: parsed.id,
    method: parsed.method,
    params: parsed.params,
  }
  void handleRequest(message).catch((error: unknown) => {
    log(`请求处理失败：${describeError(error)}`)
    replyError(message.id, -32603, '内部错误')
  })
}

function main(): void {
  if (daemonUrl === undefined || daemonToken === undefined || workId === undefined) {
    log('缺少 LIEBIAN_DAEMON_URL / LIEBIAN_DAEMON_TOKEN / LIEBIAN_WORK，桥接无法启动')
    process.exitCode = 1
    return
  }
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) {
        handleFrame(line)
      }
      newline = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    process.exit(0)
  })
}

main()
