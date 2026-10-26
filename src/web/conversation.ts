/**
 * Read one executor's session transcript for the Web UI.
 *
 * The harness persists a JSONL event log per Work (session.v4.jsonl). This
 * module turns that log into a small, stable list of chat entries - user
 * messages, assistant text plus its reasoning, tool calls and their results,
 * retries and turn endings - so the UI can show a conversation instead of raw
 * protocol events. Nothing here is written back; the session log stays the
 * single source of truth.
 */
import { open, opendir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '../util/errors.ts'
import type { TaskPaths } from '../core/paths.ts'

export type ConversationRole = 'user' | 'assistant' | 'tool' | 'status'

export interface ConversationEntry {
  /** Harness sequence ID, or a local ordinal for events without one. */
  seq: number
  role: ConversationRole
  at: string
  /** Message text, already trimmed of harness-only framing. */
  text: string
  /** Reasoning that the model produced before the answer. */
  thinking?: string
  /** Tool call name / arguments (role=tool with kind=call). */
  tool?: { kind: 'call' | 'result'; callId: string; name?: string; arguments?: string; truncated?: boolean }
  /** Retry / turn-end diagnostics (role=status). */
  status?: { kind: 'retry' | 'end' | 'error'; code?: string; message?: string }
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface ConversationResult {
  workId: string
  sessionId: string
  /** True when readable content, the parsed log, or a message body was cut. */
  truncated: boolean
  /** Why content is incomplete. `corrupt`/`partial` report damaged JSONL. */
  truncationReasons?: Array<'size' | 'entries' | 'content' | 'corrupt' | 'partial'>
  /** Only the newest bounded part of the log is parsed. */
  pagination: {
    mode: 'tail'
    sourceBytes: number
    readBytes: number
    omittedBytes: number
  }
  entries: ConversationEntry[]
}

const MAX_ENTRIES = 400
const MAX_LOG_BYTES = 8 * 1024 * 1024
const MAX_TEXT = 20_000
const MAX_THINKING = 12_000
const MAX_TOOL_RESULT = 6_000
const MAX_TOOL_ARGS = 4_000

function clamp(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, limit), truncated: true }
}

function blocksOf(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? content.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []
}

/** Split one content array into visible text, reasoning and tool calls. */
function splitContent(content: unknown): { text: string; thinking: string; calls: Array<{ id: string; name: string; arguments: string }> } {
  let text = ''
  let thinking = ''
  const calls: Array<{ id: string; name: string; arguments: string }> = []
  for (const block of blocksOf(content)) {
    const type = String(block.type ?? '')
    if (type === 'text') {
      text += typeof block.text === 'string' ? block.text : ''
    } else if (type === 'thinking' || type === 'reasoning') {
      const value = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : ''
      thinking += value
    } else if (type === 'tool-call' || type === 'tool_use') {
      calls.push({
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : 'tool',
        arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
      })
    }
  }
  return { text, thinking, calls }
}

function safeSessionSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[\\/\0]/.test(value)
}

