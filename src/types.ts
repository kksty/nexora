/**
 * Domain vocabulary for the first version of the fission-executor system.
 *
 * The runtime understands lifecycle and consistency, not domain content. These
 * types therefore record identity, state and protocol facts only; finding
 * bodies, work directions and message bodies are opaque natural language.
 */

export type TaskStatus = 'active' | 'completed' | 'stopped'

/**
 * Runtime-owned work status.
 *
 * - `starting`  the harness session is being created
 * - `running`   the executor's current turn is in progress
 * - `idle`      the turn ended and the work awaits input
 * - `waiting`   the executor is blocked in `executor.wait`
 * - `retrying`  a model/session request failed and a retry is scheduled
 * - `exited`    the executor retired itself
 * - `finished`  the task completed and the executor was stopped
 */
export type WorkRuntimeStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'waiting'
  | 'retrying'
  | 'exited'
  | 'finished'

export type Opinion = 'agree' | 'disagree' | 'unsure'

export const OPINIONS: readonly Opinion[] = ['agree', 'disagree', 'unsure']

export type MessageKind = 'hint' | 'request' | 'reply' | 'handoff' | 'notice'

export const MESSAGE_KINDS: readonly MessageKind[] = ['hint', 'request', 'reply', 'handoff', 'notice']

export type MessageStatus = 'pending' | 'delivered' | 'read' | 'recipient-exited'

export type RoundStatus = 'open' | 'completed' | 'invalidated'

/** One version of the user's start or end information. */
export interface VersionRecord {
  version: number
  at: string
  text: string
}

/** A reusable piece of shared knowledge, authored by one work. */
export interface FindingRecord {
  id: string
  authorWorkId: string
  createdAt: string
  /** Natural-language body supplied by the executor. */
  text: string
  /** Optional executor-supplied label such as 待验证假设 / 失败尝试 / 未承接方向. */
  type?: string
  refs: string[]
  /** Task-relative evidence paths, for example `evidence/result-18.txt`. */
  evidence: string[]
  /** Finding IDs this record corrects or replaces. */
  supersedes: string[]
  relatedWork: string[]
}

/** One asynchronous message between two works. */
export interface MessageRecord {
  id: string
  fromWorkId: string
  toWorkId: string
  kind: MessageKind
  body: string
  refs: string[]
  createdAt: string
  status: MessageStatus
  /** True for runtime-generated notices (rounds, task changes, exit reports). */
  system: boolean
  deliveredAt?: string
  readAt?: string
  note?: string
}

/** One work's stance inside one completion round. */
export interface OpinionRecord {
  opinion: Opinion
  /** Optional: omitting a reason never blocks completion. */
  reason?: string
  refs: string[]
  at: string
}

/** One round of "is the end state reached?" consensus. */
export interface RoundRecord {
  id: string
  /** Run this round belongs to; rounds never span runs. */
  runId: string
  createdAt: string
  createdByWorkId: string
  /** Optional proposal note; the runtime does not judge its quality. */
  reason?: string
  targetVersion: number
  sharedStateVersion: number
  participants: string[]
  opinions: Record<string, OpinionRecord>
  status: RoundStatus
  invalidatedAt?: string
  invalidatedReason?: string
  completedAt?: string
  supersededBy?: string
}

/** How a work was created; used to build its startup prompt and UI labels. */
export type WorkOrigin = 'initial' | 'spawn' | 'continue' | 'recover'

/**
 * One uninterrupted execution of one task.
 *
 * A task keeps its identity and shared material across runs. Completion,
 * participant sets and consensus are run-scoped: ending a run never rewrites
 * it, and a continued run starts with a new work, an empty opinion set and the
 * same task-level findings, reports and effective commands.
 */
