/**
 * Minimal MCP stdio bridge for one executor.
 *
 * The harness launches one bridge per work process (`LIEBIAN_WORK`). The bridge
 * speaks newline-delimited JSON-RPC (the MCP stdio transport), advertises the
 * runtime tools, and forwards each call to the local runtime HTTP API. It holds
 * no state of its own and writes nothing to stdout except protocol frames.
 */

import { MCP_TOOLS, MCP_TOOL_BY_NAME } from './tools.ts'
import { AppError, describeError, errorPayload } from '../util/errors.ts'

const SERVER_NAME = 'liebian-runtime'
const SERVER_VERSION = '0.1.0'
const DEFAULT_TIMEOUT_MS = 120_000
const WAIT_TIMEOUT_MS = 900_000

interface JsonRpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
}

const daemonUrl = process.env.LIEBIAN_DAEMON_URL
const daemonToken = process.env.LIEBIAN_DAEMON_TOKEN
const workId = process.env.LIEBIAN_WORK

function log(message: string): void {
  process.stderr.write(`[liebian-mcp] ${message}\n`)
}

function writeFrame(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function reply(id: number | string, result: unknown): void {
  writeFrame({ jsonrpc: '2.0', id, result })
}

function replyError(id: number | string, code: number, message: string, data?: unknown): void {
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

async function handleCall(id: number | string, params: unknown): Promise<void> {
  const call = params as { name?: unknown; arguments?: unknown } | undefined
  const name = typeof call?.name === 'string' ? call.name : ''
  const tool = MCP_TOOL_BY_NAME.get(name)
  if (tool === undefined) {
    replyError(id, -32602, `未知工具：${name}`)
    return
  }
  try {
    const result = await callRuntime(tool.op, call?.arguments ?? {})
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
  const { id, method } = message
  if (id === undefined || id === null || method === undefined) return
  switch (method) {
    case 'initialize': {
      const params = message.params as { protocolVersion?: unknown } | undefined
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18'
      reply(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      })
      return
    }
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, {
        tools: MCP_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
      return
    case 'tools/call':
      await handleCall(id, message.params)
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
        try {
          const message = JSON.parse(line) as JsonRpcRequest
          if (message.method !== undefined && (message.id === undefined || message.id === null)) {
            // Notification (for example notifications/initialized): no reply.
          } else {
            void handleRequest(message).catch((error: unknown) => {
              log(`请求处理失败：${describeError(error)}`)
              if (message.id !== undefined && message.id !== null) {
                replyError(message.id, -32603, '内部错误')
              }
            })
          }
        } catch {
          log('忽略无法解析的输入行')
        }
      }
      newline = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    process.exit(0)
  })
}

main()
