/**
 * The thin runtime.
 *
 * Responsibilities (docs/ARCHITECTURE.md): allocate task/work/message/finding
 * IDs, create and recover harness sessions, register fission lineage, append
 * findings atomically, persist and deliver messages, record request failures and
 * retry state, and maintain completion rounds and the atomic end-of-task commit.
 *
 * It deliberately contains no domain reasoning, no budget accounting, no work
 * scoring, no central dispatcher, and no automatic judgement that an end state
 * was reached.
 */

import { mkdir, stat } from 'node:fs/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DiagnosticLog, activityDiagnostic, positiveSetting } from '../util/diagnostics.ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { HarnessDriver, WorkSessionSpec } from '../harness/driver.ts'
import type {
  ActivityEvent,
  CommandDeliveryRecord,
  CommandDeliveryStatus,
  CommandRecord,
  CompletionRecord,
  FindingRecord,
  MessageKind,
  MessageRecord,
  Opinion,
  OpinionRecord,
  ReportRecord,
  RoundRecord,
  RunRecord,
  RuntimeState,
  TaskStatus,
  WorkOrigin,
  WorkRecord,
} from '../types.ts'
import { COMMAND_DELIVERY_STATUS_TEXT, MESSAGE_KINDS, OPINIONS } from '../types.ts'
import {
  activityBlockers,
  activityLines,
  applyActivityEvent,
  emptyActivity,
  markActivityUnknown,
  pruneActivity,
  reconcileActivity,
  resetActivityCursor,
} from './activity.ts'
import { appendFileDurable, ensureDir, readTextIfExists, writeFileAtomic } from '../util/atomic.ts'
import { AppError, describeError } from '../util/errors.ts'
import { commandId, findingId, messageId, roundId, sessionIdFor, workId } from '../util/ids.ts'
import type { Logger } from '../util/log.ts'
import { Mutex } from '../util/mutex.ts'
import {
  DEFAULT_MODEL_CONCURRENCY,
  Semaphore,
  type ModelPermit,
  type ModelSlotStats,
  type ReleasedSlots,
} from '../util/semaphore.ts'
import { nowIso, plusMs } from '../util/time.ts'
import { EventBus } from './event-bus.ts'
import { replayRequest, requestFingerprint, workRequestKey } from './idempotency.ts'
import {
  buildFindingsIndex,
  queryFindings,
  resolveCurrentIds,
  withRelations,
  type FindingView,
  type SupersedeNotice,
} from './findings.ts'
import { repairFindingsLog } from './findings-log.ts'
import { inboxMessages, pendingMessages, pendingUserMessages } from './messages.ts'
import type { TaskPaths } from './paths.ts'
import {
  buildCommandPrompt,
  buildInboxPrompt,
  buildInitialPrompt,
  buildRecoveryPrompt,
  buildRoundNotice,
  correctionNote,
  taskBlock,
  type SpawnContext,
} from './prompt.ts'
import {
  hashReportContent,
  MAX_REPORT_BYTES,
  normalizeReportEntryPath,
  normalizeReportKey,
  normalizeTaskRelativePath,
  renderReportMeta,
  reportContentRelative,
  resolveInsideTask,
} from './reports.ts'
import {
  renderConsensusMarkdown,
  renderCurrentFindingsHeader,
  renderFindingBlock,
  renderReportsSection,
  renderRound,
  renderTaskMarkdown,
  renderWorksMarkdown,
  tableCell,
} from './render.ts'
import { createRunRecord, loadState, saveState } from './state.ts'

export interface RetryPolicy {
  initialMs: number
  factor: number
  maxMs: number
  jitter: number
}

export interface EngineOptions {
  paths: TaskPaths
  driver: HarnessDriver
  logger: Logger
  retry?: Partial<RetryPolicy>
  /**
   * Maximum number of model streams in flight across every executor in this
   * task. The default is 2; the value comes from LIEBIAN_MODEL_CONCURRENCY.
   */
  modelConcurrency?: number
  /**
   * When false, state edits are persisted but no harness turns, deliveries or
   * retries are scheduled. Used by offline CLI edits while the daemon is down.
   */
  dispatch?: boolean
}

interface QueuedTurn {
  text: string
  messages: MessageRecord[]
  resolve: () => void
  reject: (error: unknown) => void
}

interface SharedReadResult {
  text: string
  taskId: string
  targetVersion: number
  sharedStateVersion: number
  participants: number
  /** Current (non-superseded) findings. */
  findings: number
  /** Size of the full append-only log, including superseded records. */
  historicalFindings: number
  reports: string[]
  truncated: boolean
}

interface FindingResult extends FindingRecord {
  supersededBy: string[]
  text: string
}

interface FindingReadResult {
  id: string
  authorWorkId: string
  current: boolean
  history: boolean
  supersededBy: string[]
  currentIds: string[]
  record: FindingRecord | null
  text: string
}

interface FindingQueryOutput {
  text: string
  records: unknown[]
  view: FindingView
  total: number
  matched: number
  cursor: string | null
  hasMore: boolean
  superseded: SupersedeNotice[]
}

interface ReportReadResult {
  key: string
  found: boolean
  report: ReportRecord | null
  content: string | null
  text: string
}

interface ReportPublishResult {
  key: string
  revision: number
  path: string
  contentHash: string
  entryState: ReportRecord['entryState']
  idempotent: boolean
  restored: boolean
  text: string
}

interface SendResult {
  to: string
  ok: boolean
  messageId?: string
  code?: string
  message?: string
}

interface SpawnResult {
  workId: string
  sessionId: string
  parentWorkId: string
  idempotent: boolean
  text: string
}

interface RetireResult {
  workId: string
  undelivered: number
  notifiedSenders: string[]
  text: string
}

interface WaitResult {
  text: string
  events: { seq: number; at: string; kind: string; text: string }[]
  cursor: number
  timedOut: boolean
}

interface CompletionStatusResult {
  round: RoundRecord | null
  participants: string[]
  missingVotes: string[]
  blockers: string[]
  text: string
}

/** One command handed to a harness process by the steering plugin. */
interface ClaimedCommand {
  id: string
  /** Ready-to-steer prompt text (raw user text plus a command header). */
  text: string
  token: string
}

interface CommandResult {
  text: string
  command: CommandRecord
  idempotent: boolean
}

interface ContinueResult {
  text: string
  run: RunRecord
  work: WorkRecord
  command: CommandRecord
  idempotent: boolean
}

/** A resume opens a run like a continue does, but records no command. */
export interface ResumeResult {
  text: string
  run: RunRecord
  work: WorkRecord
  command: null
  idempotent: boolean
}

interface RecoverResult {
  text: string
  run: RunRecord
  /** Newly created takeover work; null when existing participants were kept. */
  work: WorkRecord | null
  created: boolean
  idempotent: boolean
  participants: string[]
}

export interface CommandClaimInput {
  sessionId?: string
  generation?: number
}

export interface CommandDeliveryOverview {
  commandId: string
  createdAt: string
  source: CommandRecord['source']
  text: string
  deliveries: CommandDeliveryRecord[]
}

const DEFAULT_RETRY: RetryPolicy = { initialMs: 2_000, factor: 2, maxMs: 60_000, jitter: 0.2 }
const MAX_TEXT = 100_000
const MAX_BODY = 50_000
const MAX_COMMAND_TEXT = 20_000
const MAX_REQUEST_ID = 200
/** How long one harness process may hold a command claim before a retry. */
const COMMAND_CLAIM_LEASE_MS = 30_000
/** Upper bound per claim so one poll cannot flood a model step. */
const MAX_COMMAND_CLAIMS = 5
const COMMAND_SOURCES: readonly CommandRecord['source'][] = ['web', 'cli', 'api']

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((item) => set.has(item))
}

function requireText(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') throw new AppError('INVALID_ARGUMENT', `${field} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new AppError('INVALID_ARGUMENT', `${field} 不能为空`)
  if (trimmed.length > max) throw new AppError('INVALID_ARGUMENT', `${field} 过长（上限 ${max} 字符）`)
  return trimmed
}

function optionalText(value: unknown, field: string, max = 500): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AppError('INVALID_ARGUMENT', `${field} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > max) throw new AppError('INVALID_ARGUMENT', `${field} 过长（上限 ${max} 字符）`)
  return trimmed
}

function stringArray(value: unknown, field: string, maxItems = 50): string[] {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new AppError('INVALID_ARGUMENT', `${field} 只能包含字符串`)
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    if (trimmed.length > 500) throw new AppError('INVALID_ARGUMENT', `${field} 中的条目过长`)
    result.push(trimmed)
  }
  if (result.length > maxItems) throw new AppError('INVALID_ARGUMENT', `${field} 条目过多（上限 ${maxItems}）`)
  return [...new Set(result)]
}

/** Report base revision: 0 means "no version yet". */
function normalizeBaseRevision(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  throw new AppError('INVALID_ARGUMENT', 'base_revision 必须是非负整数；首次发布用 0')
}

function truncate(
  text: string,
  maxChars: number,
  hint = '可用 shared_query 或 findings_get 按范围读取',
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n\n…（输出已截断，共 ${text.length} 字符；${hint}）\n`,
    truncated: true,
  }
}

/**
 * Select messages that fit one context injection budget. Remaining messages
 * stay pending and are delivered at a later turn boundary instead of being
 * silently dropped or flooding the model context.
 */
function takeByBudget<T>(items: readonly T[], cost: (item: T) => number, budget: number): T[] {
  const selected: T[] = []
  let total = 0
  for (const item of items) {
    const size = cost(item)
    if (selected.length > 0 && total + size > budget) break
    selected.push(item)
    total += size
  }
  return selected
}

/** The thin runtime engine for one task. */
export class Engine {
  readonly paths: TaskPaths
  readonly state: RuntimeState
  onTaskEnded?: (status: TaskStatus) => void

  private readonly driver: HarnessDriver
  private readonly logger: Logger
  private readonly retryPolicy: RetryPolicy
  private readonly dispatch: boolean
  private readonly modelSlots: Semaphore
  private readonly modelGenerations = new Map<string, number | null>()
  private readonly diagnostics: DiagnosticLog
  private readonly lag = monitorEventLoopDelay({ resolution: 20 })
  private diagnosticTimer?: NodeJS.Timeout
  private sampling = false
  private lastCpu = process.cpuUsage()
  private lastSample = performance.now()
  private readonly mutex = new Mutex()
  private readonly events = new EventBus()
  private readonly retryTimers = new Map<string, NodeJS.Timeout>()
  private readonly turnQueues = new Map<string, QueuedTurn[]>()
  private readonly turnRunning = new Set<string>()
  private readonly deliveryScheduled = new Set<string>()
  private readonly delivering = new Set<string>()
  private readonly recovering = new Set<string>()
  /** Works whose initial/recovery prompt is still being established. */
  private readonly booting = new Set<string>()
  /** Works with a `session/prompt` request in flight (receipt not yet stored). */
  private readonly prompting = new Set<string>()
  private readonly recentFailures = new Map<string, { message: string; at: number }>()
  private pendingActions = 0
  private completionScheduled = false
  private closing = false
  private stoppedAll = false
  /** Deferred terminal cleanup; cancelled when a new run starts in-process. */
  private stopAllTimer?: NodeJS.Timeout
  /** Activity callbacks received from the driver but not yet applied. */
  private activityPending = 0
  /** Protocol writes admitted by the work-scoped API and not yet committed. */
  private pendingProtocolWrites = 0
  /** Debounced reopen of a round invalidated by actual execution activity. */
  private roundReopenTimer?: NodeJS.Timeout
  /** True while a round invalidated by activity still owes a replacement. */
  private roundReopenPending = false
  /** Creator recorded when activity invalidates a round, so the reopen preserves it. */
  private lastRoundCreatorId?: string

  private constructor(options: EngineOptions, state: RuntimeState) {
    this.paths = options.paths
    this.driver = options.driver
    this.logger = options.logger
    this.state = state
    this.diagnostics = new DiagnosticLog(join(this.paths.logsDir, options.dispatch === false ? 'diagnostics-offline.jsonl' : 'diagnostics.jsonl'), {
      taskId: state.taskId,
    }, { warn: (message) => this.logger.warn(message) })
    this.recordDiagnostic('runtime-open', { node: process.version, platform: process.platform,
      schemaVersion: state.schemaVersion, modelConcurrency: options.modelConcurrency ?? DEFAULT_MODEL_CONCURRENCY,
      provider: process.env.LIEBIAN_PROVIDER, model: process.env.LIEBIAN_MODEL, dispatch: options.dispatch ?? true })
    if (options.dispatch !== false) {
      this.lag.enable()
      this.diagnosticTimer = setInterval(() => { void this.sampleDiagnostics().catch((error) =>
        this.recordDiagnostic('sample-failed', { error: describeError(error) })) },
        positiveSetting(process.env.LIEBIAN_DIAGNOSTICS_INTERVAL_MS, 30_000, 3_600_000))
      this.diagnosticTimer.unref()
    }
    this.retryPolicy = { ...DEFAULT_RETRY, ...options.retry }
    this.dispatch = options.dispatch ?? true
    this.modelSlots = new Semaphore(options.modelConcurrency ?? DEFAULT_MODEL_CONCURRENCY)
    this.driver.onActivity = (workIdValue, events) => {
      void this.handleActivity(workIdValue, events)
    }
    this.driver.onUnexpectedExit = (workIdValue, reason) => {
      void this.handleFailure(workIdValue, new AppError('HARNESS_EXITED', reason), 'process-exit')
    }
    // A dead harness process can never send its plugin's `finally` release, so
    // reclaim everything it held, including queued acquire calls.
    this.driver.onWorkerStart = (workId, generation) => {
      this.modelGenerations.set(workId, generation)
      this.recordDiagnostic('worker-start', { workId, generation })
    }
    this.driver.onWorkerExit = (workIdValue, reason, generation) => {
      if (generation === undefined || this.modelGenerations.get(workIdValue) === generation) {
        this.modelGenerations.set(workIdValue, null)
      }
      const released = this.modelSlots.releaseWork(workIdValue, generation)
      this.recordDiagnostic('worker-exit', { workId: workIdValue, generation, reason, reclaimed: released })
      if (released.active > 0 || released.queued > 0) {
        this.logger.warn(
          `${workIdValue}: harness 进程退出，回收模型请求名额（active=${released.active}, queued=${released.queued}）`,
        )
      }
    }
  }

  /** Load an existing task and prepare its runtime. */
  static async open(options: EngineOptions): Promise<Engine> {
    const state = await loadState(options.paths)
    return new Engine(options, state)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Repair derived documents, then either create the first executor or resume
   * every participating work of the current run from its persisted session.
   *
   * A terminal task never re-enters exploration here: only cleanup is finished,
   * so a crash after the completion commit cannot restart work. Continuing an
   * ended task is an explicit human operation (`continueTask`).
   */
  async start(): Promise<void> {
    await this.mutex.run(async () => {
      await mkdir(this.paths.evidenceDir, { recursive: true })
      await mkdir(this.paths.consensusDir, { recursive: true })
      await mkdir(this.paths.sessionsDir, { recursive: true })
      await mkdir(this.paths.logsDir, { recursive: true })
      await mkdir(this.paths.reportsDir, { recursive: true })
      await this.repairFindingsLocked()
      await this.repairReportsLocked()
      const run = this.currentRunLocked()
      this.state.interruptedAt = undefined
      if (this.state.status === 'active') {
        // A daemon restart is not a shared-state change, but the old round's
        // votes were collected before the break. Invalidate it and re-ask once
        // every recovered work sits at a verified boundary.
        const staleRound = this.currentOpenRound()
        if (staleRound !== undefined) {
          this.lastRoundCreatorId = staleRound.createdByWorkId
          staleRound.status = 'invalidated'
          staleRound.invalidatedAt = nowIso()
          staleRound.invalidatedReason = '运行时恢复，需要在核对活动后重新表态'
          this.state.currentRoundId = null
          this.roundReopenPending = true
        }
        // A previous process cannot acknowledge a claim after this runtime
        // starts; leave the command saved so the new plugin process re-steers it.
        for (const command of this.state.commands) {
          for (const delivery of Object.values(command.deliveries)) {
            if (delivery.claim !== undefined) delivery.claim = undefined
          }
        }
      } else {
        for (const ended of this.state.runs) {
          if (ended.status === 'active') continue
          if (ended.cleanup !== 'done') {
            ended.cleanup = 'pending'
            ended.cleanupNote = '上次运行结束时尚未确认受管理执行已全部停止'
          }
        }
      }
      await this.persistLocked()
    })

    if (this.state.status !== 'active') {
      await this.finishTerminalCleanup('运行时启动时只完成终止清理，不重新探索')
      this.onTaskEnded?.(this.state.status)
      return
    }

    if (!this.state.bootstrapped) {
      let firstWork: WorkRecord | undefined
      await this.mutex.run(async () => {
        firstWork = this.createWorkLocked(null, '本任务的第一个执行者。', '', [], 'initial')
        this.state.bootstrapped = true
        await this.persistLocked()
        this.journalLocked('task-bootstrapped', { workId: firstWork.id })
      })
      if (firstWork !== undefined) {
        this.pendingActions += 1
        try {
          // A failed first request becomes a visible retry, not a fatal start.
          await this.bootWork(firstWork.id, false)
        } finally {
          this.pendingActions -= 1
        }
        this.scheduleCompletionCheck()
      }
      return
    }

    const active = this.activeIds()
    for (const id of active) {
      void this.recoverWork(id, 'daemon-start')
    }
    this.scheduleRoundReopen()
  }

  /** Stop the runtime without declaring success. Persisted sessions stay resumable. */
  async close(reason = 'daemon-interrupted'): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (this.diagnosticTimer !== undefined) clearInterval(this.diagnosticTimer)
    await this.sampleDiagnostics().catch(() => undefined)
    this.lag.disable()
    this.modelSlots.close()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    if (this.roundReopenTimer !== undefined) clearTimeout(this.roundReopenTimer)
    this.roundReopenTimer = undefined
    if (this.stopAllTimer !== undefined) {
      clearTimeout(this.stopAllTimer)
      this.stopAllTimer = undefined
    }
    this.events.close()
    for (const queue of this.turnQueues.values()) {
      for (const item of queue) item.reject(new AppError('RUNTIME_CLOSED', '运行时已关闭'))
    }
    this.turnQueues.clear()
    await this.mutex.run(async () => {
      if (this.state.status === 'active') {
        this.state.interruptedAt = nowIso()
        this.state.updatedAt = nowIso()
        await saveState(this.paths, this.state)
        await writeFileAtomic(this.paths.worksFile, renderWorksMarkdown(this.state))
      }
      this.journalLocked('runtime-closed', { reason })
    })
    let cleanupSucceeded = true
    await this.driver.stopAll().catch((error: unknown) => {
      cleanupSucceeded = false
      this.recordDiagnostic('cleanup-failed', { error: describeError(error) })
      this.logger.warn(`停止 harness 进程失败：${describeError(error)}`)
    })
    if (cleanupSucceeded && this.state.status !== 'active') {
      await this.markTerminalCleanupDone(`运行时正常关闭：${reason}`)
    }
    await this.diagnostics.flush()
  }