export interface RunRecord {
  id: string
  sequence: number
  createdAt: string
  /** Set when the runtime first established this run's work (non-offline). */
  startedAt?: string
  endedAt?: string
  status: TaskStatus
  statusReason?: string
  /** Target version at run creation; a new run keeps it unless the user changes it. */
  targetVersion: number
  workIds: string[]
  roundIds: string[]
  commandIds: string[]
  /** Final completion record; only a completed run has one. */
  completion: CompletionRecord | null
  stopReason?: string
  /** Request id of the human continue operation that created this run. */
  continueRequestId?: string
  /** The human instruction that started this run (continue only). */
  continueText?: string
  /**
   * Request id of a restart that reopened the task without a human command.
   * Such a run has no command record: the executor resumes from shared state.
   */
  resumeRequestId?: string
  /** Idempotent manual recovery operations performed inside this run. */
  recoveries: { requestId: string; workId: string; at: string }[]
  /**
   * Managed-execution cleanup after the run reached a terminal status.
   * A pending cleanup is finished before a new run may start.
   */
  cleanup: 'none' | 'pending' | 'done'
  cleanupAt?: string
  cleanupNote?: string
}

/** The last recorded request failure and its retry bookkeeping. */
export interface WorkErrorRecord {
  message: string
  at: string
  attempts: number
  nextRetryAt?: string
  /** Short classification such as `request`, `process-exit` or `session-resume`. */
  kind?: string
}

/** A foreground tool invocation whose result has not returned yet. */
export interface ToolActivityRecord {
  callId: string
  name: string
  turn: number
  step: number
  startedAt: string
  /** Session-log sequence number of the `tool/call` event. */
  eventSeq: number
  /**
   * True for tools that represent real exploration work. Runtime protocol
   * calls and read-only job queries do not block completion.
   */
  blocking: boolean
  /** Raw arguments, retained for correlating job_output/job_kill with a job. */
  arguments?: string
  /** True when a restart left this call without a known result. */
  orphaned?: boolean
  reconciledAt?: string
  reconciledNote?: string
}

export type JobActivityStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed' | 'unknown'

/**
 * A harness background job projected from `job/registered` / `job/settled`
 * session events. Settled jobs only block completion while their result has
 * not been handed to the owning model.
 */
export interface JobActivityRecord {
  jobId: string
  kind: string
  label: string
  ownerSessionId: string
  startedAt: string
  registeredSeq: number
  toolCallId?: string
  rootToolCallId?: string
  status: JobActivityStatus
  settledAt?: string
  settledSeq?: number
  cause?: string
  detail?: string
  producerReported?: boolean
  /** `pending` means the settlement notice has not entered the model context. */
  notice: 'none' | 'pending' | 'delivered'
  noticeAt?: string
  reconciledAt?: string
  reconciledNote?: string
}

/**
 * Runtime projection of what one harness process is actually doing. It is
 * persisted so a restart can report unknown actions instead of silently
 * treating the work as idle.
 */
export interface WorkActivity {
  /** Harness process generation; events from an older generation are ignored. */
  generation: number
  /** Last observed whole-agent status. */
  sessionStatus: 'idle' | 'running'
  /** Highest session-log sequence number consumed by this projection. */
  lastEventSeq: number
  lastEventAt?: string
  updatedAt: string
  tools: Record<string, ToolActivityRecord>
  jobs: Record<string, JobActivityRecord>
  /** Prompt/notice message ids observed entering the model context (bounded). */
  inboundMessages: Record<string, { at: string; sourceKind?: string; form?: string }>
}

/** One executor working inside the task. */
export interface WorkRecord {
  id: string
  /** Run this work belongs to; only the current run's works participate. */
  runId: string
  /** Creation context, used for the startup prompt and the UI. */
  origin: WorkOrigin
  sessionId: string
  /** The work that spawned this one; source only, never authority. */
  parentWorkId: string | null
  spawnReason?: string
  startPrompt?: string
  spawnRefs?: string[]
  /** Client-supplied stable ID of the fission request, for idempotent retries. */
  spawnRequestId?: string
  createdAt: string
  updatedAt: string
  /** Agent-maintained direction shown in `works.md`. */
  direction: string
  /** Agent-maintained self description shown in `works.md`. */
  selfStatus: string
  runtimeStatus: WorkRuntimeStatus
  /** True once the first prompt was durably enqueued in this session. */
  sessionStarted: boolean
  /** Harness receipt id of the most recent prompt (enqueue only, not context entry). */
  lastPromptMessageId?: string
  /** Actual tools/jobs/status projected from the harness session. */
  activity: WorkActivity
  /** True when the original session could not be resumed and a fresh one was created. */
  recoveredFresh?: boolean
  exitReason?: string
  exitAt?: string
  lastError?: WorkErrorRecord
}

