/**
 * Loopback Web UI server.
 *
 * This server is intentionally separate from the executor-facing API: it binds
 * its own loopback port, requires a token printed by `liebian web`, and only
 * exposes the observation/administration actions a human needs. It reads
 * `state.json` for offline tasks and talks to a running daemon's admin API when
 * one exists, so it never becomes a second writer of runtime state.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTaskPaths } from '../core/paths.ts'
import { isValidTaskId } from '../util/ids.ts'
import { AppError, describeError, errorPayload } from '../util/errors.ts'
import type { Logger } from '../util/log.ts'
import {
  continueTaskFromWeb,
  createTaskFromWeb,
  deleteTaskFromWeb,
  getTaskDetail,
  listTasks,
  readTaskFile,
  recoverTaskFromWeb,
  resumeTaskFromWeb,
  sendCommandFromWeb,
  setEndFromWeb,
  setStartFromWeb,
  startTaskRun,
  stopTaskFromWeb,
} from './task-service.ts'
import { reconcileTaskServices } from './docker-launcher.ts'
import { parseModelConcurrency } from '../util/semaphore.ts'
import { parseModelMaxTokens, parseModelThinking } from '../util/model-limits.ts'
import { readWorkConversation } from './conversation.ts'
import { DEFAULT_WEB_PORT, parsePort } from '../util/ports.ts'
import {
  ENV_MODEL,
  ENV_PROVIDER,
  clearWebSettings,
  envText,
  publicWebSettings,
  resolveWebSettings,
  saveWebSettings,
} from './settings.ts'
import { listModelConfig, testModelConfig } from './model-test.ts'

export interface WebServerOptions {
  tasksRoot: string
  logger: Logger
  port?: number
  /**
   * Interface to bind. Defaults to `LIEBIAN_WEB_HOST`, then `127.0.0.1`.
   * A containerized Web UI must bind `0.0.0.0` so the published port reaches it.
   */
  host?: string
  token?: string
  /**
   * Extra exact origins allowed for mutating requests, in addition to the
   * loopback origin and the request's own Host header.
   */
  allowedOrigins?: string[]
  /** How often an open event stream checks the task files (milliseconds). */
  tickMs?: number
}

export interface WebServer {
  url: string
  port: number
  token: string
  tasksRoot: string
  close(): Promise<void>
}

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))
const COOKIE_NAME = 'liebian_web'
const MAX_BODY_BYTES = 1024 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function sendHtml(response: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...headers,
  })
  response.end(html)
}

function sendText(response: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(text)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', '请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(request)
  if (text.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AppError('INVALID_JSON', '请求体不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('INVALID_ARGUMENT', '请求体必须是对象')
  }
  return parsed as Record<string, unknown>
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined) return {}
  const result: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return result
}

function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (candidate === undefined) return false
  const left = Buffer.from(candidate)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]
}

function hasValidToken(request: IncomingMessage, token: string): boolean {
  if (tokenMatches(bearerToken(request), token)) return true
  const header = request.headers['x-liebian-web-token']
  if (typeof header === 'string' && tokenMatches(header, token)) return true
  return tokenMatches(parseCookies(request.headers.cookie)[COOKIE_NAME], token)
}

function cookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
}

function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nexora · 需要访问令牌</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body class="login-body">
  <main class="login-card">
    <div class="brand-mark">N</div>
    <h1>Nexora Web UI</h1>
    <p class="muted">输入启动 <code>liebian web</code> 时控制台打印的访问令牌。令牌只在本机使用。</p>
    ${error === undefined ? '' : `<p class="login-error">${escapeHtml(error)}</p>`}
    <form method="post" action="/api/login">
      <label>访问令牌
        <input name="token" type="password" autocomplete="off" autofocus required>
      </label>
      <button class="btn primary" type="submit">进入</button>
    </form>
    <p class="login-hint">也可以直接打开控制台打印的“带令牌的入口”。</p>
  </main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function envList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter((item) => item.length > 0)
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]'
}

