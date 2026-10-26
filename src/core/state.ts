/**
 * Creation, loading and persistence of the authoritative runtime state.
 *
 * The JSON file is written atomically after every mutation. The Markdown views
 * are regenerated (works/task) or repaired (findings) from this state, which is
 * what makes a daemon restart deterministic.
 */

import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readTextIfExists, writeFileAtomic } from '../util/atomic.ts'
import { AppError } from '../util/errors.ts'
import { runId } from '../util/ids.ts'
import { nowIso } from '../util/time.ts'
import type { RunRecord, RuntimeState, WorkActivity, WorkRecord } from '../types.ts'
import { emptyActivity } from './activity.ts'
import type { TaskPaths } from './paths.ts'

/** Current authoritative-state schema. Older versions are migrated on load. */
export const CURRENT_SCHEMA_VERSION = 5

/** Build one empty run record. */
export function createRunRecord(input: {
  sequence: number
  at?: string
  targetVersion: number
  status?: RunRecord['status']
  continueRequestId?: string
  continueText?: string
  resumeRequestId?: string
}): RunRecord {
  const at = input.at ?? nowIso()
  const status = input.status ?? 'active'
  return {
    id: runId(input.sequence),
    sequence: input.sequence,
    createdAt: at,
    ...(status === 'active' ? {} : { endedAt: at }),
    status,
    targetVersion: input.targetVersion,
    workIds: [],
    roundIds: [],
    commandIds: [],
    completion: null,
    ...(input.continueRequestId === undefined ? {} : { continueRequestId: input.continueRequestId }),
    ...(input.continueText === undefined ? {} : { continueText: input.continueText }),
    ...(input.resumeRequestId === undefined ? {} : { resumeRequestId: input.resumeRequestId }),
    recoveries: [],
    cleanup: status === 'active' ? 'none' : 'pending',
  }
}

/** Build the initial state for a brand-new task. */
export function createInitialState(input: {
  taskId: string
  startInformation: string
  endInformation: string
  at?: string
}): RuntimeState {
  const startInformation = input.startInformation.trim()
  const endInformation = input.endInformation.trim()
  if (startInformation.length === 0) throw new AppError('INVALID_ARGUMENT', '起始信息不能为空')
  if (endInformation.length === 0) throw new AppError('INVALID_ARGUMENT', '终点信息不能为空')
  const at = input.at ?? nowIso()
  const firstRun = createRunRecord({ sequence: 1, at, targetVersion: 1 })
  return {
    schemaVersion: 5,
    taskId: input.taskId,
    createdAt: at,
    updatedAt: at,
    status: 'active',
    startInformation,
    endInformation,
    targetVersion: 1,
    startHistory: [{ version: 1, at, text: startInformation }],
    endHistory: [{ version: 1, at, text: endInformation }],
    sharedStateVersion: 1,
    counters: { run: 1, work: 0, finding: 0, message: 0, round: 0, command: 0 },
    runs: [firstRun],
    currentRunId: firstRun.id,
    works: {},
    findings: [],
    messages: [],
    rounds: [],
    commands: [],
    reports: {},
    reportPublishes: {},
    workRequests: {},
    currentRoundId: null,
    completion: null,
    bootstrapped: false,
  }
}

