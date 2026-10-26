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
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '../util/errors.ts'
import type { TaskPaths } from '../core/paths.ts'

export type ConversationRole = 'user' | 'assistant' | 'tool' | 'status'

export interface ConversationEntry {
  /** Monotonic position in the transcript. */
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
  /** True when the log was cut because the Work produced a lot of output. */
  truncated: boolean
  entries: ConversationEntry[]
}

const MAX_ENTRIES = 400
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

async function findSessionFile(paths: TaskPaths, sessionId: string): Promise<string | null> {
  const direct = join(paths.sessionsDir, sessionId, 'session.v4.jsonl')
  const entries = await readdir(paths.sessionsDir, { withFileTypes: true }).catch(() => [])
  const candidates: string[] = [direct]
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    candidates.push(join(paths.sessionsDir, entry.name, sessionId, 'session.v4.jsonl'))
  }
  for (const candidate of candidates) {
    const raw = await readFile(candidate, 'utf8').catch(() => null)
    if (raw !== null) return candidate
  }
  return null
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
  const works = (state.works ?? {}) as Record<string, Record<string, unknown>>
  const work = works[workId]
  if (work === undefined) throw new AppError('WORK_NOT_FOUND', `找不到执行者：${workId}`)
  const sessionId = typeof work.sessionId === 'string' ? work.sessionId : ''
  if (sessionId.length === 0) throw new AppError('WORK_NOT_FOUND', `执行者 ${workId} 还没有会话`)
  return sessionId
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
  const file = await findSessionFile(paths, sessionId)
  if (file === null) {
    return { workId, sessionId, truncated: false, entries: [] }
  }
  const raw = await readFile(file, 'utf8')
  const entries: ConversationEntry[] = []
  let truncated = false
  let seq = 0

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = String(event.type ?? '')
    const data = (event.data ?? {}) as Record<string, unknown>
    const time = typeof event.time === 'number' ? new Date(event.time).toISOString() : ''

    if (type === 'user/message') {
      const split = splitContent(data.content)
      if (split.text.trim().length === 0) continue
      const body = clamp(split.text, MAX_TEXT)
      truncated = truncated || body.truncated
      seq += 1
      entries.push({ seq, role: 'user', at: time, text: body.text })
      continue
    }

    if (type === 'assistant/message') {
      const message = (data.message ?? {}) as Record<string, unknown>
      const split = splitContent(message.content)
      const body = clamp(split.text, MAX_TEXT)
      const thinking = clamp(split.thinking, MAX_THINKING)
      truncated = truncated || body.truncated
      const usage = (data.usage ?? {}) as Record<string, unknown>
      if (body.text.trim().length > 0 || thinking.text.trim().length > 0) {
        seq += 1
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
        truncated = truncated || args.truncated
        seq += 1
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

    if (type === 'tool/result') {
      const message = (data.message ?? {}) as Record<string, unknown>
      const split = splitContent(message.content)
      const body = clamp(split.text, MAX_TOOL_RESULT)
      truncated = truncated || body.truncated
      seq += 1
      entries.push({
        seq,
        role: 'tool',
        at: time,
        text: body.text,
        tool: {
          kind: 'result',
          callId: typeof data.toolCallId === 'string' ? data.toolCallId : '',
          truncated: body.truncated,
        },
      })
      continue
    }

    if (type === 'llm/retry') {
      const failure = (data.failure ?? {}) as Record<string, unknown>
      seq += 1
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
        seq += 1
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
        seq += 1
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
  return { workId, sessionId, truncated: truncated || kept.length < entries.length, entries: kept }
}