/**
 * Delivery state of one human command to one work.
 *
 * `saved` means the command and its recipients were committed; `enqueued` means
 * the harness returned a durable admission receipt; `entered-context` means the
 * corresponding `user/message` event was observed in the session log. Only the
 * last state proves the model could read the command; none of them proves the
 * request was carried out.
 */
export type CommandDeliveryStatus = 'saved' | 'enqueued' | 'entered-context' | 'recipient-exited'

export const COMMAND_DELIVERY_STATUS_TEXT: Record<CommandDeliveryStatus, string> = {
  saved: '已保存，等待投递',
  enqueued: '已入 harness 队列',
  'entered-context': '已进入模型上下文',
  'recipient-exited': '收件 work 已退出',
}

/** Short-lived claim that lets one harness process steer one command. */
export interface CommandDeliveryClaim {
  token: string
  at: string
}

/** One recipient's delivery bookkeeping for a human command. */
export interface CommandDeliveryRecord {
  workId: string
  status: CommandDeliveryStatus
  savedAt: string
  /** Number of steering attempts; duplicated delivery is at-least-once. */
  attempts: number
  claim?: CommandDeliveryClaim
  /** Harness `user/message` id reported by the steering plugin. */
  harnessMessageId?: string
  enqueuedAt?: string
  enteredContextAt?: string
  note?: string
}

/**
 * A task-level natural-language instruction from the human. The runtime stores
 * the raw text, source, order and per-work delivery facts; it never interprets
 * the instruction or treats delivery as completion of the request.
 */
export interface CommandRecord {
  id: string
  /** Run that issued the command; older commands stay effective across runs. */
  runId: string
  /** Client-supplied stable id used for idempotent retries. */
  requestId: string
  sequence: number
  text: string
  source: 'web' | 'cli' | 'api'
  createdAt: string
  deliveries: Record<string, CommandDeliveryRecord>
}

/** How the fixed report entry currently relates to the committed revision. */
export type ReportEntryState = 'synced' | 'pending' | 'drift'

/**
 * One report identity and its current published revision.
 *
 * `contentFile` is an immutable copy under `runtime/reports/`; the fixed
 * `path` is a derived entry that must always match `contentHash` for the task
 * to be completable. A logical publish is committed to `state.json` first and
 * the entry is materialized afterwards, so `entryState = pending` is a
 * recoverable intermediate state rather than a second source of truth.
 */
export interface ReportRecord {
  /** Stable report identity, for example `report` or `pentest`. */
  key: string
  /** Fixed task-relative entry path, for example `report.md`. */
  path: string
  revision: number
  /** sha256 (hex) of the exact published content bytes. */
  contentHash: string
  /** Task-relative immutable content location under `runtime/reports/`. */
  contentFile: string
  size: number
  publishedByWorkId: string
  publishedAt: string
  /** Request id of the publish that produced this revision. */
  requestId: string
  entryState: ReportEntryState
  entrySyncedAt?: string
  driftDetectedAt?: string
  driftNote?: string
}

/** Idempotent result of one report publish request. */
export interface ReportPublishRecord {
  key: string
  revision: number
  contentHash: string
  contentFile: string
  path: string
  at: string
  /** Fingerprint of the request parameters; a different body is a conflict. */
  paramsHash: string
}

/** The immutable record written when the task completes. */
export interface CompletionRecord {
  runId: string
  roundId: string
  completedAt: string
  targetVersion: number
  sharedStateVersion: number
  participants: string[]
  opinions: Record<string, OpinionRecord>
  findingsCount: number
  messagesCount: number
}

export interface Counters {
  run: number
  work: number
  finding: number
  message: number
  round: number
  command: number
}