async function findSessionFile(paths: TaskPaths, workId: string, sessionId: string): Promise<string | null> {
  if (!safeSessionSegment(sessionId)) throw new AppError('STATE_CORRUPT', `执行者 ${workId} 的会话 ID 不安全`)
  const fileName = 'session.v4.jsonl'
  const direct = join(paths.sessionsDir, sessionId, fileName)
  if ((await stat(direct).catch(() => null))?.isFile() === true) return direct

  const found: string[] = []
  const directory = await opendir(paths.sessionsDir).catch(() => null)
  if (directory === null) return null
  try {
    for await (const entry of directory) {
      if (!entry.isDirectory()) continue
      const candidate = join(paths.sessionsDir, entry.name, sessionId, fileName)
      if ((await stat(candidate).catch(() => null))?.isFile() === true) {
        found.push(candidate)
        if (found.length > 1) break
      }
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  if (found.length > 1) {
    throw new AppError('STATE_CORRUPT', `执行者 ${workId} 的会话日志存在多个候选，无法确定当前日志`)
  }
  return found[0] ?? null
}

/** Resolve which session belongs to a Work by reading the task state. */
async function sessionIdForWork(paths: TaskPaths, workId: string): Promise<string> {
  const raw = await readFile(paths.stateFile, 'utf8').catch(() => null)
  if (raw === null) throw new AppError('TASK_NOT_FOUND', '任务已删除或尚未初始化')
  let state: Record<string, unknown>
  try {
    state = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new AppError('INVALID_STATE', '任务状态文件无法解析')
  }
  const works = state.works
  if (typeof works !== 'object' || works === null || Array.isArray(works)) {
    throw new AppError('INVALID_STATE', '任务状态中的 works 无效')
  }
  const work = (works as Record<string, unknown>)[workId]
  if (typeof work !== 'object' || work === null || Array.isArray(work)) {
    throw new AppError('WORK_NOT_FOUND', `找不到执行者：${workId}`)
  }
  const sessionId = typeof (work as Record<string, unknown>).sessionId === 'string'
    ? (work as Record<string, unknown>).sessionId as string
    : ''
  if (sessionId.length === 0) throw new AppError('WORK_NOT_FOUND', `执行者 ${workId} 还没有会话`)
  return sessionId
}

async function readTail(file: string): Promise<{
  text: string
  sourceBytes: number
  readBytes: number
  omittedBytes: number
}> {
  const info = await stat(file)
  const start = Math.max(0, info.size - MAX_LOG_BYTES)
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(info.size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline < 0 ? '' : text.slice(newline + 1)
    }
    return { text, sourceBytes: info.size, readBytes: bytesRead, omittedBytes: start }
  } finally {
    await handle.close()
  }
}

/**
 * Build the chat transcript for one Work.
 *
 * `assistant/attempt` events are deliberately ignored: they carry the raw
 * provider stream, while `assistant/message` is the settled message. Using both
 * would double every answer.
 */
export async function readWorkConversation(paths: TaskPaths, workId: string): Promise<ConversationResult> {
  const sessionId = await sessionIdForWork(paths, workId)
  const file = await findSessionFile(paths, workId, sessionId)
  if (file === null) {
    return {
      workId,
      sessionId,
      truncated: false,
      pagination: { mode: 'tail', sourceBytes: 0, readBytes: 0, omittedBytes: 0 },
      entries: [],
    }
  }
  const source = await readTail(file)
  const entries: ConversationEntry[] = []
  const reasons = new Set<NonNullable<ConversationResult['truncationReasons']>[number]>()
  if (source.omittedBytes > 0) reasons.add('size')
  let contentTruncated = false
  let localSeq = 0
  let lastSeq = 0
  const lines = source.text.split(/\r?\n/)
  const lastLine = lines.findLast((line) => line.trim().length > 0)
  // A JSONL writer appends the newline with the record. A non-empty final line
  // without one is a write still in progress; parsing it could expose or cache
  // a truncated value, so wait for the next poll instead.
  if (source.readBytes > 0 && !/(\r?\n)$/.test(source.text)) reasons.add('partial')

  for (const line of lines) {
    if (line.trim().length === 0) continue
    if (line === lastLine && reasons.has('partial')) continue
    let event: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reasons.add('corrupt')
        continue
      }
      event = parsed as Record<string, unknown>
    } catch {
      reasons.add('corrupt')
      continue
    }
    const type = String(event.type ?? '')
    const eventSeq = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : undefined
    const nextSeq = (): number => {
      if (eventSeq !== undefined) return eventSeq
      localSeq = Math.max(localSeq + 1, lastSeq + 1)
      return localSeq
    }
    const data = (event.data ?? {}) as Record<string, unknown>
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
      reasons.add('corrupt')
      continue
    }
    const time = typeof event.time === 'number' ? new Date(event.time).toISOString() : ''

    if (type === 'user/message') {
      const split = splitContent(data.content)
      if (split.text.trim().length === 0) continue
      const body = clamp(split.text, MAX_TEXT)
      contentTruncated ||= body.truncated
      const seq = nextSeq()
      lastSeq = seq
      entries.push({ seq, role: 'user', at: time, text: body.text })
      continue
    }

    if (type === 'assistant/message') {
      const message = (data.message ?? {}) as Record<string, unknown>
      const split = splitContent(message.content)
      const body = clamp(split.text, MAX_TEXT)
      const thinking = clamp(split.thinking, MAX_THINKING)
      contentTruncated ||= body.truncated || thinking.truncated
      const usage = (data.usage ?? {}) as Record<string, unknown>
      if (body.text.trim().length > 0 || thinking.text.trim().length > 0) {
        const seq = nextSeq()
        lastSeq = seq
        entries.push({
          seq,
          role: 'assistant',
          at: time,
          text: body.text,
          ...(thinking.text.trim().length > 0 ? { thinking: thinking.text } : {}),
          usage: {
            inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
            outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
          },
        })
      }
      for (const call of split.calls) {
        const args = clamp(call.arguments, MAX_TOOL_ARGS)
        contentTruncated ||= args.truncated
        const seq = nextSeq()
        lastSeq = seq
        entries.push({
          seq,
          role: 'tool',
          at: time,
          text: '',
          tool: { kind: 'call', callId: call.id, name: call.name, arguments: args.text, truncated: args.truncated },
        })
      }
      continue
    }

    if (type === 'tool/call') {
      const args = clamp(typeof data.arguments === 'string' ? data.arguments : '', MAX_TOOL_ARGS)
      contentTruncated ||= args.truncated
      const seq = nextSeq()
      lastSeq = seq
      entries.push({
        seq,
        role: 'tool',
        at: time,
        text: '',
        tool: {
          kind: 'call',
          callId: typeof data.callId === 'string' ? data.callId : '',
          name: typeof data.name === 'string' ? data.name : 'tool',
          arguments: args.text,
          truncated: args.truncated,
        },
      })
      continue
    }

    if (type === 'tool/result') {
      const message = (data.message ?? {}) as Record<string, unknown>
      const split = splitContent(message.content)
      const body = clamp(split.text, MAX_TOOL_RESULT)
      contentTruncated ||= body.truncated
      const seq = nextSeq()
      lastSeq = seq
      entries.push({
        seq,
        role: 'tool',
        at: time,
        text: body.text,
        tool: {
          kind: 'result',
          callId:
            typeof data.toolCallId === 'string'
              ? data.toolCallId
              : typeof message.toolCallId === 'string'
                ? message.toolCallId
                : '',
          truncated: body.truncated,
        },
      })
      continue
    }

    if (type === 'llm/retry') {
      const failure = (data.failure ?? {}) as Record<string, unknown>
      const seq = nextSeq()
      lastSeq = seq
      entries.push({
        seq,
        role: 'status',
        at: time,
        text: '',
        status: {
          kind: 'retry',
          code: typeof failure.code === 'string' ? failure.code : undefined,
          message: `第 ${String(data.retry ?? '?')} 次重试`,
        },
      })
      continue
    }

    if (type === 'turn/end') {
      const reason = (data.reason ?? {}) as Record<string, unknown>
      const kind = String(reason.kind ?? '')
      if (kind === 'error') {
        const error = (reason.error ?? {}) as Record<string, unknown>
        const seq = nextSeq()
        lastSeq = seq
        entries.push({
          seq,
          role: 'status',
          at: time,
          text: '',
          status: {
            kind: 'error',
            code: typeof error.code === 'string' ? error.code : undefined,
            message: typeof error.message === 'string' ? error.message : '本轮以错误结束',
          },
        })
      } else {
        const seq = nextSeq()
        lastSeq = seq
        entries.push({
          seq,
          role: 'status',
          at: time,
          text: '',
          status: { kind: 'end', message: kind === 'stop' ? '本轮结束' : `本轮结束（${kind}）` },
        })
      }
      continue
    }
  }

  const kept = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries
  if (contentTruncated) reasons.add('content')
  if (kept.length < entries.length) reasons.add('entries')
  return {
    workId,
    sessionId,
    truncated: reasons.size > 0,
    ...(reasons.size > 0 ? { truncationReasons: [...reasons] } : {}),
    pagination: {
      mode: 'tail',
      sourceBytes: source.sourceBytes,
      readBytes: source.readBytes,
      omittedBytes: source.omittedBytes,
    },
    entries: kept,
  }
}
