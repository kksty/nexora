/**
 * Normalization of raw harness session events into the runtime's small
 * activity vocabulary.
 *
 * This is a thin adapter over the SDK's documented `session.event` and
 * `session.status` notifications. It reads only identity, lifecycle and job
 * facts; tool arguments and message bodies are passed through untouched.
 */

import type { ActivityEvent } from '../types.ts'

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isoFrom(value: unknown, fallback: number): string {
  const ms = asNumber(value) ?? fallback
  return new Date(ms).toISOString()
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.type !== 'text') continue
    const text = asString(record.text)
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/** Convert one `session.event` payload into an activity event, or null if irrelevant. */
export function normalizeSessionEvent(
  raw: unknown,
  sessionId: string,
  generation: number,
): ActivityEvent | null {
  const event = asRecord(raw)
  if (event === undefined) return null
  const type = asString(event.type)
  const seq = asNumber(event.seq)
  const time = asNumber(event.time)
  if (type === undefined || seq === undefined || time === undefined) return null
  const at = isoFrom(time, Date.now())
  const data = asRecord(event.data) ?? {}
  switch (type) {
    case 'liebian/terminals': {
      if (!Array.isArray(data.terminals)) return null
      const terminals: { id: string; label: string }[] = []
      for (const item of data.terminals) {
        const terminal = asRecord(item)
        if (typeof terminal?.id !== 'string' || typeof terminal.label !== 'string') return null
        terminals.push({ id: terminal.id, label: terminal.label })
      }
      return { kind: 'terminal-snapshot', sessionId, generation, sourceGeneration: asNumber(data.generation) ?? generation, seq, at, terminals }
    }
    case 'turn/start': {
      const turn = asNumber(data.turn)
      if (turn === undefined) return null
      return { kind: 'turn-start', sessionId, generation, seq, at, turn }
    }
    case 'turn/end': {
      const turn = asNumber(data.turn)
      if (turn === undefined) return null
      const reason = asRecord(data.reason)
      const kind = asString(reason?.kind)
      return {
        kind: 'turn-end',
        sessionId,
        generation,
        seq,
        at,
        turn,
        ...(kind === undefined ? {} : { detail: kind }),
      }
    }
    case 'step/start':
    case 'step/end': {
      const turn = asNumber(data.turn)
      const step = asNumber(data.step)
      if (turn === undefined || step === undefined) return null
      return { kind: type === 'step/start' ? 'step-start' : 'step-end', sessionId, generation, seq, at, turn, step }
    }
    case 'tool/call': {
      const callId = asString(data.callId)
      const name = asString(data.name)
      const turn = asNumber(data.turn)
      const step = asNumber(data.step)
      if (callId === undefined || name === undefined || turn === undefined || step === undefined) return null
      const args = asString(data.arguments)
      return {
        kind: 'tool-call',
        sessionId,
        generation,
        seq,
        at,
        callId,
        name,
        turn,
        step,
        ...(args === undefined ? {} : { arguments: args }),
      }
    }
    case 'tool/result': {
      const message = asRecord(data.message)
      const callId = asString(message?.toolCallId)
      if (callId === undefined) return null
      return {
        kind: 'tool-result',
        sessionId,
        generation,
        seq,
        at,
        callId,
        isError: message?.isError === true,
      }
    }
    case 'job/registered': {
      const jobId = asString(data.jobId)
      const owner = asString(data.owner)
      const toolCall = asRecord(data.toolCall)
      if (jobId === undefined || owner === undefined) return null
      const callId = asString(toolCall?.callId)
      const rootCallId = asString(toolCall?.rootCallId)
      return {
        kind: 'job-registered',
        sessionId,
        generation,
        seq,
        at,
        jobId,
        jobKind: asString(data.kind) ?? 'job',
        label: asString(data.label) ?? jobId,
        ownerSessionId: owner,
        startedAt: isoFrom(data.startedAt, time),
        ...(callId === undefined ? {} : { toolCallId: callId }),
        ...(rootCallId === undefined ? {} : { rootToolCallId: rootCallId }),
      }
    }
    case 'job/settled': {
      const jobId = asString(data.jobId)
      const status = asString(data.status)
      const owner = asString(data.owner)
      if (jobId === undefined || owner === undefined) return null
      if (status !== 'completed' && status !== 'killed' && status !== 'failed') return null
      const toolCall = asRecord(data.toolCall)
      const callId = asString(toolCall?.callId)
      const rootCallId = asString(toolCall?.rootCallId)
      return {
        kind: 'job-settled',
        sessionId,
        generation,
        seq,
        at,
        jobId,
        jobKind: asString(data.kind) ?? 'job',
        label: asString(data.label) ?? jobId,
        ownerSessionId: owner,
        startedAt: isoFrom(data.startedAt, time),
        ...(callId === undefined ? {} : { toolCallId: callId }),
        ...(rootCallId === undefined ? {} : { rootToolCallId: rootCallId }),
        status,
        cause: asString(data.cause) ?? 'unknown',
        producerReported: data.producerReported === true,
        ...(asString(data.detail) === undefined ? {} : { detail: asString(data.detail) }),
        finishedAt: isoFrom(data.finishedAt, time),
      }
    }
    case 'user/message': {
      const messageId = asString(data.id)
      if (messageId === undefined) return null
      const source = asRecord(data.source)
      const sourceKind = asString(source?.kind)
      const form = asString(source?.form)
      return {
        kind: 'user-message',
        sessionId,
        generation,
        seq,
        at,
        messageId,
        ...(sourceKind === undefined ? {} : { sourceKind }),
        ...(form === undefined ? {} : { form }),
        text: messageText(data.content),
      }
    }
    default:
      return null
  }
}

/** Convert one `session.status` notification into an activity event. */
export function normalizeSessionStatus(
  sessionId: string,
  generation: number,
  status: unknown,
  now = Date.now(),
): ActivityEvent | null {
  if (status !== 'idle' && status !== 'running') return null
  return {
    kind: 'status',
    sessionId,
    generation,
    at: new Date(now).toISOString(),
    status,
  }
}
