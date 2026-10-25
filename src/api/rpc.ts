/** Request dispatch for the runtime's local HTTP API. */

import type { Engine } from '../core/engine.ts'
import { AppError } from '../util/errors.ts'

type Params = Record<string, unknown>

function asParams(value: unknown): Params {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGUMENT', 'params 必须是对象')
  }
  return value as Params
}

/** Required string argument; never coerce numbers/objects into text. */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AppError('INVALID_ARGUMENT', `${field} 必须是字符串`)
  return value
}

/** Optional string argument; `undefined`/`null` mean "not provided". */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AppError('INVALID_ARGUMENT', `${field} 必须是字符串`)
  return value
}

/**
 * Mutating work operations are counted from admission through commit. A
 * completion check cannot slip between a finding/message/consensus request
 * and the runtime write it performs.
 */
const MUTATING_WORK_OPS = new Set([
  'findings.append',
  'work.update',
  'peer.send',
  'executor.spawn',
  'executor.retire',
  'completion.propose',
  'completion.respond',
  'completion.withdraw',
  'activity.reconcile',
  'report.read',
  'report.publish',
])

/** Dispatch one work-scoped operation. The work identity always comes from the request header. */
export async function dispatchWorkOp(
  engine: Engine,
  workId: string,
  op: string,
  rawParams: unknown,
): Promise<unknown> {
  const params = asParams(rawParams)
  if (!MUTATING_WORK_OPS.has(op)) return dispatchWorkOpInner(engine, workId, op, params)
  engine.beginProtocolWrite()
  try {
    return await dispatchWorkOpInner(engine, workId, op, params)
  } finally {
    engine.endProtocolWrite()
  }
}

async function dispatchWorkOpInner(
  engine: Engine,
  workId: string,
  op: string,
  params: Params,
): Promise<unknown> {
  switch (op) {
    case 'shared.read':
      return engine.readShared(workId, {
        section: typeof params.section === 'string' ? params.section : undefined,
        max_chars: params.max_chars,
      })
    case 'shared.query':
      return engine.queryShared(workId, {
        scope: typeof params.scope === 'string' ? params.scope : undefined,
        view: typeof params.view === 'string' ? params.view : undefined,
        text: typeof params.text === 'string' ? params.text : undefined,
        author: typeof params.author === 'string' ? params.author : undefined,
        type: typeof params.type === 'string' ? params.type : undefined,
        refs: typeof params.refs === 'string' ? params.refs : undefined,
        since: typeof params.since === 'string' ? params.since : undefined,
        limit: params.limit,
        offset: params.offset,
      })
    case 'findings.get':
      return engine.getFinding(workId, requiredString(params.id, 'id'), { history: params.history === true })
    case 'report.read':
      return engine.readReport(workId, { key: params.key })
    case 'report.publish':
      return engine.publishReport(workId, {
        key: params.key,
        path: params.path,
        draft_path: params.draft_path,
        base_revision: params.base_revision,
        request_id: requiredString(params.request_id, 'request_id'),
        restore: params.restore,
      })
    case 'findings.append':
      return engine.appendFinding(workId, {
        text: requiredString(params.text, 'text'),
        type: optionalString(params.type, 'type'),
        refs: params.refs,
        evidence: params.evidence,
        supersedes: params.supersedes,
        related_work: params.related_work,
        request_id: optionalString(params.request_id, 'request_id'),
      })
    case 'work.update':
      return engine.updateWork(workId, {
        direction: typeof params.direction === 'string' ? params.direction : undefined,
        self_status: typeof params.self_status === 'string' ? params.self_status : undefined,
      })
    case 'self.inspect':
      return engine.inspectSelf(workId)
    case 'peer.send':
      return engine.sendMessage(workId, {
        to: params.to,
        kind: typeof params.kind === 'string' ? params.kind : undefined,
        body: requiredString(params.body, 'body'),
        refs: params.refs,
        request_id: optionalString(params.request_id, 'request_id'),
      })
    case 'peer.inbox':
      return engine.readInbox(workId, {
        limit: params.limit,
        include_delivered: params.include_delivered,
        include_system: params.include_system,
      })
    case 'executor.spawn':
      return engine.spawnWork(workId, {
        reason: requiredString(params.reason, 'reason'),
        start_prompt: requiredString(params.start_prompt, 'start_prompt'),
        refs: params.refs,
        request_id: optionalString(params.request_id, 'request_id'),
      })
    case 'executor.wait':
      return engine.waitForEvents(workId, {
        timeout_seconds: params.timeout_seconds,
        after_event_id: params.after_event_id,
      })
    case 'executor.retire':
      return engine.retireWork(workId, { reason: requiredString(params.reason, 'reason') })
    case 'completion.propose':
      return engine.proposeCompletion(workId, {
        reason: optionalString(params.reason, 'reason'),
        refs: params.refs,
      })
    case 'completion.respond':
      return engine.respondCompletion(workId, {
        round_id: requiredString(params.round_id, 'round_id'),
        opinion: requiredString(params.opinion, 'opinion'),
        reason: optionalString(params.reason, 'reason'),
        refs: params.refs,
      })
    case 'completion.withdraw':
      return engine.withdrawCompletion(workId, {
        round_id: requiredString(params.round_id, 'round_id'),
        reason: optionalString(params.reason, 'reason'),
      })
    case 'completion.status':
      return engine.completionStatus(workId)
    case 'activity.reconcile':
      return engine.reconcileWorkActivity(workId, {
        action_ids: params.action_ids,
        note: typeof params.note === 'string' ? params.note : undefined,
      })
    default:
      throw new AppError('UNKNOWN_OP', `未知操作：${op}`)
  }
}

/** Dispatch one human administration operation. */
export async function dispatchAdminOp(engine: Engine, op: string, rawParams: unknown): Promise<unknown> {
  const params = asParams(rawParams)
  switch (op) {
    case 'task.status':
      return engine.adminSnapshot()
    case 'task.set_end':
      return engine.setEndInformation(requiredString(params.text, 'text'))
    case 'task.set_start':
      return engine.setStartInformation(requiredString(params.text, 'text'))
    case 'task.stop':
      return engine.stopTask(
        typeof params.reason === 'string' && params.reason.length > 0 ? params.reason : undefined,
      )
    case 'task.command':
      return engine.sendCommand({
        text: requiredString(params.text, 'text'),
        requestId: requiredString(params.request_id, 'request_id'),
        source:
          params.source === 'web' || params.source === 'cli' || params.source === 'api'
            ? params.source
            : undefined,
      })
    case 'task.continue':
      return engine.continueTask({
        text: requiredString(params.text, 'text'),
        requestId: requiredString(params.request_id, 'request_id'),
        source:
          params.source === 'web' || params.source === 'cli' || params.source === 'api'
            ? params.source
            : undefined,
        executionsStopped: params.executions_stopped === true,
      })
    case 'task.recover':
      return engine.recoverTask({
        requestId: requiredString(params.request_id, 'request_id'),
        source:
          params.source === 'web' || params.source === 'cli' || params.source === 'api'
            ? params.source
            : undefined,
      })
    case 'commands.list':
      return { commands: await engine.listCommands() }
    case 'messages.list':
      return { messages: await engine.listMessages() }
    default:
      throw new AppError('UNKNOWN_OP', `未知管理操作：${op}`)
  }
}
