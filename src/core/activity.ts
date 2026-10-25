/**
 * Projection of a harness session's actual activity.
 *
 * The harness is the source of truth for tools, background jobs and the
 * whole-agent status. This module reduces its ordered events into a small
 * persisted snapshot the runtime can reason about:
 *
 * - which foreground tools have not returned yet,
 * - which background jobs are running or settled but not yet handed to the
 *   model,
 * - which actions became unknown because the process ended,
 * - whether the session is idle or inside a model turn.
 *
 * It deliberately does not interpret tool output or domain meaning.
 */

import type {
  ActivityEvent,
  JobActivityRecord,
  ToolActivityRecord,
  WorkActivity,
  WorkRecord,
} from '../types.ts'
import { nowIso } from '../util/time.ts'

const RUNTIME_TOOL_PREFIX = 'mcp__liebian__'
const MAX_INBOUND_MESSAGES = 200
const MAX_ARGUMENT_CHARS = 8_000
const MAX_LABEL_CHARS = 500
const MAX_SETTLED_JOBS = 100

/** Runtime protocol calls that never represent domain exploration. */
export function isRuntimeTool(name: string): boolean {
  return name.startsWith(RUNTIME_TOOL_PREFIX)
}

/**
 * Tools that only read job state. They do not start exploration, and an open
 * read does not prevent completion unless it is an explicit wait.
 */
export function isJobQueryTool(name: string): boolean {
  return name === 'job_list' || name === 'job_output'
}

/** True when starting this tool is real work that invalidates old agreement. */
export function isBlockingTool(name: string): boolean {
  if (isRuntimeTool(name)) return false
  if (isJobQueryTool(name)) return false
  return true
}

