/**
 * Local HTTP API used by the MCP bridge (work-scoped calls) and by the human
 * CLI (administration). Bound to loopback only; every request carries the
 * runtime-generated bearer token from `runtime/daemon.json`.
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Engine } from '../core/engine.ts'
import { AppError, errorPayload } from '../util/errors.ts'
import type { Logger } from '../util/log.ts'
import { dispatchAdminOp, dispatchWorkOp } from './rpc.ts'
import { DEFAULT_API_PORT_RANGE, listenInPortRange } from '../util/ports.ts'

export interface ApiServerOptions {
  getEngine: () => Engine | undefined
  logger: Logger
  token?: string
  portRange?: string
}

export interface ApiServer {
  url: string
  port: number
  token: string
  close(): Promise<void>
}

const MAX_BODY_BYTES = 4 * 1024 * 1024

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  // A waiting `/llm/acquire` may have lost its client; never write to a dead
  // response just to report the cancellation it already caused.
  if (response.destroyed || response.writableEnded) return
  const body = `${JSON.stringify(payload)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', '请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new AppError('INVALID_JSON', '请求体不是合法 JSON')
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] === token
}

/** Start the loopback API server on an ephemeral port. */
export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const token = options.token ?? randomBytes(24).toString('hex')
  const logger = options.logger

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/health') {
      const engine = options.getEngine()
      sendJson(response, engine === undefined ? 503 : 200, {
        ok: engine !== undefined,
        taskId: engine?.state.taskId ?? null,
        status: engine?.state.status ?? 'starting',
        modelConcurrency: engine?.modelConcurrency ?? null,
        modelSlots: engine?.modelSlotStats ?? null,
      })
      return
    }
    const path = url.pathname
    const isWorkPath = path === '/rpc' || path === '/admin'
    const isLlmPath = path === '/llm/acquire' || path === '/llm/release' || path === '/llm/abort'
    const isCommandPath =
      path === '/command/claim' || path === '/command/ack' || path === '/command/release'
    if (request.method !== 'POST' || (!isWorkPath && !isLlmPath && !isCommandPath)) {
      sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知路径' } })
      return
    }
    if (!authorized(request, token)) {
      sendJson(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '令牌无效' } })
      return
    }
    const engine = options.getEngine()
    if (engine === undefined) {
      sendJson(response, 503, { ok: false, error: { code: 'NOT_READY', message: '运行时尚未就绪' } })
      return
    }
    try {
      const payload = (await readJsonBody(request)) as {
        op?: unknown
        params?: unknown
        permitId?: unknown
        cancel?: unknown
        sessionId?: unknown
        generation?: unknown
        commandId?: unknown
        token?: unknown
        messageId?: unknown
        reason?: unknown
        metrics?: unknown
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new AppError('INVALID_ARGUMENT', '请求体必须是 JSON 对象')
      }
      if (isLlmPath && (!Number.isSafeInteger(payload.generation) || Number(payload.generation) <= 0)) {
        throw new AppError('INVALID_ARGUMENT', '模型名额请求必须携带有效进程代次 generation')
      }

      // Internal model-request semaphore endpoints. They are authenticated by
      // the same bearer token as the work API and are not exposed as MCP tools.
      if (path === '/llm/acquire') {
        const workId = request.headers['x-liebian-work']
        if (typeof workId !== 'string' || workId.length === 0) {
          throw new AppError('INVALID_ARGUMENT', '缺少 x-liebian-work 头')
        }
        const rawPermitId = payload.permitId
        if (
          rawPermitId !== undefined &&
          (typeof rawPermitId !== 'string' || rawPermitId.length === 0 || rawPermitId.length > 200)
        ) {
          throw new AppError('INVALID_ARGUMENT', 'permitId 必须是 1-200 字符的字符串')
        }
        const controller = new AbortController()
        const onClose = (): void => {
          if (!response.writableEnded) controller.abort()
        }
        response.once('close', onClose)
        try {
          const permit = await engine.acquireModelSlot(workId, {
            ...(typeof payload.generation === 'number' ? { generation: payload.generation } : {}),
            ...(typeof rawPermitId === 'string' ? { permitId: rawPermitId } : {}),
            signal: controller.signal,
          })
          if (controller.signal.aborted) {
            // The client vanished between grant and response. Return the slot
            // now; its abort path will also cancel the id idempotently.
            engine.cancelModelSlot(permit.permitId)
            return
          }
          sendJson(response, 200, { ok: true, result: permit })
        } finally {
          response.off('close', onClose)
        }
        return
      }
      if (path === '/llm/release') {
        const permitId = payload.permitId
        if (typeof permitId !== 'string' || permitId.length === 0 || permitId.length > 200) {
          throw new AppError('INVALID_ARGUMENT', 'permitId 必须是 1-200 字符的字符串')
        }
        const workId = request.headers['x-liebian-work']
        if (typeof workId !== 'string') throw new AppError('INVALID_ARGUMENT', '缺少 x-liebian-work 头')
        const released = engine.releaseModelRequest(workId, Number(payload.generation), permitId, payload.cancel === true)
        if (released || payload.cancel === true) engine.recordDiagnostic('model-finished', {
          workId: request.headers['x-liebian-work'], generation: payload.generation, permitId,
          cancelled: payload.cancel === true, metrics: payload.metrics,
        })
        sendJson(response, 200, { ok: true, result: { released } })
        return
      }
      if (path === '/llm/abort') {
        const workId = request.headers['x-liebian-work']
        if (typeof workId !== 'string' || typeof payload.generation !== 'number') {
          throw new AppError('INVALID_ARGUMENT', '中止模型流必须提供 work 和进程代次')
        }
        await engine.abortModelGeneration(workId, payload.generation, String(payload.reason ?? 'stream-cleanup'))
        sendJson(response, 200, { ok: true, result: {} })
        return
      }

      // Internal steering-plugin protocol: claim a saved human command, report
      // its harness receipt, or give the claim back. Deliberately not an MCP
      // tool, so executors cannot report delivery of their own commands.
      if (isCommandPath) {
        const workId = request.headers['x-liebian-work']
        if (typeof workId !== 'string' || workId.length === 0) {
          throw new AppError('INVALID_ARGUMENT', '缺少 x-liebian-work 头')
        }
        if (path === '/command/claim') {
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
          const generation = typeof payload.generation === 'number' ? payload.generation : undefined
          const result = await engine.claimCommands(workId, {
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(generation === undefined ? {} : { generation }),
          })
          sendJson(response, 200, { ok: true, result })
          return
        }
        if (path === '/command/ack') {
          const result = await engine.ackCommand(workId, {
            commandId: String(payload.commandId ?? ''),
            token: String(payload.token ?? ''),
            messageId: String(payload.messageId ?? ''),
          })
          sendJson(response, 200, { ok: true, result })
          return
        }
        const result = await engine.releaseCommand(workId, {
          commandId: String(payload.commandId ?? ''),
          token: String(payload.token ?? ''),
          reason: typeof payload.reason === 'string' ? payload.reason : undefined,
        })
        sendJson(response, 200, { ok: true, result })
        return
      }

      const op = typeof payload.op === 'string' ? payload.op : ''
      if (op.length === 0) throw new AppError('INVALID_ARGUMENT', '缺少 op')
      let result: unknown
      if (url.pathname === '/rpc') {
        const workId = request.headers['x-liebian-work']
        if (typeof workId !== 'string' || workId.length === 0) {
          throw new AppError('INVALID_ARGUMENT', '缺少 x-liebian-work 头')
        }
        result = await dispatchWorkOp(engine, workId, op, payload.params)
      } else {
        result = await dispatchAdminOp(engine, op, payload.params)
      }
      sendJson(response, 200, { ok: true, result })
    } catch (error) {
      const payload = errorPayload(error)
      engine.recordDiagnostic('api-error', { path, workId: request.headers['x-liebian-work'], code: payload.code, message: payload.message })
      if (payload.code === 'INTERNAL_ERROR') logger.error(`API ${url.pathname} 失败：${payload.message}`)
      else logger.debug(`API ${url.pathname} 拒绝：${payload.code} ${payload.message}`)
      sendJson(response, 200, { ok: false, error: payload })
    }
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error(`HTTP 处理异常：${String(error)}`)
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: '内部错误' } })
      } else {
        response.end()
      }
    })
  })

  await listenInPortRange(server, options.portRange ?? process.env.LIEBIAN_API_PORT_RANGE ?? DEFAULT_API_PORT_RANGE)
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new AppError('INTERNAL_ERROR', '无法确定 API 端口')
  }
  logger.info(`本地 API 监听 http://127.0.0.1:${address.port}`)

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  }
}