  /** True once the task is no longer active. */
  get finished(): boolean {
    return this.state.status !== 'active'
  }

  /** The run whose works currently participate in the task. */
  private currentRunLocked(): RunRecord {
    const run = this.state.runs.find((item) => item.id === this.state.currentRunId)
    if (run === undefined) {
      throw new AppError('STATE_CORRUPT', `当前运行轮次不存在：${String(this.state.currentRunId)}`)
    }
    return run
  }

  /**
   * Finish stopping managed executions and record that the terminal run's
   * cleanup completed. Idempotent: a restart after a committed completion only
   * performs this step and never recreates a work or a round.
   */
  private async finishTerminalCleanup(note: string): Promise<void> {
    await this.driver.stopAll().catch((error: unknown) => {
      this.recordDiagnostic('cleanup-failed', { error: describeError(error) })
      this.logger.warn(`停止 harness 进程失败：${describeError(error)}`)
      throw error
    })
    await this.markTerminalCleanupDone(note)
  }

  private async markTerminalCleanupDone(note: string): Promise<void> {
    await this.mutex.run(async () => {
      let changed = false
      const at = nowIso()
      for (const run of this.state.runs) {
        if (run.status === 'active' || run.cleanup === 'done') continue
        run.cleanup = 'done'
        run.cleanupAt = at
        run.cleanupNote = note
        changed = true
      }
      if (changed) await this.saveStateOnlyLocked()
    })
  }

  // -------------------------------------------------------------------------
  // Runs: continue an ended task, recover an active task without participants
  // -------------------------------------------------------------------------

  /**
   * Continue a completed/stopped task as a new run.
   *
   * One persistent commit registers the new run, its first work and the user's
   * instruction as a task-level command. Old runs keep their terminal status,
   * completion record and works; their votes and works never join the new run.
   * The caller must have verified that the previous run's managed execution is
   * stopped (`executionsStopped`), because the runtime cannot inspect a stopped
   * container from inside the new one.
   */
  async continueTask(input: {
    text: string
    requestId: string
    source?: CommandRecord['source']
    executionsStopped?: boolean
  }): Promise<ContinueResult> {
    const text = requireText(input.text, 'text', MAX_COMMAND_TEXT)
    const requestId = requireText(input.requestId, 'request_id', MAX_REQUEST_ID)
    if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) {
      throw new AppError('INVALID_ARGUMENT', 'request_id 只能包含字母、数字、点、下划线和连字符')
    }
    const source = input.source ?? 'api'
    if (!COMMAND_SOURCES.includes(source)) {
      throw new AppError('INVALID_ARGUMENT', `未知命令来源：${String(source)}`)
    }

    const committed = await this.mutex.run(async () => {
      // Idempotent replay: the same request returns the run/work it created,
      // even when that run is now active or has already ended again.
      const previousContinue = this.state.runs.find((run) => run.continueRequestId === requestId)
      if (previousContinue !== undefined) {
        if (previousContinue.continueText !== text) {
          throw new AppError(
            'REQUEST_CONFLICT',
            `request_id ${requestId} 已用于另一次继续操作；同 ID 不能提交不同正文`,
          )
        }
        const work = previousContinue.workIds
          .map((id) => this.state.works[id])
          .find((item): item is WorkRecord => item !== undefined)
        const command = previousContinue.commandIds
          .map((id) => this.state.commands.find((item) => item.id === id))
          .find((item): item is CommandRecord => item !== undefined)
        if (work === undefined || command === undefined) {
          throw new AppError('STATE_CORRUPT', `继续请求 ${requestId} 的记录缺少 work 或命令`)
        }
        return { run: previousContinue, work, command, idempotent: true }
      }

      if (this.state.status === 'active') {
        const participants = this.activeIds()
        throw new AppError(
          'TASK_ACTIVE',
          participants.length === 0
            ? '任务正在进行中但没有参与 work；请使用“恢复工作”创建承接执行者，而不是开启新一轮。'
            : '任务正在进行中，不能用“继续”创建新一轮；请使用发送命令，或先停止任务。',
          { runId: this.state.currentRunId, participants },
        )
      }
      const previousRun = this.currentRunLocked()
      if (previousRun.status === 'active') {
        throw new AppError('STATE_CORRUPT', '任务不是 active，但当前运行轮次仍为 active')
      }
      if (previousRun.cleanup !== 'done') {
        if (input.executionsStopped !== true) {
          throw new AppError(
            'RUN_CLEANUP_PENDING',
            `上一轮 ${previousRun.id} 的受管理执行尚未确认停止；请先停止任务容器或运行时后再继续`,
            { runId: previousRun.id, cleanup: previousRun.cleanup },
          )
        }
        previousRun.cleanup = 'done'
        previousRun.cleanupAt = nowIso()
        previousRun.cleanupNote = '继续操作前已确认上一轮受管理执行停止'
      }

      const sequence = ++this.state.counters.run
      const run = createRunRecord({
        sequence,
        targetVersion: this.state.targetVersion,
        continueRequestId: requestId,
        continueText: text,
      })
      this.state.runs.push(run)
      this.state.currentRunId = run.id
      this.state.status = 'active'
      this.state.statusReason = undefined
      this.state.completion = null
      this.state.currentRoundId = null
      this.state.interruptedAt = undefined
      this.roundReopenPending = false
      // This engine may have already scheduled (or completed) the previous
      // run's stop; a new run gets its own terminal cleanup. Cancel the
      // deferred stop so it cannot stop the new run's sessions.
      this.stoppedAll = false
      if (this.stopAllTimer !== undefined) {
        clearTimeout(this.stopAllTimer)
        this.stopAllTimer = undefined
      }
      if (this.roundReopenTimer !== undefined) {
        clearTimeout(this.roundReopenTimer)
        this.roundReopenTimer = undefined
      }

      const summary = tableCell(text, 120)
      const work = this.createWorkLocked(
        null,
        `用户继续已结束的任务：${summary}`,
        '',
        [],
        'continue',
      )
      work.direction = `继续新一轮（${run.id}）：${summary}`
      // The continue instruction is a task-level command like any other. Its
      // request id is scoped to this operation so a later `task.command` may
      // reuse the human's request id without a false conflict.
      const command = this.createCommandLocked({
        text,
        requestId: `${requestId}:continue`,
        source,
        recipients: [work.id],
      })
      await this.persistLocked()
      this.journalLocked('task-continued', {
        runId: run.id,
        workId: work.id,
        commandId: command.id,
        previousRunId: previousRun.id,
        previousStatus: previousRun.status,
      })
      this.events.emit('all', 'task-continued', `任务以新一轮 ${run.id} 继续`)
      return { run, work, command, idempotent: false }
    })