function parseArguments(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * A call the model is blocked on by design: the runtime wait tool, or a
 * `job_output` that asked to wait for settlement. These may stay open while
 * the rest of the session is quiescent, so they must not lock completion.
 */
export function isWaitingTool(tool: ToolActivityRecord): boolean {
  if (tool.name === `${RUNTIME_TOOL_PREFIX}executor_wait`) return true
  if (tool.name !== 'job_output') return false
  const args = parseArguments(tool.arguments)
  return args?.wait === true
}

/** Build an empty projection for a work whose harness process has not reported yet. */
export function emptyActivity(generation = 0): WorkActivity {
  const at = nowIso()
  return {
    generation,
    sessionStatus: 'idle',
    lastEventSeq: 0,
    updatedAt: at,
    tools: {},
    jobs: {},
    inboundMessages: {},
  }
}

export interface ActivityChange {
  changed: boolean
  /** Set when this event starts real work or delivers a job result. */
  invalidateReason?: string
  /** Set when a settled job still needs its notice handed to the model. */
  pendingNotice?: string
  /** Job ids whose settlement notice entered the model context. */
  deliveredNotices: string[]
  /** True when the event may have made the session more quiescent. */
  settled: boolean
}

function touch(activity: WorkActivity, event: { seq?: number; at: string }): void {
  activity.updatedAt = event.at
  if (event.seq !== undefined) {
    if (event.seq > activity.lastEventSeq) activity.lastEventSeq = event.seq
    activity.lastEventAt = event.at
  }
}

function recordInbound(
  activity: WorkActivity,
  event: Extract<ActivityEvent, { kind: 'user-message' }>,
): void {
  activity.inboundMessages[event.messageId] = {
    at: event.at,
    ...(event.sourceKind === undefined ? {} : { sourceKind: event.sourceKind }),
    ...(event.form === undefined ? {} : { form: event.form }),
  }
  const ids = Object.keys(activity.inboundMessages)
  if (ids.length <= MAX_INBOUND_MESSAGES) return
  for (const id of ids.slice(0, ids.length - MAX_INBOUND_MESSAGES)) delete activity.inboundMessages[id]
}

/**
 * True when `text` mentions the job id as a whole token, so `bash-1` is not
 * considered mentioned by a notification about `bash-10`. Job ids use
 * alphanumerics, `-`, `_` and `.`; a boundary is any other character.
 */
function mentionsJobId(text: string, jobId: string): boolean {
  if (jobId.length === 0) return false
  const escaped = jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`).test(text)
}

function jobFromSettledEvent(event: Extract<ActivityEvent, { kind: 'job-settled' }>): JobActivityRecord {
  return {
    jobId: event.jobId,
    kind: event.jobKind,
    label: event.label,
    ownerSessionId: event.ownerSessionId,
    startedAt: event.startedAt,
    registeredSeq: event.seq,
    ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
    ...(event.rootToolCallId === undefined ? {} : { rootToolCallId: event.rootToolCallId }),
    status: event.status,
    settledAt: event.finishedAt,
    settledSeq: event.seq,
    cause: event.cause,
    producerReported: event.producerReported,
    ...(event.detail === undefined ? {} : { detail: event.detail }),
    notice: 'pending',
  }
}

/**
 * A settlement is already visible to the model when the tool that started the
 * job is still awaiting it (foreground command), or when an explicit
 * `job_output {wait:true}` / `job_kill` call is currently blocked on that job.
 * In those cases the registry's `awaited` path does not inject a notice.
 */
function settlementReachesModel(activity: WorkActivity, job: JobActivityRecord): boolean {
  if (job.toolCallId !== undefined && activity.tools[job.toolCallId] !== undefined) return true
  for (const tool of Object.values(activity.tools)) {
    if (tool.name !== 'job_output' && tool.name !== 'job_kill') continue
    const args = parseArguments(tool.arguments)
    if (args?.job_id !== job.jobId) continue
    if (tool.name === 'job_kill') return true
    if (args.wait === true) return true
  }
  return false
}

/** Mark a pending settlement notice as received by the model. */
export function markNoticeDelivered(activity: WorkActivity, jobId: string, at = nowIso()): boolean {
  const job = activity.jobs[jobId]
  if (job === undefined || job.notice !== 'pending') return false
  job.notice = 'delivered'
  job.noticeAt = at
  activity.updatedAt = at
  return true
}

/** Apply one normalized harness event to the persisted projection. */
export function applyActivityEvent(activity: WorkActivity, event: ActivityEvent): ActivityChange {
  const result: ActivityChange = { changed: false, deliveredNotices: [], settled: false }
  if (event.generation !== activity.generation) return result

  switch (event.kind) {
    case 'terminal-snapshot': {
      touch(activity, event)
      const prefix = `terminal:${event.sourceGeneration ?? event.generation}:`
      const current = new Set(event.terminals.map((terminal) => `${prefix}${terminal.id}`))
      for (const terminal of event.terminals) {
        const jobId = `${prefix}${terminal.id}`
        if (activity.jobs[jobId] !== undefined) continue
        activity.jobs[jobId] = {
          jobId, kind: 'terminal', label: `交互终端 ${terminal.label}`.slice(0, MAX_LABEL_CHARS),
          ownerSessionId: event.sessionId, startedAt: event.at, registeredSeq: event.seq,
          status: 'running', notice: 'none',
        }
        result.invalidateReason = 'work 打开交互式终端'
      }
      for (const job of Object.values(activity.jobs)) {
        if (job.kind !== 'terminal' || !job.jobId.startsWith(prefix) || current.has(job.jobId) ||
          (job.status !== 'running' && job.status !== 'unknown')) continue
        job.status = 'completed'
        job.settledAt = event.at
        job.settledSeq = event.seq
        job.notice = 'none'
        result.settled = true
      }
      result.changed = true
      return result
    }
    case 'status': {
      if (activity.sessionStatus !== event.status) {
        activity.sessionStatus = event.status
        activity.updatedAt = event.at
        result.changed = true
      }
      result.settled = event.status === 'idle'
      return result
    }
    case 'turn-start': {
      touch(activity, event)
      // The log boundary is authoritative even if a status notification is
      // delayed or lost: this turn is running until it ends.
      if (activity.sessionStatus !== 'running') {
        activity.sessionStatus = 'running'
      }
      result.changed = true
      return result
    }
    case 'turn-end': {
      touch(activity, event)
      activity.sessionStatus = 'idle'
      result.changed = true
      result.settled = true
      return result
    }
    case 'step-start':
    case 'step-end': {
      touch(activity, event)
      result.changed = true
      return result
    }
    case 'tool-call': {
      touch(activity, event)
      result.changed = true
      if (activity.tools[event.callId] !== undefined) return result
      const blocking = isBlockingTool(event.name)
      const tool: ToolActivityRecord = {
        callId: event.callId,
        name: event.name,
        turn: event.turn,
        step: event.step,
        startedAt: event.at,
        eventSeq: event.seq,
        blocking,
        ...(event.arguments === undefined
          ? {}
          : { arguments: event.arguments.slice(0, MAX_ARGUMENT_CHARS) }),
      }
      activity.tools[event.callId] = tool
      if (blocking) result.invalidateReason = `work 启动实际执行工具 ${event.name}`
      return result
    }
    case 'tool-result': {
      touch(activity, event)
      const tool = activity.tools[event.callId]
      if (tool === undefined) return result
      delete activity.tools[event.callId]
      result.changed = true
      result.settled = true
      if (tool.name === 'job_output' || tool.name === 'job_kill') {
        const args = parseArguments(tool.arguments)
        const jobId = typeof args?.job_id === 'string' ? args.job_id : undefined
        if (jobId !== undefined && markNoticeDelivered(activity, jobId, event.at)) {
          result.deliveredNotices.push(jobId)
          result.invalidateReason = '后台任务结果已交给模型'
        }
      }
      return result
    }
    case 'job-registered': {
      touch(activity, event)
      result.changed = true
      if (activity.jobs[event.jobId] !== undefined) return result
      activity.jobs[event.jobId] = {
        jobId: event.jobId,
        kind: event.jobKind,
        label: event.label.slice(0, MAX_LABEL_CHARS),
        ownerSessionId: event.ownerSessionId,
        startedAt: event.startedAt,
        registeredSeq: event.seq,
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        ...(event.rootToolCallId === undefined ? {} : { rootToolCallId: event.rootToolCallId }),
        status: 'running',
        notice: 'none',
      }
      return result
    }
    case 'job-settled': {
      touch(activity, event)
      result.changed = true
      const existing = activity.jobs[event.jobId]
      const job = existing ?? jobFromSettledEvent(event)
      job.kind = event.jobKind
      job.label = event.label.slice(0, MAX_LABEL_CHARS)
      job.ownerSessionId = event.ownerSessionId
      if (event.toolCallId !== undefined) job.toolCallId = event.toolCallId
      if (event.rootToolCallId !== undefined) job.rootToolCallId = event.rootToolCallId
      job.status = event.status
      job.settledAt = event.finishedAt
      job.settledSeq = event.seq
      job.cause = event.cause
      job.producerReported = event.producerReported
      if (event.detail !== undefined) job.detail = event.detail
      activity.jobs[event.jobId] = job
      if (settlementReachesModel(activity, job)) {
        job.notice = 'none'
      } else if (job.notice !== 'delivered') {
        job.notice = 'pending'
        result.pendingNotice = event.jobId
      }
      result.settled = true
      return result
    }
    case 'user-message': {
      touch(activity, event)
      recordInbound(activity, event)
      result.changed = true
      if (event.sourceKind !== 'tool-jobs') return result
      const text = event.text ?? ''
      for (const job of Object.values(activity.jobs)) {
        if (job.notice !== 'pending') continue
        if (!mentionsJobId(text, job.jobId)) continue
        job.notice = 'delivered'
        job.noticeAt = event.at
        result.deliveredNotices.push(job.jobId)
      }
      if (result.deliveredNotices.length > 0) {
        activity.updatedAt = event.at
        result.invalidateReason = '后台任务结果已进入模型上下文'
      }
      return result
    }
    default:
      return result
  }
}

/**
 * Bound the retained settled-job history. Running jobs, unknown actions and
 * pending notices are never pruned; delivered results are cheap to keep for a
 * while but must not grow state.json without bound over a long task.
 */
export function pruneActivity(activity: WorkActivity): boolean {
  const settled = Object.values(activity.jobs).filter(
    (job) =>
      job.status !== 'running' &&
      job.status !== 'stopping' &&
      job.status !== 'unknown' &&
      job.notice !== 'pending',
  )
  if (settled.length <= MAX_SETTLED_JOBS) return false
  settled.sort((left, right) => (left.settledSeq ?? left.registeredSeq) - (right.settledSeq ?? right.registeredSeq))
  for (const job of settled.slice(0, settled.length - MAX_SETTLED_JOBS)) {
    delete activity.jobs[job.jobId]
  }
  return true
}

/**
 * Mark every action left open by a dead harness process as unknown. Protocol
 * calls and job queries from that process need no reconciliation; blocking
 * tools and jobs do.
 */
export function markActivityUnknown(activity: WorkActivity): boolean {
  let changed = false
  for (const [callId, tool] of Object.entries(activity.tools)) {
    if (tool.blocking) {
      if (!tool.orphaned) {
        tool.orphaned = true
        changed = true
      }
    } else {
      delete activity.tools[callId]
      changed = true
    }
  }
  for (const job of Object.values(activity.jobs)) {
    if (job.status === 'running' || job.status === 'stopping') {
      job.status = 'unknown'
      job.detail = job.detail ?? 'harness 进程已结束，最终结果未知'
      changed = true
    }
  }
  if (activity.sessionStatus !== 'idle') {
    activity.sessionStatus = 'idle'
    changed = true
  }
  if (changed) activity.updatedAt = nowIso()
  return changed
}

/** Drop the old session cursor after a fresh-session fallback, keeping unknown actions. */
export function resetActivityCursor(activity: WorkActivity): void {
  activity.lastEventSeq = 0
  activity.lastEventAt = undefined
  activity.updatedAt = nowIso()
}

export interface ReconcileResult {
  resolved: string[]
  rejected: { id: string; reason: string }[]
}

/**
 * Record the model's reconciliation of actions that survived a process loss.
 * Live jobs cannot be reconciled as finished; only unknown/orphaned actions or
 * a pending settlement notice can be cleared.
 */
export function reconcileActivity(
  activity: WorkActivity,
  actionIds: readonly string[],
  note: string | undefined,
): ReconcileResult {
  const resolved: string[] = []
  const rejected: { id: string; reason: string }[] = []
  const at = nowIso()
  for (const id of actionIds) {
    const tool = activity.tools[id]
    if (tool !== undefined) {
      if (!tool.orphaned) {
        rejected.push({ id, reason: '该工具仍在当前 harness 进程中执行' })
        continue
      }
      if (tool.reconciledAt === undefined) {
        tool.reconciledAt = at
        if (note !== undefined) tool.reconciledNote = note
        resolved.push(id)
      } else {
        rejected.push({ id, reason: '该动作已经核对过' })
      }
      continue
    }
    const job = activity.jobs[id]
    if (job !== undefined) {
      if (job.reconciledAt !== undefined) {
        rejected.push({ id, reason: '该动作已经核对过' })
        continue
      }
      if (job.status === 'running' || job.status === 'stopping') {
        rejected.push({ id, reason: '后台任务仍在当前 harness 进程中运行，请先用 job_output/job_kill 处理' })
        continue
      }
      if (job.status !== 'unknown' && job.notice !== 'pending') {
        rejected.push({ id, reason: '该后台任务没有待核对的结果' })
        continue
      }
      if (job.status === 'unknown') job.reconciledAt = at
      if (note !== undefined) job.reconciledNote = note
      if (job.notice === 'pending') {
        job.notice = 'delivered'
        job.noticeAt = at
      }
      resolved.push(id)
      continue
    }
    rejected.push({ id, reason: '未找到该工具调用或后台任务' })
  }
  if (resolved.length > 0) activity.updatedAt = at
  return { resolved, rejected }
}

function describeTool(tool: ToolActivityRecord): string {
  const args = parseArguments(tool.arguments)
  const jobId = typeof args?.job_id === 'string' ? ` ${args.job_id}` : ''
  return `${tool.callId}（${tool.name}${jobId}）`
}

function describeJob(job: JobActivityRecord): string {
  const status = job.detail === undefined ? job.status : `${job.status}: ${job.detail}`
  return `${job.jobId}（${job.kind}: ${job.label}，${status}）`
}

/** Engineering blockers that prevent completion for one work. */
export function activityBlockers(work: WorkRecord): string[] {
  const activity = work.activity
  const blockers: string[] = []
  const tools = Object.values(activity.tools)
  const open = tools.filter((tool) => tool.orphaned !== true)
  const orphanedTools = tools.filter((tool) => tool.orphaned === true && tool.reconciledAt === undefined)
  if (orphanedTools.length > 0) {
    blockers.push(`work ${work.id} 有结果未知、尚未核对的工具：${orphanedTools.map(describeTool).join(', ')}`)
  }
  const blocking = open.filter((tool) => tool.blocking)
  if (blocking.length > 0) {
    blockers.push(`work ${work.id} 仍有工具在执行：${blocking.map(describeTool).join(', ')}`)
  }
  const nonWaiting = open.filter((tool) => !tool.blocking && !isWaitingTool(tool))
  if (nonWaiting.length > 0) {
    blockers.push(`work ${work.id} 仍有协议调用未返回：${nonWaiting.map(describeTool).join(', ')}`)
  }
  if (activity.sessionStatus === 'running' && open.length === 0) {
    blockers.push(`work ${work.id} 的模型轮次仍在进行`)
  }
  const unknownJobs = Object.values(activity.jobs).filter(
    (job) => job.status === 'unknown' && job.reconciledAt === undefined,
  )
  if (unknownJobs.length > 0) {
    blockers.push(`work ${work.id} 有结果未知、尚未核对的后台任务：${unknownJobs.map(describeJob).join(', ')}`)
  }
  const runningJobs = Object.values(activity.jobs).filter(
    (job) => job.status === 'running' || job.status === 'stopping',
  )
  if (runningJobs.length > 0) {
    blockers.push(`work ${work.id} 的后台任务仍在运行：${runningJobs.map(describeJob).join(', ')}`)
  }
  const pendingNotices = Object.values(activity.jobs).filter(
    (job) => job.notice === 'pending' && job.reconciledAt === undefined,
  )
  if (pendingNotices.length > 0) {
    blockers.push(
      `work ${work.id} 的后台任务结果尚未进入模型上下文：${pendingNotices.map(describeJob).join(', ')}`,
    )
  }
  return blockers
}

/** Human/model-readable activity lines for self_inspect, recovery and status. */
export function activityLines(work: WorkRecord): string[] {
  const activity = work.activity
  const lines = [`- 会话状态：${activity.sessionStatus}（进程代次 ${activity.generation}）`]
  const tools = Object.values(activity.tools)
  lines.push(
    tools.length === 0
      ? '- 未结算工具：无'
      : `- 未结算工具：${tools
          .map((tool) => `${describeTool(tool)}${tool.orphaned === true ? '［结果未知］' : ''}`)
          .join('；')}`,
  )
  const jobs = Object.values(activity.jobs)
  const liveJobs = jobs.filter((job) => job.status === 'running' || job.status === 'stopping')
  lines.push(
    liveJobs.length === 0
      ? '- 运行中的后台任务：无'
      : `- 运行中的后台任务：${liveJobs.map(describeJob).join('；')}`,
  )
  const unknownJobs = jobs.filter((job) => job.status === 'unknown' && job.reconciledAt === undefined)
  if (unknownJobs.length > 0) {
    lines.push(`- 待核对后台任务：${unknownJobs.map(describeJob).join('；')}`)
  }
  const pendingNotices = jobs.filter((job) => job.notice === 'pending')
  if (pendingNotices.length > 0) {
    lines.push(`- 待接收结果通知：${pendingNotices.map(describeJob).join('；')}`)
  }
  const lastSeq = activity.lastEventAt === undefined ? '无' : `${activity.lastEventSeq} @ ${activity.lastEventAt}`
  lines.push(`- 最后处理事件：${lastSeq}`)
  return lines
}

/** True when this projection has no blocking tools, live jobs or pending notices. */
export function activityIsQuiescent(work: WorkRecord): boolean {
  return activityBlockers(work).length === 0
}

/** True when the work has nothing left that a restart would need to reconcile. */
export function activityNeedsReconciliation(work: WorkRecord): boolean {
  return Object.values(work.activity.tools).some(
    (tool) => tool.orphaned === true && tool.reconciledAt === undefined,
  ) ||
    Object.values(work.activity.jobs).some(
      (job) =>
        (job.status === 'unknown' || job.notice === 'pending') && job.reconciledAt === undefined,
    )
}