/**
 * Accept a mutation origin when it is loopback on our own port, explicitly
 * allowlisted, or identical to the Host the browser connected to (which covers
 * a reverse proxy using a different external port and access by
 * LAN address). A cross-site page cannot forge the Host header.
 */
function isAllowedOrigin(
  origin: string,
  port: number,
  hostHeader: string | undefined,
  extra: ReadonlySet<string>,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (extra.has(origin.replace(/\/+$/, ''))) return true
  if (isLoopbackHostname(parsed.hostname) && parsed.port === String(port)) return true
  if (hostHeader !== undefined && parsed.host === hostHeader) return true
  return false
}

function requireMutation(
  request: IncomingMessage,
  port: number,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (request.headers['x-liebian-web'] !== '1') {
    throw new AppError('CSRF_REQUIRED', '缺少 x-liebian-web 请求头')
  }
  const origin = request.headers.origin
  if (origin !== undefined && !isAllowedOrigin(origin, port, request.headers.host, allowedOrigins)) {
    throw new AppError('FORBIDDEN_ORIGIN', '请求来源不被允许')
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new AppError('INVALID_ARGUMENT', '任务 ID 编码无效')
  }
}

function getTaskId(raw: string): string {
  const taskId = decodeSegment(raw)
  if (!isValidTaskId(taskId)) throw new AppError('INVALID_ARGUMENT', `非法任务 ID：${taskId}`)
  return taskId
}

interface TaskRevisionInput {
  stateFile: string
  journalFile: string
  daemonFile: string
  logFile: string
  runLogFile: string
}