    if (!committed.idempotent) {
      this.pendingActions += 1
      try {
        if (this.dispatch && !this.closing) {
          await this.bootWork(committed.work.id, false)
        }
      } finally {
        this.pendingActions -= 1
      }
      this.scheduleCompletionCheck()
    }
    const textOut = committed.idempotent
      ? `request ID 已提交过，返回原继续结果：轮次 ${committed.run.id}，work ${committed.work.id}，命令 ${committed.command.id}。`
      : `已在同一任务中开启新一轮 ${committed.run.id}，work ${committed.work.id} 承接用户指令 ${committed.command.id}。\n` +
        `任务保持同一 ID，发现、证据、报告和仍有效的用户要求继续保留；旧轮次的完成记录与表态不改动，也不参与本轮共识。\n` +
        `若运行时尚未启动该 work，请启动任务运行时。`
    return { ...committed, text: textOut }
  }

  /**
   * Reopen a stopped task without a human instruction.
   *
   * Restarting used to require typing a continue command, which forced the
   * operator to invent a sentence just to get the same work going again. A
   * resume opens a fresh run with a successor work but records no command: the
   * executor boots from shared state exactly like the task's first work does.
   * Findings, evidence, the report and still-valid user requirements survive.
   */
  async resumeTask(input: { requestId: string; source?: 'web' | 'cli' | 'api' }): Promise<ResumeResult> {
    const requestId = requireText(input.requestId, 'request_id', MAX_REQUEST_ID)
    if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) {
      throw new AppError('INVALID_ARGUMENT', 'request_id 只能包含字母、数字、点、下划线和连字符')
    }
    const source = input.source ?? 'api'
    if (!COMMAND_SOURCES.includes(source)) {
      throw new AppError('INVALID_ARGUMENT', `未知命令来源：${String(source)}`)
    }

    const committed = await this.mutex.run(async () => {
      const previousResume = this.state.runs.find((run) => run.resumeRequestId === requestId)
      if (previousResume !== undefined) {
        const work = previousResume.workIds
          .map((id) => this.state.works[id])
          .find((item): item is WorkRecord => item !== undefined)
        if (work === undefined) {
          throw new AppError('STATE_CORRUPT', `重启请求 ${requestId} 的记录缺少 work`)
        }
        return { run: previousResume, work, idempotent: true }
      }

      if (this.state.status === 'active') {
        const participants = this.activeIds()
        throw new AppError(
          'TASK_ACTIVE',
          participants.length === 0
            ? '任务正在进行中但没有参与 work；请使用“恢复工作”创建承接执行者。'
            : '任务正在进行中；无需重启，可直接发送命令。',
          { runId: this.state.currentRunId, participants },
        )
      }
      const previousRun = this.currentRunLocked()
      if (previousRun.status === 'active') {
        throw new AppError('STATE_CORRUPT', '任务不是 active，但当前运行轮次仍为 active')
      }
      if (previousRun.cleanup !== 'done') {
        previousRun.cleanup = 'done'
        previousRun.cleanupAt = nowIso()
        previousRun.cleanupNote = '重启前已确认上一轮受管理执行停止'
      }

      const sequence = ++this.state.counters.run
      const run = createRunRecord({
        sequence,
        targetVersion: this.state.targetVersion,
        resumeRequestId: requestId,
      })
      this.state.runs.push(run)
      this.state.currentRunId = run.id
      this.state.status = 'active'
      this.state.statusReason = undefined
      this.state.completion = null
      this.state.currentRoundId = null
      this.state.interruptedAt = undefined
      this.roundReopenPending = false
      this.stoppedAll = false
      if (this.stopAllTimer !== undefined) {
        clearTimeout(this.stopAllTimer)
        this.stopAllTimer = undefined
      }
      if (this.roundReopenTimer !== undefined) {
        clearTimeout(this.roundReopenTimer)
        this.roundReopenTimer = undefined
      }

      const work = this.createWorkLocked(
        null,
        '任务重启：无人值守继续，执行者按共享状态自行判断下一步。',
        '',
        [],
        'continue',
      )
      work.direction = `继续任务（${run.id}，重启后恢复）`
      await this.persistLocked()
      this.journalLocked('task-resumed', {
        runId: run.id,
        workId: work.id,
        previousRunId: previousRun.id,
        previousStatus: previousRun.status,
      })
      this.events.emit('all', 'task-resumed', `任务以新一轮 ${run.id} 重启继续，未附加人工命令`)
      return { run, work, idempotent: false }
    })

    if (!committed.idempotent) {
      this.pendingActions += 1
      try {
        if (this.dispatch && !this.closing) {
          await this.bootWork(committed.work.id, false)
        }
      } finally {
        this.pendingActions -= 1
      }
      this.scheduleCompletionCheck()
    }
    const text = committed.idempotent
      ? `request ID 已提交过，返回原重启结果：轮次 ${committed.run.id}，work ${committed.work.id}。`
      : `已在同一任务中开启新一轮 ${committed.run.id}，work ${committed.work.id} 继续执行（未附加人工命令）。\n` +
        `执行者启动时会先读取任务定义、有效发现和活跃 work 表，再自行决定下一步。`
    return { run: committed.run, work: committed.work, command: null, idempotent: committed.idempotent, text }
  }

  /**
   * Create a takeover work in the current run when it has no participants
   * (for example after every executor retired). Existing participants are
   * never displaced; an empty set is not treated as agreement.
   */
  async recoverTask(input: { requestId: string; source?: 'web' | 'cli' | 'api' }): Promise<RecoverResult> {
    const requestId = requireText(input.requestId, 'request_id', MAX_REQUEST_ID)
    if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) {
      throw new AppError('INVALID_ARGUMENT', 'request_id 只能包含字母、数字、点、下划线和连字符')
    }
    const result = await this.mutex.run(async () => {
      this.requireActiveTask()
      const run = this.currentRunLocked()
      if (run.status !== 'active') {
        throw new AppError('STATE_CORRUPT', `当前运行轮次 ${run.id} 不是 active`)
      }
      const existing = run.recoveries.find((item) => item.requestId === requestId)
      if (existing !== undefined) {
        const work = this.state.works[existing.workId] ?? null
        return {
          run,
          work,
          created: false,
          idempotent: true,
          participants: this.activeIds(),
        }
      }
      const participants = this.activeIds()
      if (participants.length > 0) {
        return { run, work: null, created: false, idempotent: false, participants }
      }
      const work = this.createWorkLocked(
        null,
        '人工恢复：当前没有参与 work，需要创建一个执行者承接任务。',
        '',
        [],
        'recover',
      )
      work.direction = '承接当前任务（人工恢复）'
      run.recoveries.push({ requestId, workId: work.id, at: nowIso() })
      await this.persistLocked()
      this.journalLocked('work-recovered-manually', { runId: run.id, workId: work.id, requestId })
      this.events.emit('all', 'work-recovered', `work ${work.id} 已由人工恢复进入任务`)
      return { run, work, created: true, idempotent: false, participants: [work.id] }
    })

    if (result.created && result.work !== null) {
      this.pendingActions += 1
      try {
        if (this.dispatch && !this.closing) await this.bootWork(result.work.id, false)
      } finally {
        this.pendingActions -= 1
      }
      this.scheduleCompletionCheck()
    }
    const text = result.created
      ? `已在本轮 ${result.run.id} 创建承接 work ${result.work?.id}。空集合不会被当作完成，仍需全体参与 work 明确同意。`
      : result.idempotent
        ? `request ID 已提交过，本次恢复对应 work ${result.work?.id ?? '（缺失）'}，未重复创建。`
        : `本轮仍有参与 work：${result.participants.join(', ')}；未创建新的 work，已保留原有参与集合。`
    return { ...result, text }
  }

  /** Configured cap on model streams in flight for this whole task. */
  get modelConcurrency(): number {
    return this.modelSlots.limit
  }

  /** Current occupancy, exposed for `/health` and tests. */
  get modelSlotStats(): ModelSlotStats {
    return this.modelSlots.stats
  }

  recordDiagnostic(event: string, data: Record<string, unknown> = {}): void {
    this.diagnostics.record(event, { runId: this.state.currentRunId, ...data })
  }

  /** Flush an offline edit while its caller still holds the writer lock. */
  async finishOffline(): Promise<void> {
    if (this.dispatch) throw new AppError('INVALID_ARGUMENT', '运行中的 engine 必须使用 close')
    this.closing = true
    this.modelSlots.close()
    this.events.close()
    this.recordDiagnostic('offline-edit-finished')
    await this.diagnostics.flush()
  }

  private async sampleDiagnostics(): Promise<void> {
    if (this.sampling) return
    this.sampling = true
    try {
      const now = performance.now()
      const cpu = process.cpuUsage()
      const sizes = await Promise.all([this.paths.stateFile, this.paths.journalFile].map(async (file) =>
        stat(file).then((info) => info.size).catch(() => null)))
      this.recordDiagnostic('runtime-sample', {
        elapsedMs: now - this.lastSample, uptimeSeconds: process.uptime(), memory: process.memoryUsage(),
        cpuUserUs: cpu.user - this.lastCpu.user, cpuSystemUs: cpu.system - this.lastCpu.system,
        eventLoopP99Ms: this.lag.percentile(99) / 1e6, eventLoopMaxMs: this.lag.max / 1e6,
        stateBytes: sizes[0], journalBytes: sizes[1], modelSlots: this.modelSlotStats,
        status: this.state.status, findings: this.state.findings.length, messages: this.state.messages.length,
        commands: this.state.commands.length, rounds: this.state.rounds.length,
        requestReceipts: Object.keys(this.state.workRequests).length,
        worksTotal: Object.keys(this.state.works).length,
        works: Object.values(this.state.works).map((work) => ({ id: work.id, runId: work.runId,
          status: work.runtimeStatus, generation: work.activity.generation, blockers: activityBlockers(work) })),
        diagnostics: this.diagnostics.stats,
        processes: await this.driver.inspectProcesses?.(),
      })
      this.lastCpu = cpu
      this.lastSample = now
      this.lag.reset()
    } finally { this.sampling = false }
  }

  /**
   * Acquire one shared model-request slot for a work. The caller is the
   * harness plugin running inside that work's process; the HTTP layer keeps the
   * request pending until a slot is available.
   */
  async acquireModelSlot(
    workIdValue: string,
    options: { permitId?: string; signal?: AbortSignal; generation?: number } = {},
  ): Promise<ModelPermit> {
    const work = this.activeWork(workIdValue)
    if (work === undefined) {
      throw new AppError('WORK_NOT_FOUND', `work 不存在或已退出：${workIdValue}`)
    }
    const current = this.modelGenerations.has(work.id) ? this.modelGenerations.get(work.id) : work.activity.generation
    if (current === null || (options.generation !== undefined && options.generation !== current)) {
      throw new AppError('STALE_GENERATION', '模型请求来自已退出或被替换的进程')
    }
    const started = performance.now()
    this.recordDiagnostic('model-queued', { workId: work.id, generation: options.generation ?? current, permitId: options.permitId, slots: this.modelSlotStats })
    try {
      const permit = await this.modelSlots.acquire({
        workId: work.id,
        generation: options.generation ?? current ?? 0,
        ...(options.permitId === undefined ? {} : { permitId: options.permitId }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      this.recordDiagnostic('model-acquired', { ...permit, waitMs: performance.now() - started, slots: this.modelSlotStats })
      return permit
    } catch (error) {
      this.recordDiagnostic('model-acquire-failed', { workId: work.id, permitId: options.permitId, waitMs: performance.now() - started, error: describeError(error) })
      throw error
    }
  }

  /** Return one permit. Idempotent: a second release changes nothing. */
  releaseModelSlot(permitId: string): boolean {
    return this.modelSlots.release(permitId)
  }

  /** Cancel a request that was aborted before its permit was handed out. */
  cancelModelSlot(permitId: string): boolean {
    return this.modelSlots.cancel(permitId)
  }

  releaseModelRequest(workId: string, generation: number, permitId: string, cancel: boolean): boolean {
    const owner = this.modelSlots.owner(permitId)
    if (owner !== undefined && (owner.workId !== workId || owner.generation !== generation)) {
      throw new AppError('STALE_GENERATION', '不能归还其他进程的模型名额')
    }
    return cancel ? this.modelSlots.cancel(permitId) : this.modelSlots.release(permitId)
  }

  /** Reclaim every queued/held permit for one work (process exit, retire). */
  releaseModelSlotsForWork(workIdValue: string): ReleasedSlots {
    return this.modelSlots.releaseWork(workIdValue)
  }

  async abortModelGeneration(workId: string, generation: number, reason: string): Promise<void> {
    if (this.modelGenerations.get(workId) !== generation) return
    this.recordDiagnostic('model-cleanup-timeout', { workId, generation, reason })
    await this.driver.stop(workId)
    const after = this.modelGenerations.get(workId)
    if (after !== null && after !== generation) return
    await this.handleFailure(workId, new AppError('MODEL_STREAM_STALLED', reason), 'stream-cleanup')
  }

  /**
   * Mark one mutating protocol call as in flight. Completion may not commit
   * between a tool request and the runtime write it is about to perform.
   */
  beginProtocolWrite(): void {
    this.pendingProtocolWrites += 1
  }

  endProtocolWrite(): void {
    if (this.pendingProtocolWrites > 0) this.pendingProtocolWrites -= 1
    if (this.pendingProtocolWrites === 0) {
      this.scheduleCompletionCheck()
      this.scheduleRoundReopen()
    }
  }

  /** Wait until no turn, delivery, recovery or completion check is in flight. */
  async whenQuiet(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const busy =
        this.pendingActions > 0 ||
        this.pendingProtocolWrites > 0 ||
        this.activityPending > 0 ||
        this.turnRunning.size > 0 ||
        this.deliveryScheduled.size > 0 ||
        this.delivering.size > 0 ||
        this.recovering.size > 0 ||
        this.completionScheduled ||
        this.roundReopenTimer !== undefined ||
        this.roundReopenPending ||
        Object.values(this.state.works).some(
          (work) => work.runtimeStatus === 'starting' || work.runtimeStatus === 'running',
        )
      if (!busy) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        if (
          this.turnRunning.size === 0 &&
          this.pendingActions === 0 &&
          this.pendingProtocolWrites === 0 &&
          this.activityPending === 0 &&
          this.deliveryScheduled.size === 0 &&
          !this.completionScheduled &&
          this.roundReopenTimer === undefined &&
          !this.roundReopenPending
        ) {
          return true
        }
      }
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }

  // -------------------------------------------------------------------------
  // Turn execution
  // -------------------------------------------------------------------------

  /**
   * Boot a work's harness session and enqueue its startup prompt.
   * When `throwOnFailure` is set, a failed enqueue removes the work again
   * (fission must not leave a ghost participant).
   */
  private async bootWork(workIdValue: string, throwOnFailure = false): Promise<void> {
    const work = this.activeWork(workIdValue)
    if (work === undefined) {
      if (throwOnFailure) throw new AppError('WORK_NOT_FOUND', `work 不存在：${workIdValue}`)
      return
    }
    this.booting.add(workIdValue)
    try {
      const result = await this.driver.ensure(this.sessionSpec(work))
      const fresh = result.freshFallback
      await this.adoptGeneration(work, result, fresh)
      await this.noteRunStartedLocked(work)
      const text = fresh
        ? buildRecoveryPrompt({
            work,
            errorText: '持久化会话缺失',
            fresh: true,
            activity: activityLines(work),
          })
        : work.sessionStarted
          ? buildRecoveryPrompt({
              work,
              errorText: work.lastError?.message ?? '运行时重启',
              fresh: false,
              activity: activityLines(work),
            })
          : this.initialPromptFor(work)
      await this.enqueueTurn(workIdValue, text)
    } catch (error) {
      // A prompt failure inside pumpTurns has already recorded retry state.
      if (this.activeWork(workIdValue)?.runtimeStatus !== 'retrying') {
        await this.handleFailure(workIdValue, error, 'boot')
      }
      if (throwOnFailure) throw error
    } finally {
      this.booting.delete(workIdValue)
    }
  }

  /** Resume a work after a failure or daemon restart, then hand control back to the agent. */
  private async recoverWork(workIdValue: string, reason: string): Promise<void> {
    if (this.closing) return
    const work = this.activeWork(workIdValue)
    if (work === undefined) return
    if (this.recovering.has(workIdValue) || this.turnRunning.has(workIdValue)) return
    this.recovering.add(workIdValue)
    try {
      this.logger.info(`${workIdValue}: 恢复（${reason}）`)
      const result = await this.driver.ensure(this.sessionSpec(work))
      const fresh = result.freshFallback
      await this.adoptGeneration(work, result, fresh)
      await this.noteRunStartedLocked(work)
      const text = fresh
        ? buildRecoveryPrompt({
            work,
            errorText: '持久化会话缺失',
            fresh: true,
            activity: activityLines(work),
          })
        : work.sessionStarted
          ? buildRecoveryPrompt({
              work,
              errorText: work.lastError?.message ?? '上次请求失败',
              fresh: false,
              activity: activityLines(work),
            })
          : this.initialPromptFor(work)
      await this.enqueueTurn(workIdValue, text)
      this.events.emit([workIdValue], 'recovered', `work ${workIdValue} 已恢复，原因为：${reason}`)
    } catch (error) {
      await this.handleFailure(workIdValue, error, 'recover')
    } finally {
      this.recovering.delete(workIdValue)
      this.scheduleRoundReopen()
    }
  }

  /**
   * Adopt the generation reported by `ensure`.
   *
   * A new generation means the old process is gone: every formerly open tool
   * and running job becomes an unknown action that the recovered model must
   * reconcile. A fresh-session fallback additionally resets the event cursor
   * because the new session log starts over.
   */
  private async adoptGeneration(
    work: WorkRecord,
    result: { generation: number; freshFallback: boolean; replay?: ActivityEvent[] },
    fresh: boolean,
  ): Promise<void> {
    await this.mutex.run(async () => {
      let changed = false
      const generationChanged = work.activity.generation !== result.generation
      if (generationChanged) {
        work.activity.generation = result.generation
        changed = true
      }
      // Apply persisted session events after the old cursor BEFORE marking the
      // remainder unknown: an event already committed to the log (tool result,
      // job settlement) must not be reported as an unresolved action.
      for (const event of result.replay ?? []) {
        if (event.sessionId !== work.sessionId || event.generation !== work.activity.generation) continue
        const applied = applyActivityEvent(work.activity, event)
        if (applied.changed) changed = true
        if (event.kind === 'user-message' && this.markCommandContextLocked(work.id, event.messageId, event.at)) {
          changed = true
        }
      }
      if (generationChanged) {
        changed = markActivityUnknown(work.activity) || changed
        // Claims and enqueued receipts belong to the old process generation.
        for (const command of this.state.commands) {
          const delivery = command.deliveries[work.id]
          if (delivery === undefined) continue
          if (delivery.claim !== undefined) {
            delivery.claim = undefined
            changed = true
          }
          // A steered command is acknowledged with the message id the old
          // process would have written to its session log. The replay above
          // marks every command whose `user/message` did reach the log as
          // `entered-context`; an `enqueued` receipt that is still unobserved
          // died with the old process (for example a crash during a long
          // step) and must become deliverable again, otherwise completion would
          // wait forever for a delivery nobody can produce.
          if (delivery.status === 'enqueued') {
            delivery.status = 'saved'
            delivery.harnessMessageId = undefined
            delivery.enqueuedAt = undefined
            delivery.note = 'harness 进程已更换，未观察到进入上下文的回执，重新投递'
            changed = true
          }
        }
      }
      // A recovery prompt is enqueued right after this call. Any old "running"
      // status cannot be trusted across the failure that triggered recovery;
      // the harness reports running again when the new turn actually starts.
      if (work.activity.sessionStatus !== 'idle') {
        work.activity.sessionStatus = 'idle'
        changed = true
      }
      if (fresh) {
        work.recoveredFresh = true
        work.sessionStarted = false
        resetActivityCursor(work.activity)
        // The queued command input died with the old session. Re-deliver it.
        for (const command of this.state.commands) {
          const delivery = command.deliveries[work.id]
          if (delivery === undefined || delivery.status !== 'enqueued') continue
          delivery.status = 'saved'
          delivery.harnessMessageId = undefined
          delivery.enqueuedAt = undefined
          delivery.claim = undefined
          delivery.note = '会话丢失，重新投递'
          changed = true
        }
        changed = true
      }
      if (changed) {
        await this.saveStateOnlyLocked()
        this.journalLocked('work-activity-recovered', {
          workId: work.id,
          generation: result.generation,
          fresh,
          replayed: result.replay?.length ?? 0,
          blockers: activityBlockers(work),
        })
      }
    })
  }

  /** Record when a run's first session became active (used by the UI and journal). */
  private async noteRunStartedLocked(work: WorkRecord): Promise<void> {
    await this.mutex.run(async () => {
      const run = this.currentRunLocked()
      if (work.runId !== run.id || run.startedAt !== undefined) return
      run.startedAt = nowIso()
      await this.saveStateOnlyLocked()
      this.journalLocked('run-started', { runId: run.id, workId: work.id })
    })
  }

  /**
   * Enqueue one turn. The returned promise resolves when the prompt is durably
   * enqueued (not when the turn finishes). Turns for one work never overlap.
   */
  private enqueueTurn(workIdValue: string, text: string, messages: MessageRecord[] = []): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queue = this.turnQueues.get(workIdValue) ?? []
      queue.push({ text, messages, resolve, reject })
      this.turnQueues.set(workIdValue, queue)
      void this.pumpTurns(workIdValue)
    })
  }

  private async pumpTurns(workIdValue: string): Promise<void> {
    if (this.turnRunning.has(workIdValue)) return
    this.turnRunning.add(workIdValue)
    try {
      for (;;) {
        const queue = this.turnQueues.get(workIdValue)
        const item = queue?.shift()
        if (item === undefined) {
          this.turnQueues.delete(workIdValue)
          break
        }
        const work = this.state.works[workIdValue]
        if (work === undefined || !this.isActive(work)) {
          item.reject(new AppError('WORK_EXITED', `work ${workIdValue} 已退出`))
          this.drainQueue(workIdValue, new AppError('WORK_EXITED', `work ${workIdValue} 已退出`))
          break
        }
        try {
          await this.mutex.run(async () => {
            if (!this.isActive(work)) return
            work.runtimeStatus = 'running'
            work.updatedAt = nowIso()
            await this.persistLocked()
          })
          this.prompting.add(workIdValue)
          const receipt = await this.driver.prompt(workIdValue, item.text).finally(() => {
            this.prompting.delete(workIdValue)
          })
          await this.mutex.run(async () => {
            if (!this.isActive(work)) return
            work.sessionStarted = true
            work.lastPromptMessageId = receipt.messageId
            work.lastError = undefined
            work.updatedAt = nowIso()
            this.recentFailures.delete(workIdValue)
            for (const message of item.messages) {
              if (message.status === 'pending') {
                message.status = 'delivered'
                message.deliveredAt = nowIso()
              }
            }
            await this.persistLocked()
          })
          item.resolve()
          try {
            await this.driver.waitForIdle(workIdValue)
          } catch (error) {
            await this.handleFailure(workIdValue, error, 'wait')
            this.drainQueue(workIdValue, error)
            break
          }
          await this.mutex.run(async () => {
            if (!this.isActive(work)) return
            if (work.runtimeStatus === 'running') {
              work.runtimeStatus = 'idle'
              work.updatedAt = nowIso()
              await this.persistLocked()
            }
          })
        } catch (error) {
          item.reject(error)
          await this.handleFailure(workIdValue, error, 'prompt')
          this.drainQueue(workIdValue, error)
          break
        }
      }
    } finally {
      this.turnRunning.delete(workIdValue)
      this.scheduleDelivery(workIdValue)
      this.scheduleCompletionCheck()
      this.scheduleRoundReopen()
    }
  }

  private drainQueue(workIdValue: string, error: unknown): void {
    const queue = this.turnQueues.get(workIdValue)
    if (queue === undefined) return
    this.turnQueues.delete(workIdValue)
    for (const item of queue) item.reject(error)
  }

  /** Deliver pending messages once the work reaches an available boundary. */
  private scheduleDelivery(workIdValue: string): void {
    if (!this.dispatch || this.closing || this.deliveryScheduled.has(workIdValue)) return
    this.deliveryScheduled.add(workIdValue)
    setImmediate(() => {
      this.deliveryScheduled.delete(workIdValue)
      void this.deliverPending(workIdValue)
    })
  }

  private async deliverPending(workIdValue: string): Promise<void> {
    if (this.closing || this.delivering.has(workIdValue)) return
    this.delivering.add(workIdValue)
    try {
      const messages = await this.mutex.run(async () => {
        const work = this.activeWork(workIdValue)
        if (work === undefined || work.runtimeStatus !== 'idle') return [] as MessageRecord[]
        return pendingMessages(this.state, workIdValue)
      })
      if (messages.length === 0) return
      const selected = takeByBudget(messages, (message) => message.body.length + 256, 60_000)
      await this.enqueueTurn(workIdValue, buildInboxPrompt(selected), selected)
      this.events.emit([workIdValue], 'messages-delivered', `收到 ${selected.length} 条消息`)
    } catch (error) {
      this.logger.warn(`${workIdValue}: 投递消息失败：${describeError(error)}`)
    } finally {
      this.delivering.delete(workIdValue)
    }
  }

  // -------------------------------------------------------------------------
  // Actual harness activity
  // -------------------------------------------------------------------------

  /**
   * Apply one ordered batch of harness activity under the same serialization
   * used by protocol writes. Events from a stale process generation are
   * ignored, so a replaced harness can never overwrite the new projection.
   */
  private async handleActivity(workIdValue: string, events: ActivityEvent[]): Promise<void> {
    if (events.length === 0) return
    this.activityPending += 1
    try {
      await this.mutex.run(async () => {
        const work = this.state.works[workIdValue]
        if (work === undefined || this.state.status !== 'active') return
        // A delayed event from an ended run must not touch the new run's
        // activity, votes or completion checks. Old work records stay as history.
        if (work.runId !== this.state.currentRunId) return
        let changed = false
        let invalidateReason: string | undefined
        for (const event of events) {
          this.recordDiagnostic('activity', { workId: workIdValue, ...activityDiagnostic(event as unknown as Record<string, unknown>),
            accepted: event.sessionId === work.sessionId && event.generation === work.activity.generation })
          if (event.sessionId !== work.sessionId) continue
          if (event.generation !== work.activity.generation) continue
          const result = applyActivityEvent(work.activity, event)
          if (result.changed) changed = true
          // A command reaches the model exactly when its user/message event is
          // committed; the harness message id links the receipt to that fact.
          if (event.kind === 'user-message' && this.markCommandContextLocked(work.id, event.messageId, event.at)) {
            changed = true
            this.journalLocked('command-entered-context', {
              workId: work.id,
              messageId: event.messageId,
            })
          }
          if (result.invalidateReason !== undefined && invalidateReason === undefined) {
            invalidateReason = result.invalidateReason
          }
          if (result.deliveredNotices.length > 0) {
            this.journalLocked('job-result-delivered', {
              workId: work.id,
              jobIds: result.deliveredNotices,
            })
          }
        }
        if (pruneActivity(work.activity)) changed = true
        // A retired work keeps its leftover activity for completion tracking,
        // but nobody is left to read a settlement notice.
        if (!this.isActive(work)) {
          invalidateReason = undefined
          if (work.activity.sessionStatus !== 'idle') {
            work.activity.sessionStatus = 'idle'
            changed = true
          }
          for (const job of Object.values(work.activity.jobs)) {
            if (job.notice !== 'pending') continue
            job.notice = 'delivered'
            job.noticeAt = nowIso()
            job.reconciledNote = 'work 已退出，不再向该 work 投递通知'
            changed = true
          }
        }
        const versionChanged =
          invalidateReason === undefined ? false : this.invalidateRoundForActivityLocked(invalidateReason)
        if (changed || versionChanged) {
          await this.saveStateOnlyLocked()
          if (versionChanged) {
            await writeFileAtomic(this.paths.taskFile, renderTaskMarkdown(this.state))
            await writeFileAtomic(this.paths.worksFile, renderWorksMarkdown(this.state))
          }
        }
      })
    } catch (error) {
      this.logger.warn(`${workIdValue}: 应用 harness 活动事件失败：${describeError(error)}`)
    } finally {
      this.activityPending -= 1
      this.scheduleCompletionCheck()
      this.scheduleRoundReopen()
    }
  }

  /**
   * Invalidate an open round because real execution activity resumed. The
   * shared version moves, but the replacement round is opened only after the
   * work reaches a stable boundary, so a burst of tool calls produces one
   * round instead of one per event.
   */
  private invalidateRoundForActivityLocked(reason: string): boolean {
    const current = this.currentOpenRound()
    if (current === undefined) return false
    this.lastRoundCreatorId = current.createdByWorkId
    this.state.sharedStateVersion += 1
    current.status = 'invalidated'
    current.invalidatedAt = nowIso()
    current.invalidatedReason = reason
    this.state.currentRoundId = null
    this.roundReopenPending = true
    this.events.emit(current.participants, 'round-invalidated', `共识轮次 ${current.id} 因“${reason}”失效`)
    this.journalLocked('round-invalidated-by-activity', { roundId: current.id, reason })
    return true
  }

  private scheduleRoundReopen(): void {
    if (!this.dispatch || this.closing || this.state.status !== 'active') return
    if (!this.roundReopenPending || this.roundReopenTimer !== undefined) return
    if (this.currentOpenRound() !== undefined) {
      this.roundReopenPending = false
      return
    }
    const timer = setTimeout(() => {
      this.roundReopenTimer = undefined
      void this.reopenRoundIfStable()
    }, 120)
    timer.unref?.()
    this.roundReopenTimer = timer
  }

  private async reopenRoundIfStable(): Promise<void> {
    if (!this.dispatch || this.closing || !this.roundReopenPending) return
    if (this.recovering.size > 0) return
    if (this.activityPending > 0) {
      this.scheduleRoundReopen()
      return
    }
    let opened: RoundRecord | undefined
    await this.mutex.run(async () => {
      if (this.state.status !== 'active' || this.currentOpenRound() !== undefined) return
      const participants = this.activeIds()
      if (participants.length === 0) {
        // No one to ask. A later recovery/join can propose a round again; this
        // keeps whenQuiet from waiting on an unanswerable reopen forever.
        this.roundReopenPending = false
        return
      }
      if (!this.isStableForRoundLocked()) return
      const creator =
        this.lastRoundCreatorId !== undefined && participants.includes(this.lastRoundCreatorId)
          ? this.lastRoundCreatorId
          : participants[0]!
      opened = this.openRoundLocked(creator, undefined, '实际执行活动已经结束，重新征询终点是否达成。')
      this.roundReopenPending = false
      await this.persistLocked()
      this.journalLocked('round-reopened-after-activity', {
        roundId: opened.id,
        creator,
        participants,
      })
    })
    if (opened !== undefined) {
      for (const participant of opened.participants) this.scheduleDelivery(participant)
    }
  }

  /** True when every participant is at a verified, stable action boundary. */
  private isStableForRoundLocked(): boolean {
    if (this.activityPending > 0) return false
    for (const work of this.activeWorks()) {
      if (work.runtimeStatus !== 'idle' && work.runtimeStatus !== 'waiting') return false
      if (activityBlockers(work).length > 0) return false
    }
    return true
  }

  private async waitForActivityIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.activityPending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  // -------------------------------------------------------------------------
  // Failure handling and retry (docs/ARCHITECTURE.md)
  // -------------------------------------------------------------------------

  private retryDelay(attempts: number, hintMs?: number): number {
    const exponential = Math.min(
      this.retryPolicy.maxMs,
      this.retryPolicy.initialMs * this.retryPolicy.factor ** Math.max(0, attempts - 1),
    )
    const jittered = exponential * (1 + Math.random() * this.retryPolicy.jitter)
    const withHint = hintMs !== undefined && Number.isFinite(hintMs) ? Math.max(jittered, hintMs) : jittered
    return Math.round(clamp(withHint, 50, Math.max(this.retryPolicy.maxMs, hintMs ?? 0)))
  }

  private async handleFailure(workIdValue: string, error: unknown, kind: string): Promise<void> {
    if (this.closing) return
    const work = this.activeWork(workIdValue)
    if (work === undefined) return
    const message = describeError(error)
    const now = Date.now()
    const previous = this.recentFailures.get(workIdValue)
    // A harness process exit often reports the same failure through both the
    // pending request and the exit notification. Count it once.
    if (previous !== undefined && previous.message === message && now - previous.at < 1_500) return
    this.recentFailures.set(workIdValue, { message, at: now })
    const details = (error as { details?: { retryAfterMs?: unknown } }).details
    const hint = typeof details?.retryAfterMs === 'number' ? details.retryAfterMs : undefined
    let delay = this.retryPolicy.initialMs
    await this.mutex.run(async () => {
      const current = this.activeWork(workIdValue)
      if (current === undefined) return
      const attempts = (current.lastError?.attempts ?? 0) + 1
      delay = this.retryDelay(attempts, hint)
      current.lastError = {
        message,
        at: nowIso(),
        attempts,
        nextRetryAt: plusMs(nowIso(), delay),
        kind,
      }
      current.runtimeStatus = 'retrying'
      current.updatedAt = nowIso()
      await this.persistLocked()
      this.journalLocked('work-request-failed', { workId: workIdValue, attempts, delay, message, kind })
      this.events.emit([workIdValue], 'retry-scheduled', `请求失败，将在 ${Math.round(delay / 1000)} 秒后重试：${message}`)
    })
    this.logger.warn(`${workIdValue}: 请求失败（${kind}），${delay}ms 后重试：${message}`)
    this.scheduleRetry(workIdValue, delay)
  }

  private scheduleRetry(workIdValue: string, delayMs: number): void {
    if (!this.dispatch) return
    const existing = this.retryTimers.get(workIdValue)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.retryTimers.delete(workIdValue)
      void this.recoverWork(workIdValue, 'retry')
    }, delayMs)
    timer.unref?.()
    this.retryTimers.set(workIdValue, timer)
  }

  // -------------------------------------------------------------------------
  // Completion consensus (docs/ARCHITECTURE.md)
  // -------------------------------------------------------------------------

  private currentOpenRound(): RoundRecord | undefined {
    if (this.state.currentRoundId === null) return undefined
    const round = this.state.rounds.find((item) => item.id === this.state.currentRoundId)
    return round?.status === 'open' && round.runId === this.state.currentRunId ? round : undefined
  }

  /**
   * Bump the shared state version and invalidate the open round.
   * Every listed event uses this one mechanism; the runtime does not judge
   * whether the new content is "important enough".
   */
  private bumpSharedStateLocked(reason: string): { invalidated?: RoundRecord; reopened?: RoundRecord } {
    this.state.sharedStateVersion += 1
    const current = this.currentOpenRound()
    if (current === undefined) {
      if (this.roundReopenPending) this.scheduleRoundReopen()
      return {}
    }
    this.lastRoundCreatorId = current.createdByWorkId
    current.status = 'invalidated'
    current.invalidatedAt = nowIso()
    current.invalidatedReason = reason
    this.state.currentRoundId = null
    this.events.emit(current.participants, 'round-invalidated', `共识轮次 ${current.id} 因“${reason}”失效`)
    if (this.state.status !== 'active') return { invalidated: current }
    const participants = this.activeIds()
    if (participants.length === 0) return { invalidated: current }
    const reopened = this.openRoundLocked(
      current.createdByWorkId,
      `共享状态在上一轮共识后发生变化（${reason}），需要重新判断终点是否达成。`,
      `共享状态已变化（${reason}），重新征询终点是否达成。`,
    )
    for (const participant of reopened.participants) this.scheduleDelivery(participant)
    return { invalidated: current, reopened }
  }

  private openRoundLocked(createdBy: string, reason: string | undefined, noticeReason: string): RoundRecord {
    this.roundReopenPending = false
    if (this.roundReopenTimer !== undefined) {
      clearTimeout(this.roundReopenTimer)
      this.roundReopenTimer = undefined
    }
    const previous = this.currentOpenRound()
    if (previous !== undefined) {
      previous.status = 'invalidated'
      previous.invalidatedAt = nowIso()
      previous.invalidatedReason = '被新的共识轮次取代'
    }
    const participants = this.activeIds()
    const sequence = ++this.state.counters.round
    const run = this.currentRunLocked()
    const round: RoundRecord = {
      id: roundId(sequence),
      runId: run.id,
      createdAt: nowIso(),
      createdByWorkId: createdBy,
      reason,
      targetVersion: this.state.targetVersion,
      sharedStateVersion: this.state.sharedStateVersion,
      participants,
      opinions: {},
      status: 'open',
    }
    this.state.rounds.push(round)
    run.roundIds.push(round.id)
    this.state.currentRoundId = round.id
    for (const participant of participants) {
      this.addSystemNoticeLocked(participant, buildRoundNotice(round, this.state, noticeReason), [round.id])
    }
    this.events.emit(participants, 'round-opened', `共识轮次 ${round.id} 已开启`)
    return round
  }

  /** Evaluate every precondition without changing state. */
  private evaluateCompletionLocked(): { ok: true; round: RoundRecord } | { ok: false; blockers: string[] } {
    const blockers: string[] = []
    if (this.state.status !== 'active') return { ok: false, blockers: ['任务不是 active'] }
    const run = this.currentRunLocked()
    if (run.cleanup !== 'none') {
      blockers.push(`当前运行轮次 ${run.id} 的终止清理尚未完成`)
    }
    if (this.pendingActions > 0) blockers.push('有尚未结算的运行时动作（裂变/发现/消息等）')
    if (this.pendingProtocolWrites > 0) blockers.push('有尚未提交的运行时写入（发现/消息/方向/共识等）')
    if (this.activityPending > 0) blockers.push('仍有尚未处理的 harness 活动事件')
    const participants = this.activeIds()
    if (participants.length === 0) blockers.push('没有参与任务的 work（空集合不能判定完成）')
    for (const id of participants) {
      const work = this.state.works[id]
      if (work === undefined) continue
      blockers.push(...activityBlockers(work))
    }
    // Retiring a work removes it from the participant set, not from the task's
    // outstanding activity. Leftover jobs and unresolved results still block
    // completion until they settle or a remaining work reconciles them. Works
    // from an ended run are historical and never block the current run.
    for (const work of Object.values(this.state.works)) {
      if (work.runId !== run.id || work.runtimeStatus !== 'exited') continue
      for (const blocker of activityBlockers(work)) {
        blockers.push(`已退出 work 的遗留活动：${blocker}`)
      }
    }
    // A report's fixed entry is the only current publication surface. A pending
    // write or a direct edit means the committed revision cannot be verified.
    // Checked before the round lookup so an unverifiable report is visible even
    // when no round is open.
    for (const report of Object.values(this.state.reports)) {
      if (report.entryState === 'pending') {
        blockers.push(`报告 ${report.key} r${report.revision} 的固定入口尚未写出（已提交，等待补齐）`)
      } else if (report.entryState === 'drift') {
        blockers.push(`报告 ${report.key} 的固定入口与已登记版本不一致：${report.driftNote ?? '内容被修改'}`)
      }
    }
    const round = this.currentOpenRound()
    if (round === undefined) {
      blockers.push('当前没有开放的共识轮次')
      return { ok: false, blockers }
    }
    if (round.runId !== run.id) blockers.push('共识轮次不属于当前运行轮次')
    if (round.targetVersion !== this.state.targetVersion) blockers.push('目标版本已变化')
    if (round.sharedStateVersion !== this.state.sharedStateVersion) blockers.push('共享状态版本已变化')
    if (!sameSet(round.participants, participants)) blockers.push('参与 work 集合已变化')
    const notAgreed = participants.filter((id) => round.opinions[id]?.opinion !== 'agree')
    if (notAgreed.length > 0) blockers.push(`尚未明确同意：${notAgreed.join(', ')}`)
    const busy = participants.filter((id) => {
      const status = this.state.works[id]?.runtimeStatus
      return status !== 'idle' && status !== 'waiting'
    })
    if (busy.length > 0) blockers.push(`尚未完成当前动作：${busy.join(', ')}`)
    const pending = pendingUserMessages(this.state, participants)
    if (pending.length > 0) blockers.push(`有尚未投递的工作消息：${pending.map((item) => item.id).join(', ')}`)
    const delivering = participants.filter((id) => this.delivering.has(id))
    if (delivering.length > 0) blockers.push(`正在向以下 work 投递消息：${delivering.join(', ')}`)
    // A user command must have reached every current participant's model
    // context. Saved/enqueued is not enough, and an exited recipient is
    // resolved by the remaining participants' own delivery records.
    const undeliveredCommands: string[] = []
    for (const command of this.state.commands) {
      for (const id of participants) {
        const delivery = command.deliveries[id]
        if (delivery === undefined) {
          undeliveredCommands.push(`${command.id}（${id}：没有投递记录）`)
          continue
        }
        if (delivery.status === 'entered-context' || delivery.status === 'recipient-exited') continue
        undeliveredCommands.push(`${command.id}（${id}：${COMMAND_DELIVERY_STATUS_TEXT[delivery.status]}）`)
      }
    }
    if (undeliveredCommands.length > 0) {
      blockers.push(`有尚未进入模型上下文的人工命令：${undeliveredCommands.join('、')}`)
    }
    if (blockers.length > 0) return { ok: false, blockers }
    return { ok: true, round }
  }

  /** Schedule one asynchronous completion check outside the current lock. */
  private scheduleCompletionCheck(): void {
    if (!this.dispatch || this.closing || this.completionScheduled) return
    this.completionScheduled = true
    setImmediate(() => {
      this.completionScheduled = false
      void this.runCompletionCheck()
    })
  }

  private async runCompletionCheck(): Promise<void> {
    if (this.closing || this.state.status !== 'active') return
    // Without an open round there is nothing to commit; avoid transport work.
    if (this.currentOpenRound() === undefined) return
    try {
      await this.waitForActivityIdle(1_000)
      const participants = this.activeIds()
      if (participants.length === 0) return
      // Ask each live harness to flush notifications already received. This is
      // an ordering barrier, not a sleep and not a liveness guess.
      for (const participant of participants) {
        try {
          await this.driver.quiesce(participant)
        } catch (error) {
          this.logger.warn(`${participant}: 活动屏障失败，跳过本次完成检查：${describeError(error)}`)
          return
        }
      }
      await this.waitForActivityIdle(1_000)
      if (this.activityPending > 0) return
      await this.mutex.run(async () => {
        // Re-read the fixed entries inside the commit boundary: a direct edit
        // must invalidate old votes rather than be missed by a stale snapshot.
        await this.verifyReportEntriesLocked()
        const decision = this.evaluateCompletionLocked()
        if (decision.ok) await this.commitCompletionLocked(decision.round)
      })
    } catch (error) {
      this.logger.error(`完成检查失败：${describeError(error)}`)
    }
  }

  private async commitCompletionLocked(round: RoundRecord): Promise<void> {
    const completedAt = nowIso()
    const run = this.currentRunLocked()
    const opinions: Record<string, OpinionRecord> = {}
    for (const id of round.participants) {
      const opinion = round.opinions[id]
      if (opinion !== undefined) opinions[id] = { ...opinion }
    }
    const record: CompletionRecord = {
      runId: run.id,
      roundId: round.id,
      completedAt,
      targetVersion: round.targetVersion,
      sharedStateVersion: round.sharedStateVersion,
      participants: [...round.participants],
      opinions,
      findingsCount: this.state.findings.length,
      messagesCount: this.state.messages.length,
    }

    await ensureDir(this.paths.consensusDir)
    const extended = {
      ...record,
      taskId: this.state.taskId,
      endInformation: this.state.endInformation,
      roundReason: round.reason,
      roundCreatedBy: round.createdByWorkId,
      roundCreatedAt: round.createdAt,
    }
    await writeFileAtomic(join(this.paths.consensusDir, `${round.id}.json`), `${JSON.stringify(extended, null, 2)}\n`)
    await appendFileDurable(
      join(this.paths.consensusDir, 'consensus.md'),
      renderConsensusMarkdown({ state: this.state, round, completedAt }),
    )

    round.status = 'completed'
    round.completedAt = completedAt
    this.state.currentRoundId = null
    this.roundReopenPending = false
    if (this.roundReopenTimer !== undefined) {
      clearTimeout(this.roundReopenTimer)
      this.roundReopenTimer = undefined
    }
    run.status = 'completed'
    run.endedAt = completedAt
    run.statusReason = `全体参与 work 对目标版本 v${round.targetVersion}、共享状态版本 ${round.sharedStateVersion} 明确同意`
    run.completion = record
    run.cleanup = 'pending'
    run.cleanupNote = '完成已提交，等待停止受管理执行'
    this.state.completion = record
    this.state.status = 'completed'
    this.state.statusReason = run.statusReason
    for (const work of this.activeWorks()) {
      work.runtimeStatus = 'finished'
      work.updatedAt = completedAt
    }
    await this.persistLocked()
    this.journalLocked('task-completed', { runId: run.id, roundId: round.id, participants: round.participants })
    this.events.emit('all', 'task-completed', `任务完成：${round.id}`)
    this.logger.info(`任务完成，运行轮次 ${run.id}，共识轮次 ${round.id}`)
    this.scheduleStopAll()
    this.onTaskEnded?.('completed')
  }

  /** Stop the task on explicit human request. Never records completion. */
  private async stopTaskLocked(reason: string): Promise<void> {
    if (this.state.status !== 'active') throw new AppError('TASK_NOT_ACTIVE', '任务已经结束')
    const run = this.currentRunLocked()
    const round = this.currentOpenRound()
    if (round !== undefined) {
      round.status = 'invalidated'
      round.invalidatedAt = nowIso()
      round.invalidatedReason = `任务被停止：${reason}`
      this.state.currentRoundId = null
    }
    const at = nowIso()
    run.status = 'stopped'
    run.endedAt = at
    run.stopReason = reason
    run.cleanup = 'pending'
    run.cleanupNote = '停止已提交，等待停止受管理执行'
    this.state.status = 'stopped'
    this.state.statusReason = reason
    for (const work of this.activeWorks()) {
      work.runtimeStatus = 'finished'
      work.updatedAt = at
    }
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.roundReopenPending = false
    if (this.roundReopenTimer !== undefined) {
      clearTimeout(this.roundReopenTimer)
      this.roundReopenTimer = undefined
    }
    await this.persistLocked()
    this.journalLocked('task-stopped', { runId: run.id, reason })
    this.events.emit('all', 'task-stopped', `任务被停止：${reason}`)
    this.scheduleStopAll()
    this.onTaskEnded?.('stopped')
  }

  private scheduleStopAll(): void {
    if (!this.dispatch) return
    if (this.stoppedAll) return
    this.stoppedAll = true
    this.stopAllTimer = setTimeout(() => {
      this.stopAllTimer = undefined
      void this.finishTerminalCleanup('受管理执行已停止').catch((error: unknown) => {
        this.logger.warn(`终止清理失败：${describeError(error)}`)
      })
    }, 250)
    this.stopAllTimer.unref?.()
  }

  // -------------------------------------------------------------------------
  // Work and session helpers
  // -------------------------------------------------------------------------

  private createWorkLocked(
    parent: WorkRecord | null,
    spawnReason: string,
    startPrompt: string,
    spawnRefs: string[],
    origin: WorkOrigin = parent === null ? 'initial' : 'spawn',
  ): WorkRecord {
    const sequence = ++this.state.counters.work
    const id = workId(sequence)
    const at = nowIso()
    const run = this.currentRunLocked()
    const work: WorkRecord = {
      id,
      runId: run.id,
      origin,
      sessionId: sessionIdFor(this.state.taskId, id),
      parentWorkId: parent?.id ?? null,
      spawnReason,
      startPrompt,
      spawnRefs,
      createdAt: at,
      updatedAt: at,
      direction: parent === null ? '尚未更新当前工作' : '新执行者，尚未开始',
      selfStatus: 'starting',
      runtimeStatus: 'starting',
      sessionStarted: false,
      activity: emptyActivity(),
    }
    this.state.works[id] = work
    run.workIds.push(id)
    // Every current work sees every effective user command, including works
    // that join after the command was saved and a new run's first work.
    for (const command of this.state.commands) {
      command.deliveries[id] = {
        workId: id,
        status: 'saved',
        savedAt: at,
        attempts: 0,
      }
    }
    this.bumpSharedStateLocked(`work ${id} 加入`)
    this.events.emit('all', 'work-joined', `work ${id} 加入任务`)
    return work
  }

  private initialPromptFor(work: WorkRecord): string {
    const spawn: SpawnContext | undefined =
      work.parentWorkId === null
        ? undefined
        : {
            parentWorkId: work.parentWorkId,
            reason: work.spawnReason ?? '',
            startPrompt: work.startPrompt ?? '',
            refs: work.spawnRefs ?? [],
          }
    return buildInitialPrompt({ state: this.state, paths: this.paths, work, spawn })
  }

  private sessionSpec(work: WorkRecord): WorkSessionSpec {
    return {
      workId: work.id,
      sessionId: work.sessionId,
      sessionStarted: work.sessionStarted,
      activityCursor: work.activity.lastEventSeq,
      taskDir: this.paths.taskDir,
    }
  }

  /**
   * True when this work belongs to the current run and still participates in
   * its consensus set. Works and votes from an ended run are history only.
   */
  private isActive(work: WorkRecord): boolean {
    return (
      work.runId === this.state.currentRunId &&
      work.runtimeStatus !== 'exited' &&
      work.runtimeStatus !== 'finished'
    )
  }

  private activeWork(workIdValue: string): WorkRecord | undefined {
    const work = this.state.works[workIdValue]
    return work !== undefined && this.isActive(work) ? work : undefined
  }

  private activeWorkOrThrow(workIdValue: unknown): WorkRecord {
    if (typeof workIdValue !== 'string' || workIdValue.length === 0) {
      throw new AppError('INVALID_ARGUMENT', '缺少 work ID')
    }
    const work = this.state.works[workIdValue]
    if (work === undefined) throw new AppError('WORK_NOT_FOUND', `未知 work：${workIdValue}`)
    if (!this.isActive(work)) {
      throw new AppError('WORK_EXITED', `work ${workIdValue} 已退出，或属于已结束的运行轮次，不能再执行操作`)
    }
    return work
  }

  private activeWorks(): WorkRecord[] {
    return Object.values(this.state.works)
      .filter((work) => this.isActive(work))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  private activeIds(): string[] {
    return this.activeWorks().map((work) => work.id)
  }

  private requireActiveTask(): void {
    if (this.state.status !== 'active') {
      throw new AppError('TASK_NOT_ACTIVE', `任务状态为 ${this.state.status}，不再接受写入`)
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async repairFindingsLocked(): Promise<void> {
    const result = await repairFindingsLog(this.paths.findingsFile, this.state, this.state.findings)
    if (result.modified.length > 0) {
      // Existing files may have been redacted by a human. The log is still
      // append-only; report the difference instead of rewriting it.
      this.logger.warn(`findings.md 中以下完整块与状态文本不同（保留原样）：${result.modified.join(', ')}`)
      this.journalLocked('findings-log-modified-blocks', { ids: result.modified })
    }
    if (result.action !== 'unchanged') {
      this.journalLocked('findings-log-repaired', { action: result.action, written: result.written })
    }
  }

  /**
   * Complete a report publication whose fixed entry was not written before a
   * crash. A modified (not missing) entry is left for the drift check, which
   * asks the model to confirm or restore rather than silently overwriting it.
   */
  private async repairReportsLocked(): Promise<void> {
    let changed = false
    for (const report of Object.values(this.state.reports)) {
      const entry = await readTextIfExists(this.reportEntryPath(report))
      const needsWrite = report.entryState === 'pending' || (report.entryState === 'synced' && entry === null)
      if (!needsWrite) continue
      try {
        await this.syncReportEntryLocked(report)
        changed = true
        this.journalLocked('report-entry-repaired', { key: report.key, revision: report.revision })
      } catch (error) {
        this.logger.error(`补齐报告入口失败（${report.key} r${report.revision}）：${describeError(error)}`)
      }
    }
    if (changed) await this.saveStateOnlyLocked()
  }

  private reportEntryPath(report: ReportRecord): string {
    return resolveInsideTask(this.paths.taskDir, report.path, '报告入口')
  }

  private reportContentPath(report: ReportRecord): string {
    return resolveInsideTask(this.paths.taskDir, report.contentFile, '报告内容文件')
  }

  /** Materialize the fixed entry from the committed immutable content copy. */
  private async syncReportEntryLocked(report: ReportRecord): Promise<void> {
    const content = await readTextIfExists(this.reportContentPath(report))
    if (content === null) {
      throw new AppError('REPORT_CONTENT_MISSING', `报告 ${report.key} 的已提交内容文件不存在：${report.contentFile}`)
    }
    // The content copy is the immutable publication source. Refuse to
    // materialize an entry from a tampered copy while keeping the old hash.
    if (hashReportContent(content) !== report.contentHash) {
      throw new AppError(
        'REPORT_CONTENT_CORRUPT',
        `报告 ${report.key} 的已提交内容文件哈希与登记版本不一致：${report.contentFile}`,
      )
    }
    await writeFileAtomic(this.reportEntryPath(report), content)
    report.entryState = 'synced'
    report.entrySyncedAt = nowIso()
    report.driftDetectedAt = undefined
    report.driftNote = undefined
  }

  /**
   * Compare the fixed entry with the committed hash. A pending publication is
   * completed first; a direct edit is registered as drift and invalidates the
   * open round so no old agreement can end the task over unverified content.
   */
  private async checkReportEntryLocked(report: ReportRecord): Promise<boolean> {
    if (report.entryState === 'pending') {
      const content = await readTextIfExists(this.reportContentPath(report))
      if (content === null) return false
      await this.syncReportEntryLocked(report)
      return true
    }
    // The immutable content copy must still match the registered hash; without
    // it, recovery and the fixed entry have no trustworthy source.
    const committed = await readTextIfExists(this.reportContentPath(report))
    if (committed === null || hashReportContent(committed) !== report.contentHash) {
      if (report.entryState === 'drift') return false
      report.entryState = 'drift'
      report.driftDetectedAt = nowIso()
      report.driftNote =
        committed === null ? '已提交内容文件缺失' : '已提交内容文件哈希与登记版本不一致'
      this.bumpSharedStateLocked(`报告 ${report.key} 的已提交内容不可核对`)
      this.journalLocked('report-entry-drift', { key: report.key, reason: report.driftNote })
      return true
    }
    const entry = await readTextIfExists(this.reportEntryPath(report))
    if (entry === null) {
      if (report.entryState === 'drift') return false
      report.entryState = 'drift'
      report.driftDetectedAt = nowIso()
      report.driftNote = '固定入口文件不存在'
      this.bumpSharedStateLocked(`报告 ${report.key} 的固定入口缺失`)
      this.journalLocked('report-entry-drift', { key: report.key, reason: report.driftNote })
      return true
    }
    const hash = hashReportContent(entry)
    if (hash !== report.contentHash) {
      if (report.entryState === 'drift') return false
      report.entryState = 'drift'
      report.driftDetectedAt = nowIso()
      report.driftNote = `固定入口哈希 ${hash} 与已登记版本 ${report.contentHash} 不一致`
      this.bumpSharedStateLocked(`报告 ${report.key} 的固定入口被直接修改`)
      this.journalLocked('report-entry-drift', { key: report.key, reason: report.driftNote })
      return true
    }
    if (report.entryState === 'drift') {
      // The entry was put back to the registered content; the drift is resolved
      // but the shared version already moved when it was detected.
      report.entryState = 'synced'
      report.entrySyncedAt = nowIso()
      report.driftDetectedAt = undefined
      report.driftNote = undefined
      return true
    }
    return false
  }

  /** Detect pending and drifted report entries; called before completion. */
  private async verifyReportEntriesLocked(): Promise<boolean> {
    let changed = false
    for (const report of Object.values(this.state.reports)) {
      try {
        if (await this.checkReportEntryLocked(report)) changed = true
      } catch (error) {
        this.logger.warn(`核对报告入口失败（${report.key}）：${describeError(error)}`)
      }
    }
    if (changed) await this.persistLocked()
    return changed
  }

  /** Finish a pending entry for an idempotent publish replay. */
  private async finishPendingReportLocked(report: ReportRecord): Promise<void> {
    if (report.entryState !== 'pending') return
    await this.syncReportEntryLocked(report)
    await this.saveStateOnlyLocked()
  }

  private async persistLocked(): Promise<void> {
    this.state.updatedAt = nowIso()
    await this.saveMeasuredState()
    await writeFileAtomic(this.paths.taskFile, renderTaskMarkdown(this.state))
    await writeFileAtomic(this.paths.worksFile, renderWorksMarkdown(this.state))
  }

  /**
   * Persist only the authoritative JSON. Activity changes do not affect the
   * derived Markdown views, so they avoid rewriting them on every tool event.
   */
  private async saveStateOnlyLocked(): Promise<void> {
    this.state.updatedAt = nowIso()
    await this.saveMeasuredState()
  }

  private async saveMeasuredState(): Promise<void> {
    const start = performance.now()
    try {
      const bytes = await saveState(this.paths, this.state)
      this.recordDiagnostic('state-write', { durationMs: performance.now() - start, bytes, ok: true })
    } catch (error) {
      this.recordDiagnostic('state-write', { durationMs: performance.now() - start, ok: false, error: describeError(error) })
      throw error
    }
  }

  private journalLocked(event: string, data: Record<string, unknown>): void {
    this.recordDiagnostic(event, data)
    const line = `${JSON.stringify({ at: nowIso(), event, ...data })}\n`
    void appendFileDurable(this.paths.journalFile, line).catch((error: unknown) => {
      this.logger.warn(`写运行日志失败：${describeError(error)}`)
    })
  }

  private addSystemNoticeLocked(toWorkId: string, body: string, refs: string[] = []): MessageRecord {
    const sequence = ++this.state.counters.message
    const message: MessageRecord = {
      id: messageId(sequence),
      fromWorkId: 'runtime',
      toWorkId,
      kind: 'notice',
      body,
      refs,
      createdAt: nowIso(),
      status: 'pending',
      system: true,
    }
    this.state.messages.push(message)
    this.events.emit([toWorkId], 'message-received', `${message.id}：${body.split('\n')[0] ?? ''}`)
    return message
  }

  // -------------------------------------------------------------------------
  // Shared reading and findings
  // -------------------------------------------------------------------------

  /** Read the task definition, current findings, report entries and active work table. */
  async readShared(
    workIdValue: string,
    params: { section?: string; max_chars?: unknown },
  ): Promise<SharedReadResult> {
    const work = this.activeWorkOrThrow(workIdValue)
    const section = params.section ?? 'all'
    if (!['all', 'task', 'findings', 'works', 'reports'].includes(section)) {
      throw new AppError('INVALID_ARGUMENT', `未知读取范围：${section}`)
    }
    const maxChars = typeof params.max_chars === 'number' ? clamp(Math.round(params.max_chars), 1_000, 500_000) : 120_000
    return this.mutex.run(async () => {
      this.requireActiveWorkUnlocked(work.id)
      const index = buildFindingsIndex(this.state.findings)
      const current = index.currentIds
        .map((id) => index.byId.get(id))
        .filter((finding): finding is FindingRecord => finding !== undefined)
      const parts: string[] = []
      if (section === 'all' || section === 'task') parts.push(renderTaskMarkdown(this.state))
      if (section === 'all' || section === 'findings') {
        parts.push(
          `${renderCurrentFindingsHeader(this.state, current.length, this.state.findings.length)}\n` +
            `${current.map((finding) => renderFindingBlock(finding)).join('\n')}`,
        )
      }
      if (section === 'all' || section === 'reports') {
        const reports = await Promise.all(
          Object.values(this.state.reports)
            .sort((left, right) => left.key.localeCompare(right.key))
            .map(async (report) => ({
              report,
              content: await readTextIfExists(resolveInsideTask(this.paths.taskDir, report.contentFile, '报告内容')),
            })),
        )
        parts.push(renderReportsSection(reports))
      }
      if (section === 'all' || section === 'works') parts.push(renderWorksMarkdown(this.state))
      const concatenated = parts.join('\n---\n\n')
      const limited = truncate(concatenated, maxChars)
      return {
        text: limited.text,
        taskId: this.state.taskId,
        targetVersion: this.state.targetVersion,
        sharedStateVersion: this.state.sharedStateVersion,
        participants: this.activeIds().length,
        findings: current.length,
        historicalFindings: this.state.findings.length,
        reports: Object.keys(this.state.reports).sort(),
        truncated: limited.truncated,
      }
    })
  }

  private requireActiveWorkUnlocked(workIdValue: string): WorkRecord {
    const work = this.state.works[workIdValue]
    if (work === undefined) throw new AppError('WORK_NOT_FOUND', `未知 work：${workIdValue}`)
    if (!this.isActive(work)) {
      throw new AppError('WORK_EXITED', `work ${workIdValue} 已退出`)
    }
    return work
  }

  /** Query current/historical findings or active works. */
  async queryShared(
    workIdValue: string,
    params: {
      scope?: string
      text?: string
      author?: string
      type?: string
      refs?: string
      since?: string
      view?: string
      limit?: unknown
      offset?: unknown
    },
  ): Promise<FindingQueryOutput> {
    this.activeWorkOrThrow(workIdValue)
    const scope = params.scope ?? 'findings'
    const limit = typeof params.limit === 'number' ? clamp(Math.round(params.limit), 1, 200) : 50
    const offset = typeof params.offset === 'number' ? Math.max(0, Math.round(params.offset)) : 0
    return this.mutex.run(async () => {
      this.requireActiveWorkUnlocked(workIdValue)
      if (scope === 'findings') {
        if (params.view !== undefined && params.view !== 'current' && params.view !== 'history') {
          throw new AppError('INVALID_ARGUMENT', `未知发现视图：${params.view}；可用 current | history`)
        }
        const result = queryFindings(this.state.findings, {
          text: params.text,
          author: params.author,
          type: params.type,
          refs: params.refs,
          since: params.since,
          view: params.view as FindingView | undefined,
          limit,
          offset,
        })
        const records = result.records.map((finding) => withRelations(finding, this.state.findings))
        const body = records
          .map((finding) => `${renderFindingBlock(finding)}${correctionNote(finding.id, this.state.findings)}`)
          .join('\n')
        const viewText = result.view === 'history' ? '历史视图' : '当前有效视图'
        const lines = [
          `匹配 ${result.matched} 条发现（${viewText}共 ${result.total} 条；追加日志共 ${this.state.findings.length} 条）。`,
          result.superseded.length === 0
            ? ''
            : `\n### 增量失效通知\n\n${result.superseded
                .map((notice) => `- ${notice.id} 已被 ${notice.by.join(', ')} 替代；如果你缓存了旧内容，请更新。`)
                .join('\n')}\n`,
          body,
          result.hasMore
            ? `\n还有更多结果；用 since=${result.cursor ?? ''} 继续读取。`
            : result.cursor === null
              ? ''
              : `\n本次扫描游标：${result.cursor}（没有更多结果）。`,
        ]
        return {
          text: truncate(lines.filter((line) => line !== '').join('\n'), 120_000).text,
          records,
          view: result.view,
          total: result.total,
          matched: result.matched,
          cursor: result.cursor,
          hasMore: result.hasMore,
          superseded: result.superseded,
        }
      }
      if (scope === 'works') {
        const needle = params.text?.trim().toLowerCase()
        const records = this.activeWorks().filter((work) => {
          if (params.author !== undefined && work.id !== params.author) return false
          if (needle === undefined || needle.length === 0) return true
          return `${work.id}\n${work.direction}\n${work.selfStatus}`
            .toLowerCase()
            .includes(needle)
        })
        return {
          text:
            records.length === 0
              ? '没有匹配的活跃 work。'
              : records
                  .map(
                    (work) =>
                      `### ${work.id}\n- 运行状态：${work.runtimeStatus}\n- 自述状态：${work.selfStatus}\n` +
                      `- 最近更新：${work.updatedAt}\n\n${work.direction}\n`,
                  )
                  .join('\n'),
          records,
          view: 'current',
          total: records.length,
          matched: records.length,
          cursor: null,
          hasMore: false,
          superseded: [],
        }
      }
      throw new AppError('INVALID_ARGUMENT', `未知查询范围：${scope}`)
    })
  }

  /**
   * Read one finding. An old ID resolves to its current replacements and does
   * not expand the superseded body unless `history` is explicitly requested.
   */
  async getFinding(
    workIdValue: string,
    idValue: string,
    options: { history?: boolean } = {},
  ): Promise<FindingReadResult> {
    this.activeWorkOrThrow(workIdValue)
    const id = requireText(idValue, 'id', 40)
    const history = options.history === true
    return this.mutex.run(async () => {
      this.requireActiveWorkUnlocked(workIdValue)
      const finding = this.state.findings.find((item) => item.id === id)
      if (finding === undefined) throw new AppError('FINDING_NOT_FOUND', `未知发现：${id}`)
      const index = buildFindingsIndex(this.state.findings)
      const currentIds = resolveCurrentIds(id, this.state.findings, index)
      const current = currentIds.includes(id)
      const supersededBy = index.supersededBy.get(id) ?? []
      if (history) {
        const leaves = currentIds.filter((leaf) => leaf !== id)
        return {
          id,
          authorWorkId: finding.authorWorkId,
          current,
          history: true,
          supersededBy,
          currentIds,
          record: { ...finding },
          text:
            `${renderFindingBlock(finding)}${correctionNote(id, this.state.findings)}` +
            (supersededBy.length > 0 ? `\n直接替代/更正记录：${supersededBy.join(', ')}\n` : '') +
            (leaves.length > 0
              ? `\n当前有效记录：${leaves.join(', ')}\n${leaves
                  .map((leaf) => renderFindingBlock(index.byId.get(leaf)!))
                  .join('\n')}`
              : ''),
        }
      }
      if (current) {
        return {
          id,
          authorWorkId: finding.authorWorkId,
          current: true,
          history: false,
          supersededBy,
          currentIds,
          record: { ...finding },
          text: renderFindingBlock(finding),
        }
      }
      const leaves = currentIds
        .map((leaf) => index.byId.get(leaf))
        .filter((item): item is FindingRecord => item !== undefined)
      return {
        id,
        authorWorkId: finding.authorWorkId,
        current: false,
        history: false,
        supersededBy,
        currentIds,
        record: null,
        text:
          `发现 ${id} 已被 ${supersededBy.join(', ') || '更新记录'} 替代，旧正文默认不展开。\n` +
          `当前有效记录：${currentIds.join(', ') || '（无）'}\n\n` +
          (leaves.length === 0
            ? '没有可解析的当前替代项；需要追溯原文时用 history=true。\n'
            : `${leaves.map((leaf) => renderFindingBlock(leaf)).join('\n')}\n` +
              `需要旧正文或完整替代链时用 history=true。\n`),
      }
    })
  }

  /** Atomically append a finding; the runtime owns ID, author and time. */
  async appendFinding(
    workIdValue: string,
    input: {
      text: string
      type?: string
      refs?: unknown
      evidence?: unknown
      supersedes?: unknown
      related_work?: unknown
      request_id?: string
    },
  ): Promise<FindingResult> {
    const text = requireText(input.text, 'text')
    const type = optionalText(input.type, 'type', 100)
    const refs = stringArray(input.refs, 'refs')
    const evidence = stringArray(input.evidence, 'evidence', 20)
    const supersedes = stringArray(input.supersedes, 'supersedes')
    const relatedWork = stringArray(input.related_work, 'related_work', 20)
    const requestKey = workRequestKey(workIdValue, 'findings.append', input.request_id)
    const fingerprint = requestFingerprint({ text, type, refs: [...refs].sort(), evidence: [...evidence].sort(),
      supersedes: [...supersedes].sort(), relatedWork: [...relatedWork].sort() })

    return this.mutex.run(async () => {
      const receipt = requestKey === undefined ? undefined : this.state.workRequests[requestKey]
      if (receipt !== undefined) return replayRequest<FindingResult>(receipt, fingerprint)
      const work = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      for (const ref of [...refs, ...supersedes]) {
        if (!/^F-\d+$/.test(ref)) throw new AppError('INVALID_ARGUMENT', `引用格式应为 F-xxxx：${ref}`)
        if (!this.state.findings.some((finding) => finding.id === ref)) {
          throw new AppError('FINDING_NOT_FOUND', `引用的发现不存在：${ref}`)
        }
      }
      for (const related of relatedWork) {
        if (this.state.works[related] === undefined) {
          throw new AppError('WORK_NOT_FOUND', `关联的 work 不存在：${related}`)
        }
      }
      const at = nowIso()
      const sequence = ++this.state.counters.finding
      const finding: FindingRecord = {
        id: findingId(sequence),
        authorWorkId: work.id,
        createdAt: at,
        text,
        refs,
        evidence,
        supersedes,
        relatedWork,
      }
      if (type !== undefined) finding.type = type
      // The runtime checks structure only: no self reference, no cycle, and all
      // superseded IDs already exist. It never judges the replacement content.
      if (finding.supersedes.includes(finding.id)) {
        throw new AppError('INVALID_ARGUMENT', '发现不能替代自己')
      }
      if (resolveCurrentIds(finding.id, [...this.state.findings, finding]).length === 0) {
        throw new AppError('INVALID_ARGUMENT', '替代关系会形成循环，已拒绝')
      }
      this.state.findings.push(finding)
      const result: FindingResult = {
        ...finding,
        supersededBy: [],
        text: `已追加发现 ${finding.id}（作者 ${work.id}，时间 ${at}）。\n\n${renderFindingBlock(finding)}`,
      }
      if (requestKey !== undefined) this.state.workRequests[requestKey] = { fingerprint, result: structuredClone(result) }
      this.bumpSharedStateLocked(`${work.id} 追加发现 ${finding.id}`)
      await this.persistLocked()
      try {
        await appendFileDurable(this.paths.findingsFile, `\n${renderFindingBlock(finding)}`)
      } catch (error) {
        this.logger.error(`追加 findings.md 失败（状态已保存，启动时会修复）：${describeError(error)}`)
      }
      this.journalLocked('finding-appended', {
        findingId: finding.id,
        workId: work.id,
        supersedes,
      })
      this.events.emit('all', 'finding-added', `新增发现 ${finding.id}（作者 ${work.id}）`)
      this.scheduleCompletionCheck()
      return result
    })
  }

  // -------------------------------------------------------------------------
  // Reports (docs/ARCHITECTURE.md)
  // -------------------------------------------------------------------------

  /** Read the current published report for one key. */
  async readReport(
    workIdValue: string,
    input: { key?: unknown } = {},
  ): Promise<ReportReadResult> {
    const key = normalizeReportKey(input.key)
    return this.mutex.run(async () => {
      this.requireActiveWorkUnlocked(workIdValue)
      const report = this.state.reports[key]
      if (report === undefined) {
        const known = Object.keys(this.state.reports).sort()
        return {
          key,
          found: false,
          report: null,
          content: null,
          text:
            `报告 ${key} 尚未发布。` +
            (known.length === 0 ? '' : `当前已登记的报告：${known.join(', ')}。`) +
            `\n需要报告时，先用普通文件工具写草稿，再调用 report_publish；首次发布需要 path 和 base_revision=0。`,
        }
      }
      const changed = await this.checkReportEntryLocked(report)
      if (changed) await this.persistLocked()
      const rawContent = await readTextIfExists(this.reportContentPath(report))
      const content =
        rawContent !== null && hashReportContent(rawContent) === report.contentHash ? rawContent : null
      const notes: string[] = []
      if (rawContent !== null && content === null) {
        notes.push('已提交内容文件的哈希与登记版本不一致，不能把它当作可恢复内容。')
      }
      if (report.entryState === 'pending') {
        notes.push('固定入口尚未补齐：发布已在权威状态中提交，恢复或重试发布后会写出；完成会被阻塞。')
      } else if (report.entryState === 'drift') {
        notes.push(`固定入口或已提交内容与登记版本不一致：${report.driftNote ?? '内容被直接修改'}。`)
        notes.push(
          '请确认修改后用 report_publish（draft_path 指向入口文件，base_revision 为当前版本）发布，' +
            '或调用 report_publish restore=true 恢复已登记版本。',
        )
      }
      const shown =
        content === null
          ? '（已提交内容文件缺失或不可核对）'
          : truncate(content, 120_000, `请用文件工具读取内容文件 ${report.contentFile}`).text
      return {
        key,
        found: true,
        report: { ...report },
        content,
        text:
          `# 报告 ${key}\n\n${renderReportMeta(report)}` +
          (notes.length === 0 ? '' : `\n注意：${notes.join(' ')}\n`) +
          `\n## 内容\n\n${shown}\n`,
      }
    })
  }

  /**
   * Publish a report revision.
   *
   * Order matters: the immutable content is written first, then the pointer,
   * hash, request result and consensus invalidation are committed together in
   * `state.json`; only then is the fixed entry replaced. A crash after the
   * commit leaves a pending entry that recovery (or the next replay) completes.
   */
  async publishReport(
    workIdValue: string,
    input: {
      key?: unknown
      path?: unknown
      draft_path?: unknown
      base_revision?: unknown
      request_id: string
      restore?: unknown
    },
  ): Promise<ReportPublishResult> {
    const requestId = requireText(input.request_id, 'request_id', MAX_REQUEST_ID)
    if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) {
      throw new AppError('INVALID_ARGUMENT', 'request_id 只能包含字母、数字、点、下划线、冒号和连字符')
    }
    const key = normalizeReportKey(input.key)
    const restore = input.restore === true
    const draftPath = restore ? undefined : normalizeTaskRelativePath(input.draft_path, 'draft_path')
    const baseRevision = restore ? undefined : normalizeBaseRevision(input.base_revision)
    const requestedPath =
      restore || input.path === undefined ? undefined : normalizeReportEntryPath(input.path)
    const paramsHash = hashReportContent(
      JSON.stringify({
        key,
        restore,
        draftPath: draftPath ?? null,
        baseRevision: baseRevision ?? null,
        path: requestedPath ?? null,
      }),
    )

    return this.mutex.run(async () => {
      const work = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      const previous = this.state.reportPublishes[requestId]
      if (previous !== undefined && previous.paramsHash !== paramsHash) {
        throw new AppError('REQUEST_CONFLICT', `request_id ${requestId} 已用于另一次报告发布；同 ID 不能提交不同参数`)
      }

      if (restore) {
        const report = this.state.reports[key]
        if (report === undefined) throw new AppError('REPORT_NOT_FOUND', `报告 ${key} 尚未发布，不能恢复`)
        await this.syncReportEntryLocked(report)
        await this.saveStateOnlyLocked()
        this.journalLocked('report-entry-restored', { key, revision: report.revision, workId: work.id })
        return {
          key,
          revision: report.revision,
          path: report.path,
          contentHash: report.contentHash,
          entryState: report.entryState,
          idempotent: true,
          restored: true,
          text: `已用已登记内容恢复报告 ${key} r${report.revision} 的固定入口 ${report.path}。`,
        }
      }

      if (previous !== undefined) {
        const report = this.state.reports[previous.key]
        if (report === undefined) {
          throw new AppError('STATE_CORRUPT', `报告发布记录引用了不存在的报告 ${previous.key}`)
        }
        if (report.revision === previous.revision) {
          await this.finishPendingReportLocked(report)
        }
        const currentRevision = report.revision
        return {
          key: previous.key,
          revision: previous.revision,
          path: previous.path,
          contentHash: previous.contentHash,
          entryState: currentRevision === previous.revision ? report.entryState : 'synced',
          idempotent: true,
          restored: false,
          text:
            `request ID 已提交过，返回原发布结果：${previous.key} r${previous.revision} → ${previous.path}。` +
            '（未重复创建版本，未再次使共识失效。）' +
            (currentRevision === previous.revision
              ? ''
              : `\n注意：该报告当前已更新到 r${currentRevision}；如需发布新内容请基于当前 revision 操作。`),
        }
      }

      const existing = this.state.reports[key]
      let revision: number
      let entryPath: string
      if (existing === undefined) {
        if (baseRevision !== 0) {
          throw new AppError('REPORT_CONFLICT', `报告 ${key} 尚无版本；首次发布必须使用 base_revision=0`, {
            key,
            currentRevision: 0,
          })
        }
        if (requestedPath === undefined) {
          throw new AppError('INVALID_ARGUMENT', '首次发布报告必须提供固定入口 path，例如 report.md')
        }
        entryPath = requestedPath
        revision = 1
      } else {
        if (baseRevision !== existing.revision) {
          throw new AppError(
            'REPORT_CONFLICT',
            `报告 ${key} 的当前版本是 r${existing.revision}，你基于 r${baseRevision} 发布；请重新 report_read 后合并`,
            { key, currentRevision: existing.revision, path: existing.path },
          )
        }
        if (requestedPath !== undefined && requestedPath !== existing.path) {
          throw new AppError(
            'INVALID_ARGUMENT',
            `报告 ${key} 的固定入口已登记为 ${existing.path}；不能用同一 key 改到 ${requestedPath}`,
          )
        }
        entryPath = existing.path
        revision = existing.revision + 1
      }

      const draftAbsolute = resolveInsideTask(this.paths.taskDir, draftPath!, 'draft_path')
      const draft = await readTextIfExists(draftAbsolute)
      if (draft === null) throw new AppError('INVALID_ARGUMENT', `草稿文件不存在或不可读：${draftPath}`)
      if (Buffer.byteLength(draft, 'utf8') > MAX_REPORT_BYTES) {
        throw new AppError('INVALID_ARGUMENT', `草稿超过报告大小上限 ${MAX_REPORT_BYTES} 字节`)
      }
      const contentHash = hashReportContent(draft)
      const contentFile = reportContentRelative(key, revision)
      await writeFileAtomic(resolveInsideTask(this.paths.taskDir, contentFile, '报告内容文件'), draft)

      const at = nowIso()
      const report: ReportRecord = {
        key,
        path: entryPath,
        revision,
        contentHash,
        contentFile,
        size: Buffer.byteLength(draft, 'utf8'),
        publishedByWorkId: work.id,
        publishedAt: at,
        requestId,
        entryState: 'pending',
      }
      this.state.reports[key] = report
      this.state.reportPublishes[requestId] = {
        key,
        revision,
        contentHash,
        contentFile,
        path: entryPath,
        at,
        paramsHash,
      }
      this.bumpSharedStateLocked(`报告 ${key} 发布 r${revision}`)
      await this.persistLocked()

      try {
        await this.syncReportEntryLocked(report)
        await this.saveStateOnlyLocked()
        this.journalLocked('report-published', { key, revision, workId: work.id, contentHash })
      } catch (error) {
        this.journalLocked('report-entry-pending', {
          key,
          revision,
          reason: describeError(error),
        })
        throw new AppError(
          'REPORT_ENTRY_PENDING',
          `报告 ${key} r${revision} 已提交，但固定入口 ${entryPath} 尚未写出：${describeError(error)}。` +
            '完成会被阻塞；修复文件系统后可重试同一 request ID。',
          { key, revision, path: entryPath },
        )
      }
      this.events.emit('all', 'report-published', `报告 ${key} 发布 r${revision}`)
      this.scheduleCompletionCheck()
      return {
        key,
        revision,
        path: entryPath,
        contentHash,
        entryState: report.entryState,
        idempotent: false,
        restored: false,
        text:
          `已发布报告 ${key} r${revision} → ${entryPath}（sha256 ${contentHash}）。\n` +
          '发布已递增共享状态版本并使旧完成意见失效；请让全体参与 work 按新状态重新判断。',
      }
    })
  }

  // -------------------------------------------------------------------------
  // Work row updates and self inspection
  // -------------------------------------------------------------------------

  /** Update the executor-maintained row fields. */
  async updateWork(
    workIdValue: string,
    input: { direction?: string; self_status?: string },
  ): Promise<{ text: string; work: WorkRecord; directionChanged: boolean }> {
    const direction = optionalText(input.direction, 'direction', 4_000)
    const selfStatus = optionalText(input.self_status, 'self_status', 200)
    if (direction === undefined && selfStatus === undefined) {
      throw new AppError('INVALID_ARGUMENT', '至少提供 direction 或 self_status')
    }
    return this.mutex.run(async () => {
      const work = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      const directionChanged = direction !== undefined && direction !== work.direction
      if (direction !== undefined) work.direction = direction
      if (selfStatus !== undefined) work.selfStatus = selfStatus
      work.updatedAt = nowIso()
      if (directionChanged) this.bumpSharedStateLocked(`${work.id} 改变当前工作方向`)
      await this.persistLocked()
      this.journalLocked('work-updated', { workId: work.id, directionChanged })
      this.events.emit('all', 'work-updated', `work ${work.id} 更新了状态`)
      this.scheduleCompletionCheck()
      return {
        text:
          `已更新 ${work.id}：\n- 当前工作：${work.direction}\n- 自述状态：${work.selfStatus}\n` +
          (directionChanged ? '（方向变化已使旧共识轮次失效，需要重新表态。）' : ''),
        work,
        directionChanged,
      }
    })
  }

  /** Inspect one's own work, session and consensus context. */
  async inspectSelf(workIdValue: string): Promise<{ text: string; work: WorkRecord; round: RoundRecord | null }> {
    const work = this.activeWorkOrThrow(workIdValue)
    return this.mutex.run(async () => {
      this.requireActiveWorkUnlocked(work.id)
      const round = this.currentOpenRound() ?? null
      const own = round?.opinions[work.id]?.opinion ?? '未表态'
      const missing =
        round === null ? [] : round.participants.filter((id) => round.opinions[id] === undefined)
      const unread = this.state.messages.filter(
        (message) => message.toWorkId === work.id && message.status === 'pending',
      ).length
      const pendingCommands = this.state.commands.filter((command) => {
        const delivery = command.deliveries[work.id]
        return (
          delivery !== undefined &&
          delivery.status !== 'entered-context' &&
          delivery.status !== 'recipient-exited'
        )
      })
      const lines = [
        `### work ${work.id}`,
        '',
        `- 运行轮次：${work.runId}（当前：${this.state.currentRunId}）`,
        `- 会话 ID：${work.sessionId}`,
        `- 运行状态：${work.runtimeStatus}`,
        `- 创建方式：${work.origin}`,
        `- 当前工作：${work.direction}`,
        `- 自述状态：${work.selfStatus}`,
        `- 来源 work：${work.parentWorkId ?? '无（首个执行者）'}`,
        `- 会话是否已开始：${work.sessionStarted ? '是' : '否'}`,
        `- 上下文容量/已用：未知（harness 未提供）`,
        `- 未接收消息：${unread}`,
        `- 尚未进入上下文的人工命令：${pendingCommands.length}${
          pendingCommands.length === 0 ? '' : `（${pendingCommands.map((item) => item.id).join(', ')}）`
        }`,
        work.lastError === undefined
          ? ''
          : `- 最近错误：${work.lastError.message}（第 ${work.lastError.attempts} 次，计划重试：${work.lastError.nextRetryAt ?? '未安排'}）`,
        '',
        `### 你的实际活动`,
        '',
        ...activityLines(work),
        '',
        `### 任务`,
        '',
        `- 状态：${this.state.status}${this.state.statusReason === undefined ? '' : `（${this.state.statusReason}）`}`,
        `- 运行轮次：${this.state.currentRunId}（累计 ${this.state.runs.length} 轮）`,
        `- 目标版本：v${this.state.targetVersion}`,
        `- 共享状态版本：${this.state.sharedStateVersion}`,
        `- 参与 work：${this.activeIds().join(', ') || '（无）'}`,
        '',
        `### 当前共识`,
        '',
        round === null
          ? '当前没有开放的共识轮次。'
          : `- 轮次：${round.id}（${round.status}）\n- 你的表态：${own}\n- 尚未表态：${missing.join(', ') || '（无）'}\n- 共享状态版本：${round.sharedStateVersion}`,
      ]
      return { text: lines.filter((line) => line !== '').join('\n'), work, round }
    })
  }

  /**
   * Record the model's reconciliation of actions left unknown by a lost
   * harness process (or of a settlement notice it collected another way).
   * Live actions cannot be cleared.
   */
  async reconcileWorkActivity(
    workIdValue: string,
    input: { action_ids?: unknown; note?: string },
  ): Promise<{ text: string; resolved: string[]; rejected: { id: string; reason: string }[] }> {
    const actionIds = stringArray(input.action_ids, 'action_ids', 100)
    if (actionIds.length === 0) {
      throw new AppError('INVALID_ARGUMENT', '至少提供一个要核对的工具调用 ID 或后台任务 ID')
    }
    const note = optionalText(input.note, 'note', 2_000)
    const result = await this.mutex.run(async () => {
      const caller = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      // A remaining work may reconcile a retired work's leftover actions; the
      // information belongs to the task, not to the author's session.
      const candidates = [
        caller,
        ...Object.values(this.state.works).filter(
          (work) =>
            work.id !== caller.id &&
            work.runId === caller.runId &&
            work.runtimeStatus === 'exited',
        ),
      ]
      const remaining = new Set(actionIds)
      const resolved: string[] = []
      const rejected: { id: string; reason: string }[] = []
      for (const work of candidates) {
        if (remaining.size === 0) break
        const outcome = reconcileActivity(work.activity, [...remaining], note)
        for (const id of outcome.resolved) {
          resolved.push(id)
          remaining.delete(id)
        }
        for (const item of outcome.rejected) {
          if (item.reason === '未找到该工具调用或后台任务') continue
          rejected.push(item)
          remaining.delete(item.id)
        }
      }
      for (const id of remaining) rejected.push({ id, reason: '未找到该工具调用或后台任务' })
      if (resolved.length > 0) {
        caller.updatedAt = nowIso()
        await this.saveStateOnlyLocked()
        this.journalLocked('activity-reconciled', { workId: caller.id, resolved, rejected })
      }
      return { resolved, rejected }
    })
    this.scheduleCompletionCheck()
    this.scheduleRoundReopen()
    const lines = [
      result.resolved.length === 0 ? '没有动作被核对。' : `已记录核对：${result.resolved.join(', ')}`,
      result.rejected.length === 0
        ? ''
        : `未核对：${result.rejected.map((item) => `${item.id}（${item.reason}）`).join('；')}`,
      '核对只表示你已经检查过这些动作的结果，不会替其他 work 表态，也不代表终点已达成。',
    ]
    return {
      text: lines.filter((line) => line.length > 0).join('\n'),
      resolved: result.resolved,
      rejected: result.rejected,
    }
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /** Persist and deliver an asynchronous message to one or more works. */
  async sendMessage(
    workIdValue: string,
    input: { to: unknown; kind?: string; body: string; refs?: unknown; request_id?: string },
  ): Promise<{ text: string; results: SendResult[] }> {
    const body = requireText(input.body, 'body', MAX_BODY)
    const kind = (input.kind ?? 'hint') as MessageKind
    if (!MESSAGE_KINDS.includes(kind)) {
      throw new AppError('INVALID_ARGUMENT', `未知消息类型：${String(input.kind)}；可用：${MESSAGE_KINDS.join(', ')}`)
    }
    const targets = stringArray(input.to, 'to', 50)
    if (targets.length === 0) throw new AppError('INVALID_ARGUMENT', '至少提供一个收件 work')
    const refs = stringArray(input.refs, 'refs')

    const result = await this.mutex.run(async () => {
      const requestKey = workRequestKey(workIdValue, 'peer.send', input.request_id)
      const fingerprint = requestFingerprint({ body, kind, targets: [...targets].sort(), refs: [...refs].sort() })
      const receipt = requestKey === undefined ? undefined : this.state.workRequests[requestKey]
      if (receipt !== undefined) {
        const replay = replayRequest<{ text: string; results: SendResult[] }>(receipt, fingerprint)
        return { ...replay, delivered: [] as string[] }
      }
      const sender = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      for (const ref of refs) {
        if (!/^F-\d+$/.test(ref)) throw new AppError('INVALID_ARGUMENT', `引用格式应为 F-xxxx：${ref}`)
        if (!this.state.findings.some((finding) => finding.id === ref)) {
          throw new AppError('FINDING_NOT_FOUND', `引用的发现不存在：${ref}`)
        }
      }
      const results: SendResult[] = []
      const created: MessageRecord[] = []
      for (const target of targets) {
        if (target === sender.id) {
          results.push({ to: target, ok: false, code: 'INVALID_ARGUMENT', message: '不能给自己发消息' })
          continue
        }
        const recipient = this.state.works[target]
        if (recipient === undefined) {
          results.push({ to: target, ok: false, code: 'WORK_NOT_FOUND', message: '未知 work' })
          continue
        }
        if (!this.isActive(recipient)) {
          results.push({ to: target, ok: false, code: 'WORK_EXITED', message: '收件 work 已退出' })
          continue
        }
        const message: MessageRecord = {
          id: messageId(++this.state.counters.message),
          fromWorkId: sender.id,
          toWorkId: target,
          kind,
          body,
          refs,
          createdAt: nowIso(),
          status: 'pending',
          system: false,
        }
        this.state.messages.push(message)
        created.push(message)
        results.push({ to: target, ok: true, messageId: message.id })
      }
      if (created.length > 0) {
        this.bumpSharedStateLocked(`${sender.id} 发送工作消息`)
      }
      const delivered = created.map((message) => message.toWorkId)
      const failed = results.filter((item) => !item.ok)
      const text = [
        created.length === 0 ? '没有任何消息被持久化。' : `已发送：${created.map((message) => message.id).join(', ')}`,
        failed.length === 0
          ? ''
          : `未发送：${failed.map((item) => `${item.to}（${item.code}: ${item.message}）`).join('；')}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n')
      if (requestKey !== undefined) {
        this.state.workRequests[requestKey] = { fingerprint, result: structuredClone({ text, results }) }
      }
      if (created.length > 0 || requestKey !== undefined) await this.persistLocked()
      if (created.length > 0) {
        this.journalLocked('message-sent', {
          from: sender.id, to: created.map((message) => message.toWorkId), ids: created.map((message) => message.id),
        })
        for (const message of created) {
          this.events.emit([message.toWorkId], 'message-received', `收到 ${message.id}（来自 ${sender.id}）`)
        }
        this.scheduleCompletionCheck()
      }
      return { text, results, delivered }
    })
    for (const target of result.delivered) this.scheduleDelivery(target)
    if (!result.results.some((item) => item.ok)) {
      throw new AppError('MESSAGE_NOT_DELIVERED', result.text, { results: result.results })
    }
    return { text: result.text, results: result.results }
  }

  /** Read messages addressed to this work. */
  async readInbox(
    workIdValue: string,
    params: { limit?: unknown; include_delivered?: unknown; include_system?: unknown },
  ): Promise<{ text: string; messages: MessageRecord[] }> {
    const limit = typeof params.limit === 'number' ? clamp(Math.round(params.limit), 1, 100) : 20
    return this.mutex.run(async () => {
      const work = this.requireActiveWorkUnlocked(workIdValue)
      const available = inboxMessages(this.state, work.id, {
        includeDelivered: params.include_delivered === true,
        includeSystem: params.include_system !== false,
        limit,
      })
      const messages = takeByBudget(available, (message) => message.body.length + 256, 120_000)
      const at = nowIso()
      let changed = false
      for (const message of messages) {
        if (message.status === 'pending') {
          message.status = 'read'
          message.readAt = at
          message.deliveredAt = message.deliveredAt ?? at
          changed = true
        } else if (message.status === 'delivered' && message.readAt === undefined) {
          message.status = 'read'
          message.readAt = at
          changed = true
        }
      }
      if (changed) await this.persistLocked()
      const remaining = available.length - messages.length
      return {
        text:
          messages.length === 0
            ? '没有待接收的消息。'
            : `共 ${messages.length} 条消息：\n\n${messages
                .map((message) => {
                  const from = message.system ? '运行时' : message.fromWorkId
                  const refs = message.refs.length > 0 ? `\n引用：${message.refs.join(', ')}` : ''
                  return `### ${message.id} · ${from} · ${message.kind} · ${message.createdAt}\n${message.body}${refs}`
                })
                .join('\n\n')}${remaining > 0 ? `\n\n（还有 ${remaining} 条消息因输出长度限制未返回，请再次调用 peer_inbox。）` : ''}`,
        messages,
      }
    })
  }

  // -------------------------------------------------------------------------
  // Human commands
  // -------------------------------------------------------------------------

  /**
   * Allocate one task-level command and its delivery records. The caller owns
   * the surrounding transaction; the shared version is bumped here because a
   * command always invalidates previous completion opinions.
   */
  private createCommandLocked(input: {
    text: string
    requestId: string
    source: CommandRecord['source']
    recipients: readonly string[]
  }): CommandRecord {
    const at = nowIso()
    const sequence = ++this.state.counters.command
    const command: CommandRecord = {
      id: commandId(sequence),
      runId: this.state.currentRunId,
      requestId: input.requestId,
      sequence,
      text: input.text,
      source: input.source,
      createdAt: at,
      deliveries: {},
    }
    for (const id of input.recipients) {
      command.deliveries[id] = { workId: id, status: 'saved', savedAt: at, attempts: 0 }
    }
    this.state.commands.push(command)
    this.currentRunLocked().commandIds.push(command.id)
    this.bumpSharedStateLocked(`用户命令 ${command.id}`)
    return command
  }

  /**
   * Persist one task-level human command and create one delivery record per
   * current participant. The command itself is delivered later at a harness
   * input boundary; this method only commits the intent and its recipients.
   */
  async sendCommand(input: {
    text: string
    requestId: string
    source?: CommandRecord['source']
  }): Promise<CommandResult> {
    const text = requireText(input.text, 'text', MAX_COMMAND_TEXT)
    const requestId = requireText(input.requestId, 'request_id', MAX_REQUEST_ID)
    if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) {
      throw new AppError('INVALID_ARGUMENT', 'request_id 只能包含字母、数字、点、下划线、冒号和连字符')
    }
    const source = input.source ?? 'api'
    if (!COMMAND_SOURCES.includes(source)) {
      throw new AppError('INVALID_ARGUMENT', `未知命令来源：${String(source)}`)
    }
    const result = await this.mutex.run(async () => {
      // Idempotent replay comes first: a retry after the task ended must still
      // return the original committed command instead of a spurious error.
      const existing = this.state.commands.find((command) => command.requestId === requestId)
      if (existing !== undefined) {
        if (existing.text !== text) {
          throw new AppError(
            'REQUEST_CONFLICT',
            `request_id ${requestId} 已用于另一条命令（${existing.id}）；同 ID 不能提交不同正文`,
          )
        }
        return { command: existing, idempotent: true }
      }
      this.requireActiveTask()
      const participants = this.activeIds()
      const command = this.createCommandLocked({ text, requestId, source, recipients: participants })
      await this.persistLocked()
      this.journalLocked('command-saved', {
        commandId: command.id,
        requestId,
        source,
        recipients: participants,
        chars: text.length,
      })
      // Wake a work parked in executor_wait so its turn can reach the boundary
      // where the steering plugin hands over the command.
      this.events.emit(participants, 'user-command', `收到用户命令 ${command.id}，将在下一个输入边界送达`)
      return { command, idempotent: false }
    })
    this.scheduleCompletionCheck()
    return {
      command: result.command,
      idempotent: result.idempotent,
      text: this.renderCommandResult(result.command, result.idempotent),
    }
  }

  /**
   * One steering-plugin poll. Returns only commands that are still saved and
   * not under a live claim; the claim token scopes the follow-up ack.
   */
  async claimCommands(
    workIdValue: string,
    input: CommandClaimInput = {},
  ): Promise<{ commands: ClaimedCommand[] }> {
    return this.mutex.run(async () => {
      if (this.closing || this.state.status !== 'active') return { commands: [] }
      const work = this.state.works[workIdValue]
      if (work === undefined || !this.isActive(work)) return { commands: [] }
      if (input.sessionId !== undefined && input.sessionId !== work.sessionId) return { commands: [] }
      if (input.generation !== undefined && input.generation !== work.activity.generation) {
        return { commands: [] }
      }
      if (!work.sessionStarted) return { commands: [] }
      if (
        work.runtimeStatus === 'starting' ||
        work.runtimeStatus === 'retrying' ||
        work.runtimeStatus === 'exited' ||
        work.runtimeStatus === 'finished'
      ) {
        return { commands: [] }
      }
      if (this.recovering.has(workIdValue) || this.booting.has(workIdValue)) return { commands: [] }
      // Do not inject a command between a prompt request and its receipt; the
      // initial/recovery prompt must be the first input of a new session.
      if (this.prompting.has(workIdValue)) return { commands: [] }
      const now = Date.now()
      const claimed: ClaimedCommand[] = []
      let changed = false
      for (const command of this.state.commands) {
        if (claimed.length >= MAX_COMMAND_CLAIMS) break
        const delivery = command.deliveries[workIdValue]
        if (delivery === undefined || delivery.status !== 'saved') continue
        if (delivery.claim !== undefined) {
          const claimedAt = Date.parse(delivery.claim.at)
          if (Number.isFinite(claimedAt) && now - claimedAt < COMMAND_CLAIM_LEASE_MS) continue
        }
        delivery.claim = { token: randomUUID(), at: nowIso() }
        delivery.attempts += 1
        claimed.push({ id: command.id, text: buildCommandPrompt(command), token: delivery.claim.token })
        changed = true
      }
      if (changed) await this.saveStateOnlyLocked()
      return { commands: claimed }
    })
  }

  /** Record the harness admission receipt for one steered command. */
  async ackCommand(
    workIdValue: string,
    input: { commandId: string; token: string; messageId: string },
  ): Promise<{ text: string; delivery: CommandDeliveryRecord }> {
    const commandIdValue = requireText(input.commandId, 'commandId', 40)
    const token = requireText(input.token, 'token', 200)
    const harnessMessageId = requireText(input.messageId, 'messageId', 200)
    return this.mutex.run(async () => {
      const work = this.state.works[workIdValue]
      if (work === undefined) throw new AppError('WORK_NOT_FOUND', `未知 work：${workIdValue}`)
      const command = this.state.commands.find((item) => item.id === commandIdValue)
      const delivery = command?.deliveries[workIdValue]
      if (command === undefined || delivery === undefined) {
        throw new AppError('COMMAND_NOT_FOUND', `未知命令或该命令没有发给 ${workIdValue}：${commandIdValue}`)
      }
      if (delivery.status === 'recipient-exited') {
        return { text: `${workIdValue} 已退出，忽略命令 ${commandIdValue} 的投递回执。`, delivery }
      }
      if (delivery.status === 'entered-context') {
        return { text: `命令 ${commandIdValue} 已进入模型上下文。`, delivery }
      }
      if (delivery.claim === undefined || delivery.claim.token !== token) {
        throw new AppError(
          'COMMAND_CLAIM_STALE',
          `命令 ${commandIdValue} 的投递认领已过期；运行时会重新投递`,
        )
      }
      if (delivery.harnessMessageId === undefined) delivery.harnessMessageId = harnessMessageId
      delivery.status = 'enqueued'
      delivery.enqueuedAt = nowIso()
      delivery.claim = undefined
      await this.saveStateOnlyLocked()
      this.journalLocked('command-enqueued', {
        workId: workIdValue,
        commandId: commandIdValue,
        messageId: delivery.harnessMessageId,
      })
      return {
        text: `命令 ${commandIdValue} 已入 ${workIdValue} 的 harness 队列（${delivery.harnessMessageId}）。`,
        delivery,
      }
    })
  }

  /** Give a claim back without an ack so another poll can retry immediately. */
  async releaseCommand(
    workIdValue: string,
    input: { commandId: string; token: string; reason?: string },
  ): Promise<{ text: string }> {
    const commandIdValue = requireText(input.commandId, 'commandId', 40)
    const token = requireText(input.token, 'token', 200)
    const reason = optionalText(input.reason, 'reason', 500)
    return this.mutex.run(async () => {
      const command = this.state.commands.find((item) => item.id === commandIdValue)
      const delivery = command?.deliveries[workIdValue]
      if (delivery === undefined) return { text: '没有需要释放的投递认领。' }
      if (delivery.claim?.token !== token) return { text: '投递认领已被替换，忽略本次释放。' }
      delivery.claim = undefined
      if (reason !== undefined) delivery.note = reason
      await this.saveStateOnlyLocked()
      this.journalLocked('command-claim-released', {
        workId: workIdValue,
        commandId: commandIdValue,
        reason,
      })
      return { text: `已释放命令 ${commandIdValue} 的投递认领，可重新投递。` }
    })
  }

  /** Read the task-level command log for humans. */
  async listCommands(): Promise<CommandRecord[]> {
    return this.mutex.run(async () =>
      this.state.commands.map((command) => ({
        ...command,
        deliveries: Object.fromEntries(
          Object.entries(command.deliveries).map(([id, delivery]) => [id, { ...delivery }]),
        ),
      })),
    )
  }

  /**
   * Mark the delivery whose harness message id was just observed entering the
   * session log. This is the only proof the runtime accepts for context entry.
   */
  private markCommandContextLocked(workIdValue: string, harnessMessageId: string, at: string): boolean {
    let changed = false
    for (const command of this.state.commands) {
      const delivery = command.deliveries[workIdValue]
      if (delivery === undefined || delivery.harnessMessageId !== harnessMessageId) continue
      if (delivery.status === 'entered-context') continue
      delivery.status = 'entered-context'
      delivery.enteredContextAt = at
      delivery.claim = undefined
      changed = true
    }
    return changed
  }

  private renderCommandResult(command: CommandRecord, idempotent: boolean): string {
    const deliveries = Object.values(command.deliveries)
    const source = command.source === 'web' ? 'Web UI' : command.source === 'cli' ? 'CLI' : 'API'
    const lines = [
      idempotent
        ? `request ID 已提交过，返回原命令 ${command.id}（未重复创建，未重复使共识失效）。`
        : `已保存用户命令 ${command.id}。`,
      `来源：${source}；时间：${command.createdAt}；请求 ID：${command.requestId}`,
      deliveries.length === 0
        ? '当前没有参与 work；命令已保存在任务中，新的 work 加入时会收到。'
        : `收件 work：${deliveries
            .map((delivery) => `${delivery.workId}（${COMMAND_DELIVERY_STATUS_TEXT[delivery.status]}）`)
            .join('、')}`,
      '这些状态只表示投递进展，不表示要求已经完成；命令提交已使旧完成意见失效。',
    ]
    return lines.join('\n')
  }

  // -------------------------------------------------------------------------
  // Fission and retirement
  // -------------------------------------------------------------------------

  /** Create a brand-new executor session and register the new work. */
  async spawnWork(
    workIdValue: string,
    input: { reason: string; start_prompt: string; refs?: unknown; request_id?: string },
  ): Promise<SpawnResult> {
    const reason = requireText(input.reason, 'reason', 4_000)
    const startPrompt = requireText(input.start_prompt, 'start_prompt', MAX_TEXT)
    const refs = stringArray(input.refs, 'refs')
    const requestId = optionalText(input.request_id, 'request_id', MAX_REQUEST_ID)
    if (requestId !== undefined && !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
      throw new AppError('INVALID_ARGUMENT', 'request_id 只能包含字母、数字、点、下划线和连字符')
    }

    const outcome = await this.mutex.run(async () => {
      const parent = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      if (requestId !== undefined) {
        const existing = Object.values(this.state.works).find(
          (work) => work.runId === this.state.currentRunId && work.spawnRequestId === requestId,
        )
        if (existing !== undefined) {
          const sameRequest =
            existing.parentWorkId === parent.id &&
            existing.spawnReason === reason &&
            existing.startPrompt === startPrompt &&
            sameSet(existing.spawnRefs ?? [], refs)
          if (!sameRequest) {
            throw new AppError(
              'REQUEST_CONFLICT',
              `request_id ${requestId} 已用于另一次裂变；同 ID 不能提交不同理由、起始提示或来源`,
            )
          }
          return { child: existing, idempotent: true }
        }
      }
      for (const ref of refs) {
        if (!/^F-\d+$/.test(ref)) throw new AppError('INVALID_ARGUMENT', `引用格式应为 F-xxxx：${ref}`)
        if (!this.state.findings.some((finding) => finding.id === ref)) {
          throw new AppError('FINDING_NOT_FOUND', `引用的发现不存在：${ref}`)
        }
      }
      const child = this.createWorkLocked(parent, reason, startPrompt, refs)
      if (requestId !== undefined) child.spawnRequestId = requestId
      await this.persistLocked()
      this.journalLocked('work-spawned', {
        parentWorkId: parent.id,
        workId: child.id,
        reason,
        refs,
        requestId,
      })
      return { child, idempotent: false }
    })

    const created = outcome.child
    if (outcome.idempotent) {
      return {
        workId: created.id,
        sessionId: created.sessionId,
        parentWorkId: workIdValue,
        idempotent: true,
        text:
          `request ID 已提交过，返回原执行者 ${created.id}（会话 ${created.sessionId}），未重复创建。\n` +
          `如需新的并行执行者，请使用新的 request_id 或不传该参数。`,
      }
    }

    this.pendingActions += 1
    try {
      await this.bootWork(created.id, true)
      this.events.emit([created.id], 'work-started', `work ${created.id} 已启动`)
      return {
        workId: created.id,
        sessionId: created.sessionId,
        parentWorkId: workIdValue,
        idempotent: false,
        text:
          `已创建执行者 ${created.id}（来源 ${workIdValue}，会话 ${created.sessionId}）。\n` +
          `新执行者已获得任务定义、裂变理由和你的起始提示。你可以继续当前工作，也可以在完成交接后退出。`,
      }
    } catch (error) {
      await this.rollbackSpawn(created.id, error)
      throw new AppError('SPAWN_FAILED', `创建执行者失败：${describeError(error)}`, {
        workId: created.id,
        cause: describeError(error),
      })
    } finally {
      this.pendingActions -= 1
      this.scheduleCompletionCheck()
    }
  }

  private async rollbackSpawn(workIdValue: string, error: unknown): Promise<void> {
    await this.mutex.run(async () => {
      const work = this.state.works[workIdValue]
      if (work === undefined) return
      delete this.state.works[workIdValue]
      for (const run of this.state.runs) {
        const index = run.workIds.indexOf(workIdValue)
        if (index >= 0) run.workIds.splice(index, 1)
      }
      this.drainQueue(workIdValue, error)
      this.bumpSharedStateLocked(`work ${workIdValue} 创建失败`)
      await this.persistLocked()
      this.journalLocked('work-spawn-rolled-back', {
        workId: workIdValue,
        message: describeError(error),
      })
      this.events.emit('all', 'work-left', `work ${workIdValue} 创建失败，已移除`)
    })
    await this.driver.stop(workIdValue).catch(() => undefined)
  }

  /** Retire this work, remove it from the active table and notify affected senders. */
  async retireWork(workIdValue: string, input: { reason: string }): Promise<RetireResult> {
    const reason = requireText(input.reason, 'reason', 4_000)
    const result = await this.mutex.run(async () => {
      const work = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      work.runtimeStatus = 'exited'
      work.exitReason = reason
      work.exitAt = nowIso()
      work.updatedAt = nowIso()
      // The process will be stopped shortly. Open tools and running jobs may
      // or may not settle first; track them as unknown until a result arrives
      // or a remaining work reconciles them.
      markActivityUnknown(work.activity)
      for (const job of Object.values(work.activity.jobs)) {
        if (job.notice !== 'pending') continue
        job.notice = 'delivered'
        job.noticeAt = nowIso()
        job.reconciledNote = 'work 已退出，不再向该 work 投递通知'
      }
      // Task-level commands remain in force for the remaining works, but this
      // recipient can no longer acknowledge them.
      for (const command of this.state.commands) {
        const delivery = command.deliveries[work.id]
        if (delivery === undefined || delivery.status === 'entered-context') continue
        delivery.status = 'recipient-exited'
        delivery.note = '收件 work 已退出'
        delivery.claim = undefined
      }
      const undelivered = this.state.messages.filter(
        (message) => message.toWorkId === work.id && message.status === 'pending',
      )
      const at = nowIso()
      for (const message of undelivered) {
        message.status = 'recipient-exited'
        message.note = '收件方已退出'
        message.deliveredAt = at
      }
      const senders = [...new Set(undelivered.filter((message) => !message.system).map((message) => message.fromWorkId))]
      for (const sender of senders) {
        if (this.state.works[sender] === undefined || !this.isActive(this.state.works[sender])) continue
        const ids = undelivered
          .filter((message) => message.fromWorkId === sender)
          .map((message) => message.id)
          .join(', ')
        this.addSystemNoticeLocked(
          sender,
          `收件方 ${work.id} 已退出，你发送的消息 ${ids} 未被处理。你可以改投其后继，或把其中仍有价值的信息写入发现文档。`,
          [],
        )
      }
      this.bumpSharedStateLocked(`work ${work.id} 退出`)
      await this.persistLocked()
      this.journalLocked('work-retired', {
        workId: work.id,
        reason,
        undelivered: undelivered.length,
        leftoverBlockers: activityBlockers(work),
      })
      this.events.emit('all', 'work-exited', `work ${work.id} 已退出：${reason}`)
      this.drainQueue(work.id, new AppError('WORK_EXITED', `work ${work.id} 已退出`))
      return { workId: work.id, undelivered: undelivered.length, notifiedSenders: senders }
    })
    // The retire tool runs after the model stream has ended, so any permit this
    // work still holds is stale. Reclaim it now; process exit is a second net.
    this.modelSlots.releaseWork(workIdValue)
    // Let the tool result reach the executor before its process is stopped.
    const timer = setTimeout(() => {
      void this.driver.stop(workIdValue).catch(() => undefined)
    }, 1_000)
    timer.unref?.()
    for (const sender of result.notifiedSenders) this.scheduleDelivery(sender)
    this.scheduleCompletionCheck()
    return {
      ...result,
      text:
        `work ${workIdValue} 已退出，已从活跃表移除。\n` +
        `${result.undelivered === 0 ? '没有未投递的消息。' : `有 ${result.undelivered} 条未投递消息已标记为“收件方已退出”。`}\n` +
        `退出不代表任务完成；是否已达成终点仍由剩余参与 work 的共识决定。`,
    }
  }

  // -------------------------------------------------------------------------
  // Consensus interface
  // -------------------------------------------------------------------------

  /** Open a completion round (or reuse the identical open round). */
  async proposeCompletion(
    workIdValue: string,
    input: { reason?: string; refs?: unknown },
  ): Promise<{ text: string; round: RoundRecord }> {
    const reason = optionalText(input.reason, 'reason', 4_000)
    const refs = stringArray(input.refs, 'refs')
    const result = await this.mutex.run(async () => {
      const work = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      for (const ref of refs) {
        if (!/^F-\d+$/.test(ref)) throw new AppError('INVALID_ARGUMENT', `引用格式应为 F-xxxx：${ref}`)
        if (!this.state.findings.some((finding) => finding.id === ref)) {
          throw new AppError('FINDING_NOT_FOUND', `引用的发现不存在：${ref}`)
        }
      }
      const participants = this.activeIds()
      const current = this.currentOpenRound()
      if (
        current !== undefined &&
        current.targetVersion === this.state.targetVersion &&
        current.sharedStateVersion === this.state.sharedStateVersion &&
        sameSet(current.participants, participants)
      ) {
        return { round: current, reused: true }
      }
      const round = this.openRoundLocked(
        work.id,
        reason,
        reason === undefined ? `work ${work.id} 发起完成提议。` : `work ${work.id} 发起完成提议：${reason}`,
      )
      await this.persistLocked()
      this.journalLocked('completion-proposed', { roundId: round.id, workId: work.id, reason, refs })
      this.scheduleCompletionCheck()
      return { round, reused: false }
    })
    for (const participant of result.round.participants) this.scheduleDelivery(participant)
    return {
      round: result.round,
      text:
        (result.reused
          ? `当前已有相同状态下的开放轮次 ${result.round.id}。`
          : `已开启完成共识轮次 ${result.round.id}。`) +
        `\n参与 work：${result.round.participants.join(', ') || '（无）'}` +
        `\n目标版本：v${result.round.targetVersion}；共享状态版本：${result.round.sharedStateVersion}` +
        `\n请等待各 work 自行表态；运行时只在全体明确同意且无未结算动作时结束任务。`,
    }
  }

  /** Record one work's independent opinion. */
  async respondCompletion(
    workIdValue: string,
    input: { round_id: string; opinion: string; reason?: string; refs?: unknown },
  ): Promise<{ text: string; round: RoundRecord }> {
    const roundIdValue = requireText(input.round_id, 'round_id', 40)
    const opinion = input.opinion as Opinion
    if (!OPINIONS.includes(opinion)) {
      throw new AppError('INVALID_ARGUMENT', `opinion 必须是 ${OPINIONS.join(' | ')}`)
    }
    const reason = optionalText(input.reason, 'reason', 4_000)
    const refs = stringArray(input.refs, 'refs')
    const result = await this.mutex.run(async () => {
      const work = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      const round = this.currentOpenRound()
      if (round === undefined || round.id !== roundIdValue) {
        throw new AppError('ROUND_NOT_CURRENT', `轮次 ${roundIdValue} 不是当前开放轮次`)
      }
      if (!round.participants.includes(work.id)) {
        throw new AppError('NOT_PARTICIPANT', `work ${work.id} 不在轮次 ${round.id} 的参与集合中`)
      }
      for (const ref of refs) {
        if (!/^F-\d+$/.test(ref) || !this.state.findings.some((finding) => finding.id === ref)) {
          throw new AppError('FINDING_NOT_FOUND', `引用的发现不存在：${ref}`)
        }
      }
      round.opinions[work.id] = {
        opinion,
        ...(reason === undefined ? {} : { reason }),
        refs,
        at: nowIso(),
      }
      await this.persistLocked()
      this.journalLocked('completion-opinion', { roundId: round.id, workId: work.id, opinion })
      this.events.emit(round.participants, 'round-opinion', `${work.id} 在 ${round.id} 中表态：${opinion}`)
      return round
    })
    this.scheduleCompletionCheck()
    const agreed = Object.values(result.opinions).filter((item) => item.opinion === 'agree').length
    const missing = result.participants.filter((id) => result.opinions[id] === undefined)
    return {
      round: result,
      text:
        `已记录 ${workIdValue} 对 ${result.id} 的表态：${opinion}\n` +
        `同意：${agreed}/${result.participants.length}` +
        `${missing.length === 0 ? '' : `；尚未表态：${missing.join(', ')}`}\n` +
        `任务不会只因部分同意而结束。`,
    }
  }

  /** Withdraw this work's opinion; the resulting state change invalidates the round. */
  async withdrawCompletion(
    workIdValue: string,
    input: { round_id: string; reason?: string },
  ): Promise<{ text: string; newRound?: RoundRecord }> {
    const roundIdValue = requireText(input.round_id, 'round_id', 40)
    const reason = optionalText(input.reason, 'reason', 4_000) ?? '撤回自己的同意'
    const result = await this.mutex.run(async () => {
      const work = this.requireActiveWorkUnlocked(workIdValue)
      this.requireActiveTask()
      const round = this.currentOpenRound()
      if (round === undefined || round.id !== roundIdValue) {
        throw new AppError('ROUND_NOT_CURRENT', `轮次 ${roundIdValue} 不是当前开放轮次`)
      }
      if (round.opinions[work.id] === undefined) {
        throw new AppError('OPINION_NOT_FOUND', `你尚未在轮次 ${round.id} 中表态`)
      }
      delete round.opinions[work.id]
      const bumped = this.bumpSharedStateLocked(`${work.id} 撤回意见：${reason}`)
      await this.persistLocked()
      this.journalLocked('completion-withdrawn', { roundId: round.id, workId: work.id, reason })
      return { oldRound: round, newRound: bumped.reopened }
    })
    const targets = result.newRound?.participants ?? result.oldRound.participants
    for (const participant of targets) this.scheduleDelivery(participant)
    this.scheduleCompletionCheck()
    return {
      newRound: result.newRound,
      text:
        `已撤回 ${workIdValue} 在 ${result.oldRound.id} 中的表态。` +
        (result.newRound === undefined
          ? '当前没有可重新开启的轮次。'
          : `旧轮次失效，已开启新的轮次 ${result.newRound.id}，需要全体重新判断。`),
    }
  }

  /** Read the current round, opinions and every completion blocker. */
  async completionStatus(workIdValue: string): Promise<CompletionStatusResult> {
    const work = this.activeWorkOrThrow(workIdValue)
    return this.mutex.run(async () => {
      this.requireActiveWorkUnlocked(work.id)
      await this.verifyReportEntriesLocked()
      const round = this.currentOpenRound() ?? null
      const participants = this.activeIds()
      const missingVotes =
        round === null
          ? participants
          : round.participants.filter((id) => round.opinions[id] === undefined)
      const decision = this.evaluateCompletionLocked()
      const blockers = decision.ok ? [] : decision.blockers
      const blockerText =
        blockers.length === 0
          ? '- 无（若再确认一次即会提交）'
          : blockers.map((item) => `- ${item}`).join('\n')
      const text =
        (round === null
          ? `当前没有开放的共识轮次。运行轮次：${this.state.currentRunId}；参与 work：${participants.join(', ') || '（无）'}\n阻塞项：\n${blockerText}`
          : `运行轮次：${round.runId}\n${renderRound(round, this.state.works)}\n阻塞项：\n${blockerText}`) +
        `\n\n### 你的实际活动\n\n${activityLines(work).join('\n')}`
      return { round, participants, missingVotes, blockers, text }
    })
  }

  // -------------------------------------------------------------------------
  // Waiting
  // -------------------------------------------------------------------------

  /** Block until a relevant event arrives or the timeout elapses. */
  async waitForEvents(
    workIdValue: string,
    params: { timeout_seconds?: unknown; after_event_id?: unknown },
  ): Promise<WaitResult> {
    const work = this.activeWorkOrThrow(workIdValue)
    const timeoutMs = clamp(
      typeof params.timeout_seconds === 'number' ? Math.round(params.timeout_seconds) : 120,
      1,
      240,
    ) * 1_000
    const after =
      typeof params.after_event_id === 'number' && Number.isFinite(params.after_event_id)
        ? Math.round(params.after_event_id)
        : this.events.cursor

    let previousStatus: WorkRecord['runtimeStatus'] = 'idle'
    const pending = await this.mutex.run(async () => {
      const current = this.requireActiveWorkUnlocked(work.id)
      if (this.state.status !== 'active') return null
      previousStatus = current.runtimeStatus
      current.runtimeStatus = 'waiting'
      current.updatedAt = nowIso()
      await this.persistLocked()
      return pendingMessages(this.state, work.id)
    })
    if (pending === null) {
      return { text: '任务已经结束。', events: [], cursor: this.events.cursor, timedOut: false }
    }
    // `waiting` is a settled state: the executor has finished its current action
    // and is only waiting for events, so all-agree may now be committed.
    this.scheduleCompletionCheck()
    if (pending.length > 0) {
      await this.mutex.run(async () => {
        const current = this.activeWork(work.id)
        if (current !== undefined && current.runtimeStatus === 'waiting') {
          current.runtimeStatus = previousStatus === 'waiting' ? 'idle' : previousStatus
          await this.persistLocked()
        }
      })
      return {
        text: `有 ${pending.length} 条消息待接收，请调用 peer_inbox 读取。`,
        events: [],
        cursor: this.events.cursor,
        timedOut: false,
      }
    }

    const result = await this.events.wait(work.id, after, timeoutMs)
    await this.mutex.run(async () => {
      const current = this.activeWork(work.id)
      if (current !== undefined && current.runtimeStatus === 'waiting') {
        current.runtimeStatus = previousStatus === 'waiting' ? 'idle' : previousStatus
        current.updatedAt = nowIso()
        await this.persistLocked()
      }
    })
    const latest = this.events.cursor
    return {
      text:
        result.events.length === 0
          ? `等待超时（${Math.round(timeoutMs / 1000)} 秒），没有新的相关事件。`
          : `收到 ${result.events.length} 个事件：\n\n${result.events
              .map((event) => `- [${event.seq}] ${event.at} ${event.kind}：${event.text}`)
              .join('\n')}\n\n游标：${latest}`,
      events: result.events,
      cursor: latest,
      timedOut: result.timedOut,
    }
  }

  // -------------------------------------------------------------------------
  // Human administration
  // -------------------------------------------------------------------------

  /** Change the user's end information and invalidate previous agreement. */
  async setEndInformation(textValue: string): Promise<{ text: string; targetVersion: number }> {
    const text = requireText(textValue, 'end_information', MAX_TEXT)
    return this.mutex.run(async () => {
      this.requireActiveTask()
      const version = ++this.state.targetVersion
      const at = nowIso()
      this.state.endInformation = text
      this.state.endHistory.push({ version, at, text })
      this.bumpSharedStateLocked(`用户修改终点信息至 v${version}`)
      for (const participant of this.activeIds()) {
        this.addSystemNoticeLocked(
          participant,
          `用户修改了终点信息（目标版本 v${version}）。旧版本的完成意见已失效，请按新版本重新判断。\n\n${text}`,
          [],
        )
      }
      await this.persistLocked()
      this.journalLocked('end-information-changed', { targetVersion: version })
      this.events.emit('all', 'task-updated', `终点信息更新为 v${version}`)
      return {
        text: `终点信息已更新为 v${version}；已通知 ${this.activeIds().length} 个参与 work，旧版同意失效。`,
        targetVersion: version,
      }
    })
  }

  /** Change the user's start information (also invalidates rounds). */
  async setStartInformation(textValue: string): Promise<{ text: string; version: number }> {
    const text = requireText(textValue, 'start_information', MAX_TEXT)
    return this.mutex.run(async () => {
      this.requireActiveTask()
      const version = (this.state.startHistory.at(-1)?.version ?? 0) + 1
      const at = nowIso()
      this.state.startInformation = text
      this.state.startHistory.push({ version, at, text })
      this.bumpSharedStateLocked(`用户修改起始信息至 v${version}`)
      for (const participant of this.activeIds()) {
        this.addSystemNoticeLocked(
          participant,
          `用户修改了起始信息（v${version}），共享状态已变化。请按最新信息重新判断当前方向。\n\n${text}`,
          [],
        )
      }
      await this.persistLocked()
      this.journalLocked('start-information-changed', { version })
      this.events.emit('all', 'task-updated', `起始信息更新为 v${version}`)
      return { text: `起始信息已更新为 v${version}。`, version }
    })
  }

  /** Explicitly stop the task. This never records completion. */
  async stopTask(reason = '用户手动停止'): Promise<{ text: string }> {
    await this.mutex.run(async () => {
      await this.stopTaskLocked(reason)
    })
    return { text: `任务已停止：${reason}` }
  }

  /** Summary used by the human-facing status command. */
  async adminSnapshot(): Promise<{
    text: string
    task: RuntimeState
    participants: string[]
    blockers: string[]
  }> {
    return this.mutex.run(async () => {
      await this.verifyReportEntriesLocked()
      const decision = this.evaluateCompletionLocked()
      const blockers = decision.ok ? [] : decision.blockers
      const participants = this.activeIds()
      const active = this.activeWorks()
      const round = this.currentOpenRound() ?? null
      const lines = [
        `任务 ${this.state.taskId}: ${this.state.status}`,
        this.state.statusReason === undefined ? '' : `说明：${this.state.statusReason}`,
        `运行轮次：${this.state.currentRunId}（累计 ${this.state.runs.length} 轮）`,
        ...this.state.runs
          .filter((run) => run.id !== this.state.currentRunId)
          .map((run) => {
            const ending =
              run.status === 'completed'
                ? `completed${run.completion === null ? '' : `（${run.completion.roundId}）`}`
                : run.status === 'stopped'
                  ? `stopped${run.stopReason === undefined ? '' : `（${run.stopReason}）`}`
                  : run.status
            return `- 历史 ${run.id}：${ending}；work：${run.workIds.join(', ') || '（无）'}`
          }),
        `目标版本：v${this.state.targetVersion}；共享状态版本：${this.state.sharedStateVersion}`,
        `参与 work：${participants.length === 0 ? '（无）' : participants.join(', ')}`,
        `发现：${this.state.findings.length} 条；消息：${this.state.messages.length} 条；共识轮次：${this.state.rounds.length}`,
        `用户命令：${this.state.commands.length} 条`,
        ...this.state.commands.map(
          (command) =>
            `- ${command.id} · ${command.createdAt} · ${command.source}：${tableCell(command.text, 80)}` +
            `\n  投递：${
              Object.values(command.deliveries)
                .map((delivery) => `${delivery.workId}=${COMMAND_DELIVERY_STATUS_TEXT[delivery.status]}`)
                .join('；') || '（无收件 work）'
            }`,
        ),
        this.state.interruptedAt === undefined ? '' : `上次中断：${this.state.interruptedAt}`,
        '',
        '| work | 运行状态 | 当前工作 | 自述状态 | 最近更新 |',
        '| --- | --- | --- | --- | --- |',
        ...active.map(
          (work) =>
            `| ${work.id} | ${work.runtimeStatus} | ${tableCell(work.direction, 60)} | ${tableCell(work.selfStatus, 30)} | ${work.updatedAt} |`,
        ),
        '',
        ...active.flatMap((work) => [`### ${work.id} 实际活动`, '', ...activityLines(work), '']),
        round === null ? '当前没有开放的共识轮次。' : renderRound(round, this.state.works),
        `阻塞项：${blockers.length === 0 ? '（无）' : blockers.join('；')}`,
      ]
      return {
        text: lines.filter((line) => line !== '').join('\n'),
        task: this.state,
        participants,
        blockers,
      }
    })
  }

  /** Read-only message dump for humans debugging delivery. */
  async listMessages(): Promise<MessageRecord[]> {
    return this.mutex.run(async () => [...this.state.messages])
  }
}