/** Serialize state with a trailing newline (the on-disk format). */
export function serializeState(state: RuntimeState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

/** Atomically persist the state document. */
export async function saveState(paths: TaskPaths, state: RuntimeState): Promise<number> {
  state.updatedAt = nowIso()
  const serialized = serializeState(state)
  await writeFileAtomic(paths.stateFile, serialized)
  return Buffer.byteLength(serialized)
}

/**
 * Normalize additive fields introduced after the first version. The first
 * version had no activity projection; its works start empty and are marked
 * unknown by recovery when an old process is gone.
 */
function normalizeActivity(activity: WorkActivity): void {
  activity.generation ??= 0
  activity.sessionStatus = activity.sessionStatus === 'running' ? 'running' : 'idle'
  activity.lastEventSeq ??= 0
  activity.tools ??= {}
  activity.jobs ??= {}
  activity.inboundMessages ??= {}
  activity.updatedAt ??= nowIso()
  for (const tool of Object.values(activity.tools)) {
    tool.blocking ??= tool.name.startsWith('mcp__liebian__') ? false : true
  }
  for (const job of Object.values(activity.jobs)) {
    job.notice ??= job.status === 'running' || job.status === 'stopping' ? 'none' : 'pending'
  }
}

function normalizeState(state: RuntimeState): void {
  state.commands ??= []
  state.reports ??= {}
  state.reportPublishes ??= {}
  state.workRequests ??= {}
  state.counters.command ??= 0
  for (const report of Object.values(state.reports)) {
    if (report.entryState !== 'synced' && report.entryState !== 'pending' && report.entryState !== 'drift') {
      report.entryState = 'synced'
    }
    report.size ??= 0
  }
  for (const command of state.commands) {
    command.deliveries ??= {}
    // Never re-issue an ID that already exists, even if a hand-edited or
    // partially migrated document had a stale counter.
    state.counters.command = Math.max(state.counters.command, command.sequence ?? 0)
    for (const delivery of Object.values(command.deliveries)) {
      delivery.attempts ??= 0
      delivery.savedAt ??= command.createdAt
    }
  }
  for (const work of Object.values(state.works)) {
    const candidate = work as WorkRecord & { activity?: WorkActivity }
    if (candidate.activity === undefined || candidate.activity === null) {
      candidate.activity = emptyActivity()
    } else {
      normalizeActivity(candidate.activity)
    }
  }
}

/**
 * Normalize the run fields of a v5 document. Missing values are only filled
 * for additive fields; a document whose current run or run membership is
 * inconsistent is rejected instead of being silently "repaired" into a state
 * that would let an old vote or work influence a new run.
 */
function normalizeRuns(state: RuntimeState): void {
  state.runs ??= []
  state.counters.run ??= 0
  if (state.runs.length === 0) {
    throw new AppError('STATE_CORRUPT', '状态缺少运行轮次记录')
  }
  const firstRun = state.runs[0]!
  for (const run of state.runs) {
    run.workIds ??= []
    run.roundIds ??= []
    run.commandIds ??= []
    run.recoveries ??= []
    run.completion ??= null
    // v5 always scopes a completion record to its run; a hand-edited or
    // partially migrated document may lack the additive field.
    if (run.completion !== null && typeof run.completion.runId !== 'string') {
      run.completion.runId = run.id
    }
    if (run.cleanup !== 'none' && run.cleanup !== 'pending' && run.cleanup !== 'done') {
      run.cleanup = run.status === 'active' ? 'none' : 'pending'
    }
    state.counters.run = Math.max(state.counters.run, run.sequence ?? 0)
  }
  state.currentRunId ??= firstRun.id
  const current = state.runs.find((run) => run.id === state.currentRunId)
  if (current === undefined) {
    throw new AppError('STATE_CORRUPT', `当前运行轮次不存在：${String(state.currentRunId)}`)
  }
  if (state.status === 'active' && current.status !== 'active') {
    throw new AppError('STATE_CORRUPT', `任务为 active，但当前轮次 ${current.id} 为 ${current.status}`)
  }
  if (state.status !== 'active' && current.status !== state.status) {
    throw new AppError(
      'STATE_CORRUPT',
      `任务为 ${state.status}，但当前轮次 ${current.id} 为 ${current.status}`,
    )
  }
  for (const work of Object.values(state.works)) {
    work.runId ??= firstRun.id
    work.origin ??= work.parentWorkId === null ? 'initial' : 'spawn'
    if (!state.runs.some((run) => run.id === work.runId)) {
      throw new AppError('STATE_CORRUPT', `work ${work.id} 引用了不存在的运行轮次：${String(work.runId)}`)
    }
  }
  for (const round of state.rounds) {
    round.runId ??= firstRun.id
    if (!state.runs.some((run) => run.id === round.runId)) {
      throw new AppError('STATE_CORRUPT', `共识轮次 ${round.id} 引用了不存在的运行轮次：${String(round.runId)}`)
    }
  }
  for (const command of state.commands) {
    command.runId ??= firstRun.id
  }
}

/**
 * Upgrade a document written by an older schema.
 *
 * v1 → v5: no activity projection and no runs; all historical works become
 * run R-0001, their IDs and terminal records unchanged.
 * v2 → v5: commands already exist; the command counter is fixed by
 * `normalizeState`.
 * v3 → v5: reports were introduced; missing registries stay empty and the
 * first explicit publish registers a report.
 * v4 → v5: wraps the existing single-run task into R-0001. A terminal task
 * gets `cleanup: pending` so a later runtime start only finishes cleanup; it
 * never re-enters exploration.
 */
function migrateToCurrent(state: RuntimeState): void {
  if (state.runs !== undefined && state.runs.length > 0) {
    normalizeRuns(state)
    return
  }
  const at = state.completion?.completedAt ?? state.updatedAt ?? nowIso()
  const status = state.status
  const run = createRunRecord({
    sequence: 1,
    at: state.createdAt ?? at,
    targetVersion: state.targetVersion,
    status,
  })
  run.workIds = Object.keys(state.works).sort()
  run.roundIds = state.rounds.map((round) => round.id)
  run.commandIds = (state.commands ?? []).map((command) => command.id)
  run.completion = state.completion ?? null
  if (run.completion !== null && typeof run.completion.runId !== 'string') {
    run.completion.runId = run.id
  }
  if (status === 'completed') {
    run.endedAt = state.completion?.completedAt ?? at
    run.statusReason = state.statusReason
    run.cleanup = 'pending'
  } else if (status === 'stopped') {
    run.endedAt = at
    run.stopReason = state.statusReason
    run.cleanup = 'pending'
  }
  for (const work of Object.values(state.works)) {
    work.runId = run.id
    if (work.origin === undefined) work.origin = work.parentWorkId === null ? 'initial' : 'spawn'
  }
  for (const round of state.rounds) round.runId = run.id
  for (const command of state.commands ?? []) command.runId = run.id
  state.runs = [run]
  state.currentRunId = run.id
  state.counters.run = 1
}

/**
 * Explicit schema upgrade: keep a recoverable copy of the previous document,
 * normalize the fields added since, then write the current version. Old
 * programs must not silently write a newer document, so only known versions
 * are accepted.
 */
async function migrateState(paths: TaskPaths, state: RuntimeState): Promise<void> {
  const from = state.schemaVersion
  if (from === CURRENT_SCHEMA_VERSION) {
    normalizeRuns(state)
    return
  }
  const backup = join(paths.runtimeDir, `state.v${from}.backup.json`)
  if (from === 1) {
    // Version 1 had no activity projection; its works are normalized empty and
    // recovery marks old processes unknown.
    state.counters.round ??= 0
  }
  if (from <= 3) {
    // Versions before 4 had no report registry. Existing Markdown files are not
    // guessed into a report; the first explicit publish registers one.
    normalizeState(state)
  }
  if (from <= 4) {
    migrateToCurrent(state)
  }
  try {
    await copyFile(paths.stateFile, backup)
  } catch (error) {
    throw new AppError('STATE_MIGRATION_FAILED', `无法在升级前保留 ${backup}：${String(error)}`)
  }
  state.schemaVersion = CURRENT_SCHEMA_VERSION
  await saveState(paths, state)
}

/** Read, migrate and minimally validate the state document. */
export async function loadState(paths: TaskPaths): Promise<RuntimeState> {
  const raw = await readTextIfExists(paths.stateFile)
  if (raw === null) throw new AppError('TASK_NOT_FOUND', `任务状态不存在：${paths.stateFile}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppError('STATE_CORRUPT', `无法解析任务状态：${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new AppError('STATE_CORRUPT', '任务状态不是对象')
  const state = parsed as RuntimeState
  if (
    state.schemaVersion !== 1 &&
    state.schemaVersion !== 2 &&
    state.schemaVersion !== 3 &&
    state.schemaVersion !== 4 &&
    state.schemaVersion !== CURRENT_SCHEMA_VERSION
  ) {
    throw new AppError('STATE_CORRUPT', `不支持的状态版本：${String(state.schemaVersion)}`)
  }
  if (state.taskId !== paths.taskId) {
    throw new AppError('STATE_CORRUPT', `任务 ID 不匹配：状态为 ${state.taskId}，目录为 ${paths.taskId}`)
  }
  if (state.status !== 'active' && state.status !== 'completed' && state.status !== 'stopped') {
    throw new AppError('STATE_CORRUPT', `未知任务状态：${String(state.status)}`)
  }
  // A missing collection must fail as corrupt state, not as a TypeError deep
  // inside the engine after startup began.
  if (typeof state.counters !== 'object' || state.counters === null || Array.isArray(state.counters)) {
    throw new AppError('STATE_CORRUPT', '状态缺少 counters 对象')
  }
  if (typeof state.works !== 'object' || state.works === null || Array.isArray(state.works)) {
    throw new AppError('STATE_CORRUPT', '状态的 works 必须是对象')
  }
  for (const field of ['findings', 'messages', 'rounds'] as const) {
    if (!Array.isArray(state[field])) {
      throw new AppError('STATE_CORRUPT', `状态的 ${field} 必须是数组`)
    }
  }
  normalizeState(state)
  await migrateState(paths, state)
  return state
}