/**
 * The runtime's authoritative task state.
 *
 * `findings.md` and `works.md` are rendered views of this state; the JSON file
 * is what makes recovery deterministic. Historical sessions, full message
 * history and spawn lineage live here for recovery, but the default agent
 * queries only expose currently relevant information.
 */
export interface RuntimeState {
  /** 1 = first version, 2 = activity projection, 3 = human commands, 4 = current findings and reports, 5 = runs. */
  schemaVersion: 1 | 2 | 3 | 4 | 5
  taskId: string
  createdAt: string
  updatedAt: string
  status: TaskStatus
  statusReason?: string
  startInformation: string
  endInformation: string
  targetVersion: number
  startHistory: VersionRecord[]
  endHistory: VersionRecord[]
  /** Bumped by every event that invalidates a round (see docs/ARCHITECTURE.md). */
  sharedStateVersion: number
  counters: Counters
  /** Execution runs in order; a completed/stopped task may be continued. */
  runs: RunRecord[]
  /** Run whose works take part in the current task status; never changes half-way. */
  currentRunId: string
  works: Record<string, WorkRecord>
  findings: FindingRecord[]
  messages: MessageRecord[]
  rounds: RoundRecord[]
  /** Task-level human instructions; every current work has a delivery record. */
  commands: CommandRecord[]
  /** Current published report per key; the fixed entry is a derived output. */
  reports: Record<string, ReportRecord>
  /** Idempotent publish results keyed by client request id. */
  reportPublishes: Record<string, ReportPublishRecord>
  /** Durable findings/message receipts, scoped by author + operation + request ID. */
  workRequests: Record<string, { fingerprint: string; result: unknown }>
  currentRoundId: string | null
  /** Completion of the current/last run; a continued active run starts null. */
  completion: CompletionRecord | null
  /** True once the first executor has been created; keeps an empty table from rebooting. */
  bootstrapped: boolean
  interruptedAt?: string
}

/**
 * Normalized harness activity event. The SDK driver converts raw
 * `session.event` / `session.status` notifications into this shape so the
 * runtime does not depend on harness wire details.
 */
export type ActivityEvent =
  | { kind: 'status'; sessionId: string; generation: number; at: string; status: 'idle' | 'running' }
  | {
      kind: 'terminal-snapshot'
      sessionId: string
      generation: number
      sourceGeneration?: number
      seq: number
      at: string
      terminals: { id: string; label: string }[]
    }
  | {
      kind: 'turn-start' | 'turn-end'
      sessionId: string
      generation: number
      seq: number
      at: string
      turn: number
      detail?: string
    }
  | {
      kind: 'step-start' | 'step-end'
      sessionId: string
      generation: number
      seq: number
      at: string
      turn: number
      step: number
    }
  | {
      kind: 'tool-call'
      sessionId: string
      generation: number
      seq: number
      at: string
      callId: string
      name: string
      arguments?: string
      turn: number
      step: number
    }
  | {
      kind: 'tool-result'
      sessionId: string
      generation: number
      seq: number
      at: string
      callId: string
      isError: boolean
    }
  | {
      kind: 'job-registered'
      sessionId: string
      generation: number
      seq: number
      at: string
      jobId: string
      jobKind: string
      label: string
      ownerSessionId: string
      startedAt: string
      toolCallId?: string
      rootToolCallId?: string
    }
  | {
      kind: 'job-settled'
      sessionId: string
      generation: number
      seq: number
      at: string
      jobId: string
      jobKind: string
      label: string
      ownerSessionId: string
      startedAt: string
      toolCallId?: string
      rootToolCallId?: string
      status: 'completed' | 'killed' | 'failed'
      cause: string
      producerReported: boolean
      detail?: string
      finishedAt: string
    }
  | {
      kind: 'user-message'
      sessionId: string
      generation: number
      seq: number
      at: string
      messageId: string
      sourceKind?: string
      form?: string
      text?: string
    }

/** One event delivered to `executor.wait`. */
export interface WorkEvent {
  seq: number
  at: string
  kind: string
  text: string
}