async function taskRevision(paths: TaskRevisionInput): Promise<string> {
  const parts = await Promise.all(
    [paths.stateFile, paths.journalFile, paths.daemonFile, paths.logFile, paths.runLogFile].map(async (file) => {
      const info = await stat(file).catch(() => null)
      return info === null ? '-' : `${Math.round(info.mtimeMs)}:${info.size}`
    }),
  )
  return parts.join('|')
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const configuredPort = parsePort(options.port ?? process.env.LIEBIAN_WEB_PORT ?? DEFAULT_WEB_PORT, true)
  const host = options.host ?? process.env.LIEBIAN_WEB_HOST ?? '127.0.0.1'
  const configuredToken = options.token ?? (process.env.LIEBIAN_WEB_TOKEN ?? '').trim()
  if (configuredToken.length > 0 && configuredToken.length < 8) {
    throw new AppError('INVALID_ARGUMENT', 'LIEBIAN_WEB_TOKEN 至少需要 8 个字符；留空则自动生成随机令牌')
  }
  const token = configuredToken.length > 0 ? configuredToken : randomBytes(24).toString('hex')
  const allowedOrigins = new Set([
    ...envList(process.env.LIEBIAN_WEB_ALLOWED_ORIGINS),
    ...(options.allowedOrigins ?? []).map((origin) => origin.replace(/\/+$/, '')).filter((origin) => origin.length > 0),
  ])
  const logger = options.logger
  const tasksRoot = options.tasksRoot
  const tickMs = Math.max(200, options.tickMs ?? 700)
  const streamCleanups = new Set<() => void>()

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error(`Web 请求处理异常：${describeError(error)}`)
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: '内部错误' } })
      } else {
        response.end()
      }
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(configuredPort, host, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new AppError('INTERNAL_ERROR', '无法确定 Web 端口'))
        return
      }
      resolve(address.port)
    })
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new AppError('PORT_IN_USE', `端口 ${configuredPort} 已被占用；可用 LIEBIAN_WEB_PORT 或 --port 指定其他端口`)
    }
    if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') {
      throw new AppError('INVALID_ARGUMENT', `无法监听 ${host}:${configuredPort}；请检查 --host 或网卡`)
    }
    throw error
  })

  // The URL a human should open. A wildcard bind is reachable through loopback
  // on the same machine (and through the published port in a container).
  const reachableHost = isWildcardHost(host) ? '127.0.0.1' : host
  const url = `http://${reachableHost.includes(':') ? `[${reachableHost}]` : reachableHost}:${port}`

  // Completed/stopped tasks must not linger as Compose services, otherwise the
  // next `docker compose up` would restart them. Run once at startup and then
  // periodically; this is a no-op outside compose mode.
  const reconcile = (): void => {
    void reconcileTaskServices(tasksRoot, logger).catch((error: unknown) => {
      logger.warn(`回收任务 compose service 失败：${describeError(error)}`)
    })
  }
  reconcile()
  const reconcileTimer = setInterval(reconcile, 60_000)
  reconcileTimer.unref?.()

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = request.method ?? 'GET'

    if (method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true, app: 'liebian-web', tasksRoot })
      return
    }
    if (method === 'GET' && pathname === '/favicon.ico') {
      response.writeHead(204).end()
      return
    }
    if (
      method === 'GET' &&
      (pathname === '/assets/app.js' || pathname === '/assets/admin.js' || pathname === '/assets/styles.css')
    ) {
      await serveAsset(pathname, response)
      return
    }
    if (method === 'GET' && pathname === '/') {
      const queryToken = url.searchParams.get('token') ?? undefined
      if (queryToken !== undefined) {
        if (tokenMatches(queryToken, token)) {
          response.writeHead(303, {
            location: '/',
            'set-cookie': cookieHeader(token),
            'cache-control': 'no-store',
          })
          response.end()
          return
        }
        sendHtml(response, 401, loginPage('访问令牌不正确'))
        return
      }
      if (!hasValidToken(request, token)) {
        sendHtml(response, 401, loginPage())
        return
      }
      await serveIndex(response)
      return
    }
    if (method === 'POST' && pathname === '/api/login') {
      await handleLogin(request, response)
      return
    }
    if (!hasValidToken(request, token)) {
      if (pathname.startsWith('/api/')) {
        sendJson(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要访问令牌' } })
      } else {
        sendHtml(response, 401, loginPage())
      }
      return
    }

    try {
      if (method === 'GET' && pathname === '/api/session') {
        sendJson(response, 200, {
          ok: true,
          tasksRoot,
          app: 'liebian-web',
        })
        return
      }
      if (pathname === '/api/settings' && (method === 'GET' || method === 'POST' || method === 'DELETE')) {
        if (method === 'GET') {
          sendJson(response, 200, { ok: true, settings: publicWebSettings(await resolveWebSettings(tasksRoot)) })
          return
        }
        requireMutation(request, port, allowedOrigins)
        if (method === 'DELETE') {
          // Drop the saved override so the environment (LIEBIAN_* / DEEPSEEK_*)
          // becomes effective again.
          await clearWebSettings(tasksRoot)
          sendJson(response, 200, { ok: true, settings: publicWebSettings(await resolveWebSettings(tasksRoot)) })
          return
        }
        const body = await readJsonBody(request)
        const current = await resolveWebSettings(tasksRoot)
        const next = { ...current.settings }
        if (typeof body.apiKey === 'string' && body.apiKey.trim().length > 0) {
          if (body.apiKey.trim().length > 4096) throw new AppError('INVALID_ARGUMENT', 'API Key 过长')
          next.apiKey = body.apiKey.trim()
        }
        if (body.clearApiKey === true) next.apiKey = ''
        if (typeof body.provider === 'string') {
          next.provider = body.provider.trim() || envText(ENV_PROVIDER) || 'deepseek-official'
        }
        if (typeof body.model === 'string') {
          next.model = body.model.trim() || envText(ENV_MODEL) || 'deepseek-flash'
        }
        if (typeof body.baseUrl === 'string') next.baseUrl = body.baseUrl.trim()
        if (body.modelConcurrency !== undefined) {
          next.modelConcurrency = parseModelConcurrency(body.modelConcurrency)
        }
        if (body.modelMaxTokens !== undefined) {
          next.modelMaxTokens = parseModelMaxTokens(body.modelMaxTokens)
        }
        if (body.modelThinking !== undefined) {
          next.modelThinking = parseModelThinking(body.modelThinking)
        }
        await saveWebSettings(tasksRoot, next)
        sendJson(response, 200, { ok: true, settings: publicWebSettings(await resolveWebSettings(tasksRoot)) })
        return
      }
      if (pathname === '/api/settings/test' && method === 'POST') {
        requireMutation(request, port, allowedOrigins)
        const body = await readJsonBody(request)
        // A failed probe is still a successful request: the UI renders the
        // provider's error instead of treating it as a transport failure.
        sendJson(response, 200, { ok: true, result: await testModelConfig(tasksRoot, body) })
        return
      }
      if (pathname === '/api/settings/models' && method === 'POST') {
        requireMutation(request, port, allowedOrigins)
        const body = await readJsonBody(request)
        sendJson(response, 200, { ok: true, result: await listModelConfig(tasksRoot, body) })
        return
      }
      if (pathname === '/api/tasks' && (method === 'GET' || method === 'POST')) {
        if (method === 'GET') {
          sendJson(response, 200, { ok: true, tasks: await listTasks(tasksRoot), tasksRoot })
          return
        }
        requireMutation(request, port, allowedOrigins)
        const body = await readJsonBody(request)
        const start = typeof body.start === 'string' ? body.start : ''
        const end = typeof body.end === 'string' ? body.end : ''
        if (start.trim().length === 0 || end.trim().length === 0) {
          throw new AppError('INVALID_ARGUMENT', '起始信息和终点信息都不能为空')
        }
        const created = await createTaskFromWeb(tasksRoot, {
          start,
          end,
          ...(typeof body.id === 'string' ? { id: body.id } : {}),
        })
        let pid: number | undefined
        let startError: string | undefined
        if (body.autoStart === true) {
          try {
            pid = (await startTaskRun({ tasksRoot, taskId: created.taskId, logger })).pid
          } catch (error) {
            startError = describeError(error)
          }
        }
        sendJson(response, 200, {
          ok: true,
          taskId: created.taskId,
          detail: await getTaskDetail(tasksRoot, created.taskId),
          ...(pid === undefined ? {} : { pid }),
          ...(startError === undefined ? {} : { startError }),
        })
        return
      }

      const match = /^\/api\/tasks\/([^/]+)(?:\/(events|run|stop|end-info|start-info|command|continue|resume|recover|file|conversation))?$/.exec(
        pathname,
      )
      if (match !== null) {
        const taskId = getTaskId(match[1] ?? '')
        const action = match[2]
        if (method === 'GET' && action === undefined) {
          sendJson(response, 200, { ok: true, detail: await getTaskDetail(tasksRoot, taskId) })
          return
        }
        if (method === 'DELETE' && action === undefined) {
          requireMutation(request, port, allowedOrigins)
          sendJson(response, 200, { ok: true, result: await deleteTaskFromWeb(tasksRoot, taskId) })
          return
        }
        if (method === 'GET' && action === 'file') {
          const filePath = url.searchParams.get('path')
          if (filePath === null || filePath.length === 0) throw new AppError('INVALID_ARGUMENT', '缺少 path')
          const paths = makeTaskPaths(tasksRoot, taskId)
          const exists = await stat(paths.stateFile).catch(() => null)
          if (exists === null) throw new AppError('TASK_NOT_FOUND', `找不到任务：${taskId}`)
          sendJson(response, 200, { ok: true, file: await readTaskFile(paths, filePath) })
          return
        }
        if (method === 'GET' && action === 'conversation') {
          const workId = url.searchParams.get('work') ?? ''
          if (workId.length === 0) throw new AppError('INVALID_ARGUMENT', '缺少 work')
          const paths = makeTaskPaths(tasksRoot, taskId)
          const exists = await stat(paths.stateFile).catch(() => null)
          if (exists === null) throw new AppError('TASK_NOT_FOUND', `找不到任务：${taskId}`)
          sendJson(response, 200, { ok: true, conversation: await readWorkConversation(paths, workId) })
          return
        }
        if (method === 'GET' && action === 'events') {
          const paths = makeTaskPaths(tasksRoot, taskId)
          const exists = await stat(paths.stateFile).catch(() => null)
          if (exists === null) throw new AppError('TASK_NOT_FOUND', `找不到任务：${taskId}`)
          await streamEvents(request, response, paths, tickMs)
          return
        }
        if (method === 'POST' && action !== undefined) {
          requireMutation(request, port, allowedOrigins)
          const body = await readJsonBody(request)
          if (action === 'run') {
            const result = await startTaskRun({ tasksRoot, taskId, logger })
            sendJson(response, 200, { ok: true, ...result })
            return
          }
          if (action === 'stop') {
            const reason =
              typeof body.reason === 'string' && body.reason.trim().length > 0 ? body.reason.trim() : 'Web UI 手动停止'
            sendJson(response, 200, { ok: true, result: await stopTaskFromWeb(tasksRoot, taskId, reason) })
            return
          }
          if (action === 'end-info' || action === 'start-info') {
            const text = typeof body.text === 'string' ? body.text : ''
            const result =
              action === 'end-info'
                ? await setEndFromWeb(tasksRoot, taskId, text)
                : await setStartFromWeb(tasksRoot, taskId, text)
            sendJson(response, 200, { ok: true, result })
            return
          }
          if (action === 'command') {
            const text = typeof body.text === 'string' ? body.text : ''
            const requestId = typeof body.requestId === 'string' ? body.requestId : ''
            const result = await sendCommandFromWeb(tasksRoot, taskId, text, requestId)
            sendJson(response, 200, { ok: true, result })
            return
          }
          if (action === 'continue') {
            const text = typeof body.text === 'string' ? body.text : ''
            const requestId = typeof body.requestId === 'string' ? body.requestId : ''
            const result = await continueTaskFromWeb(tasksRoot, taskId, text, requestId)
            sendJson(response, 200, { ok: true, result })
            return
          }
          if (action === 'resume') {
            const requestId = typeof body.requestId === 'string' ? body.requestId : ''
            const result = await resumeTaskFromWeb(tasksRoot, taskId, requestId)
            sendJson(response, 200, { ok: true, result })
            return
          }
          if (action === 'recover') {
            const requestId = typeof body.requestId === 'string' ? body.requestId : ''
            const result = await recoverTaskFromWeb(tasksRoot, taskId, requestId)
            sendJson(response, 200, { ok: true, result })
            return
          }
        }
      }
      sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知路径' } })
    } catch (error) {
      const payload = errorPayload(error)
      const status =
        payload.code === 'TASK_NOT_FOUND' || payload.code === 'FILE_NOT_FOUND' || payload.code === 'WORK_NOT_FOUND'
          ? 404
          : payload.code === 'UNAUTHORIZED'
            ? 401
            : payload.code === 'CSRF_REQUIRED' || payload.code === 'FORBIDDEN_ORIGIN' || payload.code === 'FILE_NOT_ALLOWED'
              ? 403
              : payload.code === 'RUNTIME_OFFLINE' ||
                  payload.code === 'COMMAND_DELIVERY_FAILED' ||
                  payload.code === 'TASK_BUSY' ||
                  payload.code === 'TASK_ACTIVE' ||
                  payload.code === 'RUNTIME_STOPPING' ||
                  payload.code === 'RUNTIME_UNREACHABLE' ||
                  payload.code === 'RUN_CLEANUP_PENDING'
                ? 409
                : payload.code === 'INTERNAL_ERROR'
                  ? 500
                  : 400
      if (status >= 500) logger.error(`Web API ${pathname} 失败：${payload.message}`)
      else logger.debug(`Web API ${pathname} 拒绝：${payload.code} ${payload.message}`)
      sendJson(response, status, { ok: false, error: payload })
    }
  }

  async function serveAsset(pathname: string, response: ServerResponse): Promise<void> {
    const name = pathname.slice('/assets/'.length)
    if (name !== 'app.js' && name !== 'admin.js' && name !== 'styles.css') {
      sendText(response, 404, 'Not found')
      return
    }
    const file = join(PUBLIC_DIR, name)
    const content = await readFile(file).catch(() => null)
    if (content === null) {
      sendText(response, 500, `缺少前端资源：${name}`)
      return
    }
    response.writeHead(200, {
      'content-type': MIME[`.${name.split('.').at(-1) ?? ''}`] ?? 'application/octet-stream',
      'content-length': content.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(content)
  }

  async function serveIndex(response: ServerResponse): Promise<void> {
    const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8').catch(() => null)
    if (html === null) {
      sendText(response, 500, '缺少前端资源：index.html')
      return
    }
    sendHtml(response, 200, html, {
      'x-frame-options': 'DENY',
    })
  }

  async function handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const contentType = request.headers['content-type'] ?? ''
    if (contentType.includes('application/json')) {
      const body = await readJsonBody(request)
      const candidate = typeof body.token === 'string' ? body.token : ''
      if (!tokenMatches(candidate, token)) {
        sendJson(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '访问令牌不正确' } })
        return
      }
      response.setHeader('set-cookie', cookieHeader(token))
      sendJson(response, 200, { ok: true })
      return
    }
    const text = await readBody(request)
    const params = new URLSearchParams(text)
    const candidate = params.get('token') ?? ''
    if (!tokenMatches(candidate, token)) {
      sendHtml(response, 401, loginPage('访问令牌不正确'))
      return
    }
    response.writeHead(303, {
      location: '/',
      'set-cookie': cookieHeader(token),
      'cache-control': 'no-store',
    })
    response.end()
  }

  async function streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    paths: ReturnType<typeof makeTaskPaths>,
    intervalMs: number,
  ): Promise<void> {
    const revisionInput = {
      stateFile: paths.stateFile,
      journalFile: paths.journalFile,
      daemonFile: paths.daemonFile,
      logFile: join(paths.logsDir, 'daemon.log'),
      runLogFile: join(paths.logsDir, 'run.out.log'),
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write('retry: 2000\n\n')
    let closed = false
    let timer: NodeJS.Timeout | undefined
    let heartbeat: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      if (closed) return
      closed = true
      if (timer !== undefined) clearInterval(timer)
      if (heartbeat !== undefined) clearInterval(heartbeat)
      streamCleanups.delete(cleanup)
      try {
        response.end()
      } catch {
        // Already closed by the peer.
      }
    }
    streamCleanups.add(cleanup)
    request.once('close', cleanup)

    let last = await taskRevision(revisionInput)
    response.write(`event: ready\ndata: ${JSON.stringify({ revision: last })}\n\n`)
    timer = setInterval(() => {
      if (closed) return
      void taskRevision(revisionInput)
        .then((revision) => {
          if (closed || revision === last) return
          last = revision
          response.write(`event: change\ndata: ${JSON.stringify({ revision })}\n\n`)
        })
        .catch(() => undefined)
    }, intervalMs)
    timer.unref?.()
    heartbeat = setInterval(() => {
      if (closed) return
      response.write(': ping\n\n')
    }, 15_000)
    heartbeat.unref?.()
  }

  logger.info(`Web UI 监听 http://${isWildcardHost(host) ? host : reachableHost}:${port}（任务目录 ${tasksRoot}）`)
  if (!isLoopbackHostname(host)) {
    logger.warn('Web UI 绑定到非回环地址；拿到令牌的访问者可以完全控制任务。')
  }

  return {
    url,
    port,
    token,
    tasksRoot,
    close: async () => {
      clearInterval(reconcileTimer)
      for (const cleanup of [...streamCleanups]) cleanup()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
        server.closeAllConnections?.()
      }).catch(() => undefined)
    },
  }
}
