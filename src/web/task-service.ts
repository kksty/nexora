/**
 * Read and control tasks for the human Web UI.
 *
 * The Web UI is an observation and administration surface, never an executor:
 * it reads the authoritative `state.json`, talks to a running daemon through its
 * loopback admin API when one is alive, and otherwise performs the same offline
 * edits as the CLI. Agents never use this module.
 */

import { open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callDaemon, daemonAlive, readDaemonInfo, type DaemonInfo } from '../core/daemon.ts'
import { Engine } from '../core/engine.ts'
import { acquireTaskOwnership, releaseTaskOwnership, deleteOwnedTask } from '../core/ownership.ts'
import { makeTaskPaths, type TaskPaths } from '../core/paths.ts'
import { loadState } from '../core/state.ts'
import { assertTaskDoesNotExist, createTask } from '../core/task.ts'
import type { HarnessDriver } from '../harness/driver.ts'
import { renderHarnessPatch } from '../harness/patch.ts'
import type { RuntimeState, TaskStatus } from '../types.ts'
import { writeFileAtomic } from '../util/atomic.ts'
import { AppError, describeError } from '../util/errors.ts'
import { isValidTaskId, newTaskId } from '../util/ids.ts'
import { createLogger, type Logger } from '../util/log.ts'
import { nowIso } from '../util/time.ts'
import {
  composeWebMode,
  dockerTaskRunning,
  removeDockerTaskContainer,
  sendDockerTaskCommand,
  setDockerTaskInformation,
  startDockerTask,
  stopDockerTask,
  stopDockerTaskContainer,
} from './docker-launcher.ts'

const MCP_ENTRY = fileURLToPath(new URL('../mcp/main.ts', import.meta.url))
const MAX_FILE_BYTES = 512 * 1024
const MAX_LISTED_FILES = 1_000

export interface TaskSummary {
  taskId: string
  status: TaskStatus
  statusReason?: string
  createdAt: string
  updatedAt: string
  targetVersion: number
  sharedStateVersion: number
  participants: string[]
  activeWorkCount: number
  workCount: number
  findingCount: number
  messageCount: number
  roundCount: number
  commandCount: number
  currentRoundId: string | null
  completionRoundId: string | null
  /** Current execution run and how many runs the task has had. */
  runId: string
  runCount: number
  reports: {
    key: string
    path: string
    revision: number
    publishedByWorkId: string
    publishedAt: string
    entryState: string
  }[]
  interruptedAt?: string
  online: boolean
  startPreview: string
  endPreview: string
}

export interface FileEntry {
  path: string
  name: string
  group: 'doc' | 'audit' | 'evidence' | 'consensus' | 'log' | 'config'
  size: number
  mtime: string
}

export interface TaskRuntime {
  online: boolean
  /** True when the task's Docker container is alive even if its loopback admin API is unreachable. */
  containerRunning: boolean
  pid: number | null
  startedAt: string | null
  url: string | null
  blockers: string[] | null
  participants: string[] | null
  error: string | null
}

export interface TaskDetail {
  summary: TaskSummary
  state: RuntimeState
  runtime: TaskRuntime
  files: FileEntry[]
  logs: { daemon: string; run: string }
  now: string
}

export interface FileView {
  path: string
  size: number
  mtime: string
  text: string
  truncated: boolean
}

export interface CreateTaskInput {
  start: string
  end: string
  id?: string
}

export interface ActionResult {
  text: string
  online: boolean
}

export interface StartRunResult {
  pid: number
}

export interface StartRunOptions {
  tasksRoot: string
  taskId: string
  logger?: Logger
}

const healthCache = new Map<string, { at: number; alive: boolean }>()
const containerCache = new Map<string, { at: number; running: boolean }>()
const startGuard = new Map<string, number>()
const CONTAINER_CACHE_MS = 4_000

/** Health-check a daemon, caching the result briefly so task lists stay cheap. */
async function daemonOnline(info: DaemonInfo, ttlMs = 1_500): Promise<boolean> {
  const key = `${info.taskId}|${info.url}|${info.token}`
  const cached = healthCache.get(key)
  if (cached !== undefined) {
    const effectiveTtl = cached.alive ? ttlMs : Math.min(ttlMs, 400)
    if (Date.now() - cached.at < effectiveTtl) return cached.alive
  }
  const alive = await daemonAlive(info, 1_200)
  healthCache.set(key, { at: Date.now(), alive })
  return alive
}

/**
 * The daemon's admin API binds loopback inside its Task container, which the
 * Web UI cannot reach when it is itself containerized. Fall back to the
 * container state so the UI does not offer to start an already running task.
 */
async function taskContainerRunning(paths: TaskPaths): Promise<boolean> {
  const cached = containerCache.get(paths.taskId)
  if (cached !== undefined && Date.now() - cached.at < CONTAINER_CACHE_MS) return cached.running
  const running = await dockerTaskRunning(paths)
  containerCache.set(paths.taskId, { at: Date.now(), running })
  return running
}

function isActiveWork(work: RuntimeState['works'][string]): boolean {
  return work.runtimeStatus !== 'exited' && work.runtimeStatus !== 'finished'
}

function preview(text: string, limit = 160): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1)}…`
}

/** Build the list-facing projection of one task. */
export function summarizeTask(state: RuntimeState, online: boolean): TaskSummary {
  const works = Object.values(state.works)
  const active = works.filter(isActiveWork)
  const currentRound = state.rounds.find((round) => round.id === state.currentRoundId) ?? null
  return {
    taskId: state.taskId,
    status: state.status,
    ...(state.statusReason === undefined ? {} : { statusReason: state.statusReason }),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    targetVersion: state.targetVersion,
    sharedStateVersion: state.sharedStateVersion,
    participants: active.map((work) => work.id).sort(),
    activeWorkCount: active.length,
    workCount: works.length,
    findingCount: state.findings.length,
    messageCount: state.messages.length,
    roundCount: state.rounds.length,
    commandCount: state.commands.length,
    currentRoundId: currentRound?.id ?? null,
    completionRoundId: state.completion?.roundId ?? null,
    runId: state.currentRunId,
    runCount: state.runs.length,
    reports: Object.values(state.reports ?? {})
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((report) => ({
        key: report.key,
        path: report.path,
        revision: report.revision,
        publishedByWorkId: report.publishedByWorkId,
        publishedAt: report.publishedAt,
        entryState: report.entryState,
      })),
    ...(state.interruptedAt === undefined ? {} : { interruptedAt: state.interruptedAt }),
    online,
    startPreview: preview(state.startInformation),
    endPreview: preview(state.endInformation),
  }
}

function compareUpdatedDesc(left: RuntimeState, right: RuntimeState): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

/** List every initialized task under the tasks root, newest update first. */
export async function listTasks(tasksRoot: string): Promise<TaskSummary[]> {
  const entries = await readdir(tasksRoot, { withFileTypes: true }).catch(() => [])
  const loaded: { state: RuntimeState; online: boolean }[] = []
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isValidTaskId(entry.name))
      .map(async (entry) => {
        const paths = makeTaskPaths(tasksRoot, entry.name)
        const state = await loadState(paths).catch(() => null)
        if (state === null) return
        const info = await readDaemonInfo(paths)
        const online = info !== null && (await daemonOnline(info))
        loaded.push({ state, online })
      }),
  )
  loaded.sort((left, right) => compareUpdatedDesc(left.state, right.state))
  return loaded.map((item) => summarizeTask(item.state, item.online))
}

async function fileEntry(titleDir: string, rel: string, group: FileEntry['group']): Promise<FileEntry | null> {
  const info = await stat(join(titleDir, rel)).catch(() => null)
  if (info === null || !info.isFile()) return null
  return {
    path: rel,
    name: rel.split('/').at(-1) ?? rel,
    group,
    size: info.size,
    mtime: info.mtime.toISOString(),
  }
}

async function collectFiles(
  root: string,
  relBase: string,
  group: FileEntry['group'],
  output: FileEntry[],
  depth = 0,
): Promise<void> {
  if (output.length >= MAX_LISTED_FILES || depth > 6) return
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (output.length >= MAX_LISTED_FILES) break
    if (entry.name.startsWith('.')) continue
    const absolute = join(root, entry.name)
    const rel = `${relBase}/${entry.name}`
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await collectFiles(absolute, rel, group, output, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(absolute).catch(() => null)
    if (info === null) continue
    output.push({
      path: rel,
      name: entry.name,
      group,
      size: info.size,
      mtime: info.mtime.toISOString(),
    })
  }
}

const FILE_ORDER: Record<FileEntry['group'], number> = {
  doc: 0,
  audit: 1,
  consensus: 2,
  evidence: 3,
  log: 4,
  config: 5,
}

const DOC_ORDER: Record<string, number> = { 'task.md': 0, 'findings.md': 1, 'works.md': 2 }

/** Every file the Web UI may display, grouped for the file browser. */
export async function listTaskFiles(paths: TaskPaths, state?: RuntimeState): Promise<FileEntry[]> {
  const files: FileEntry[] = []
  for (const [rel, group] of [
    ['task.md', 'doc'],
    ['findings.md', 'doc'],
    ['works.md', 'doc'],
    ['runtime/journal.jsonl', 'audit'],
    ['runtime/harness.patch.yml', 'config'],
  ] as const) {
    const entry = await fileEntry(paths.taskDir, rel, group)
    if (entry !== null) files.push(entry)
  }
  for (const report of Object.values(state?.reports ?? {})) {
    const entry = await fileEntry(paths.taskDir, report.path, 'doc')
    if (entry !== null) files.push(entry)
  }
  await collectFiles(paths.consensusDir, 'runtime/consensus', 'consensus', files)
  await collectFiles(paths.reportsDir, 'runtime/reports', 'audit', files)
  await collectFiles(paths.evidenceDir, 'evidence', 'evidence', files)
  await collectFiles(paths.logsDir, 'runtime/logs', 'log', files)
  const unique = new Map<string, FileEntry>()
  for (const entry of files) {
    if (!unique.has(entry.path)) unique.set(entry.path, entry)
  }
  return [...unique.values()].sort((left, right) => {
    const groupDelta = FILE_ORDER[left.group] - FILE_ORDER[right.group]
    if (groupDelta !== 0) return groupDelta
    if (left.group === 'doc' && right.group === 'doc') {
      const docDelta = (DOC_ORDER[left.path] ?? 8) - (DOC_ORDER[right.path] ?? 8)
      if (docDelta !== 0) return docDelta
    }
    return left.path.localeCompare(right.path)
  })
}

/** Read the last `maxBytes` of a possibly large log file. */
async function readTail(file: string, maxBytes: number): Promise<string> {
  const info = await stat(file).catch(() => null)
  if (info === null || !info.isFile()) return ''
  const start = Math.max(0, info.size - maxBytes)
  const length = info.size - start
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const prefix = start > 0 ? `…（仅显示最后 ${Math.round(maxBytes / 1024)} KiB）\n` : ''
    return prefix + buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

interface AdminSnapshotResult {
  blockers?: string[]
  participants?: string[]
}

/** Full detail used by the task dashboard. */
export async function getTaskDetail(tasksRoot: string, taskId: string): Promise<TaskDetail> {
  const paths = makeTaskPaths(tasksRoot, taskId)
  const state = await loadState(paths)
  const info = await readDaemonInfo(paths)
  const online = info !== null && (await daemonOnline(info))
  const containerRunning = !online && composeWebMode() ? await taskContainerRunning(paths) : false
  let blockers: string[] | null = null
  let participants: string[] | null = null
  let runtimeError: string | null = null
  if (info !== null && online) {
    try {
      const snapshot = (await callDaemon(info, '/admin', 'task.status', {}, { timeoutMs: 4_000 })) as AdminSnapshotResult
      blockers = Array.isArray(snapshot.blockers) ? snapshot.blockers : null
      participants = Array.isArray(snapshot.participants) ? snapshot.participants : null
    } catch (error) {
      runtimeError = describeError(error)
    }
  }
  return {
    summary: summarizeTask(state, online),
    state,
    runtime: {
      online,
      containerRunning,
      pid: info?.pid ?? null,
      startedAt: info?.startedAt ?? null,
      url: info?.url ?? null,
      blockers,
      participants,
      error: runtimeError,
    },
    files: await listTaskFiles(paths, state),
    logs: {
      daemon: await readTail(join(paths.logsDir, 'daemon.log'), 12_000),
      run: await readTail(join(paths.logsDir, 'run.out.log'), 12_000),
    },
    now: nowIso(),
  }
}

function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new AppError('FILE_NOT_ALLOWED', `不允许的文件路径：${value}`)
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new AppError('FILE_NOT_ALLOWED', `不允许的文件路径：${value}`)
  }
  const allowed = [
    /^[^/]+\.(md|txt)$/,
    /^runtime\/journal\.jsonl$/,
    /^runtime\/harness\.patch\.yml$/,
    /^runtime\/consensus\/[^\0]+$/,
    /^runtime\/reports\/[^\0]+$/,
    /^runtime\/logs\/[^\0]+$/,
    /^evidence\/[^\0]+$/,
  ]
  if (!allowed.some((pattern) => pattern.test(normalized))) {
    throw new AppError('FILE_NOT_ALLOWED', `该文件不通过 Web UI 暴露：${normalized}`)
  }
  return normalized
}

/** Read one allowlisted task file, refusing paths that escape the task directory. */
export async function readTaskFile(paths: TaskPaths, inputPath: string): Promise<FileView> {
  const rel = safeRelativePath(inputPath)
  const taskDir = await realpath(paths.taskDir).catch(() => {
    throw new AppError('TASK_NOT_FOUND', `找不到任务目录：${paths.taskId}`)
  })
  const absolute = resolve(taskDir, rel)
  if (absolute !== taskDir && !absolute.startsWith(taskDir + sep)) {
    throw new AppError('FILE_NOT_ALLOWED', '文件路径超出任务目录')
  }
  const real = await realpath(absolute).catch(() => null)
  if (real === null || (real !== taskDir && !real.startsWith(taskDir + sep))) {
    throw new AppError('FILE_NOT_FOUND', `文件不存在：${rel}`)
  }
  const info = await stat(real)
  if (!info.isFile()) throw new AppError('FILE_NOT_FOUND', `不是文件：${rel}`)
  const limit = Math.min(info.size, MAX_FILE_BYTES)
  const handle = await open(real, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return {
      path: rel,
      size: info.size,
      mtime: info.mtime.toISOString(),
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: info.size > MAX_FILE_BYTES,
    }
  } finally {
    await handle.close()
  }
}

/** Create a task from the Web UI and materialize the same harness patch as the CLI. */
export async function createTaskFromWeb(
  tasksRoot: string,
  input: CreateTaskInput,
): Promise<{ taskId: string; paths: TaskPaths }> {
  const taskId = input.id?.trim() ?? ''
  const paths = makeTaskPaths(tasksRoot, taskId.length > 0 ? taskId : newTaskId())
  await assertTaskDoesNotExist(paths)
  await createTask(paths, { startInformation: input.start, endInformation: input.end })
  await writeFileAtomic(
    paths.patchFile,
    renderHarnessPatch({ paths, mcpEntry: MCP_ENTRY, nodeExecutable: process.execPath }),
  )
  return { taskId: paths.taskId, paths }
}

/**
 * Start a task as a Compose service. Tasks are never launched as detached
 * child processes anymore: the Web UI writes the service into
 * compose/tasks.yaml and runs `docker compose up` for that service.
 */
export async function startTaskRun(options: StartRunOptions): Promise<StartRunResult> {
  const paths = makeTaskPaths(options.tasksRoot, options.taskId)
  const state = await loadState(paths)
  if (state.status !== 'active') {
    throw new AppError('TASK_NOT_ACTIVE', `任务状态为 ${state.status}，只能启动进行中的任务`)
  }
  const info = await readDaemonInfo(paths)
  if (info !== null && (await daemonAlive(info, 800))) {
    throw new AppError('ALREADY_RUNNING', `任务已在运行（pid ${info.pid}）`)
  }
  if (!composeWebMode()) {
    throw new AppError('COMPOSE_REQUIRED', '任务只能由 Docker Compose 启动；请使用 docker compose up -d')
  }
  const guardAt = startGuard.get(options.taskId)
  if (guardAt !== undefined) {
    throw new AppError('ALREADY_STARTING', '任务正在启动中；如果失败，请查看 daemon 日志后重试')
  }
  startGuard.set(options.taskId, Date.now())
  try {
    const result = await startDockerTask(paths, options.logger)
    return { pid: result.pid }
  } finally {
    startGuard.delete(options.taskId)
  }
}

function offlineDriver(): HarnessDriver {
  const fail = async (): Promise<never> => {
    throw new AppError('DAEMON_NOT_RUNNING', '运行时未在运行')
  }
  return {
    ensure: fail,
    prompt: fail,
    waitForIdle: fail,
    quiesce: async () => undefined,
    stop: async () => undefined,
    stopAll: async () => undefined,
  }
}

async function openOfflineEngine(paths: TaskPaths): Promise<Engine> {
  return Engine.open({
    paths,
    driver: offlineDriver(),
    logger: createLogger({ level: 'error' }),
    dispatch: false,
  })
}

/**
 * Take the task's writer lease before an offline mutation. A daemon that is
 * alive but whose health probe fails keeps renewing its heartbeat, so this
 * refuses (TASK_BUSY) instead of producing a second writer.
 */
async function withWebOwnership<T>(paths: TaskPaths, fn: (engine: Engine) => Promise<T>): Promise<T> {
  const lease = await acquireTaskOwnership(paths, 'web', { waitMs: 10_000, staleMs: 8_000 })
  let engine: Engine | undefined
  try {
    engine = await openOfflineEngine(paths)
    return await fn(engine)
  } finally {
    await engine?.finishOffline()
    await releaseTaskOwnership(paths, lease).catch(() => undefined)
  }
}

/** Stop a task through the daemon when possible, otherwise edit state offline. */
export async function stopTaskFromWeb(tasksRoot: string, taskId: string, reason: string): Promise<ActionResult> {
  const paths = makeTaskPaths(tasksRoot, taskId)
  if (composeWebMode() && (await stopDockerTask(paths, reason))) {
    return { text: '任务已停止（Docker 容器）', online: true }
  }
  const info = await readDaemonInfo(paths)
  if (info !== null && (await daemonOnline(info))) {
    try {
      const result = (await callDaemon(info, '/admin', 'task.stop', { reason }, { timeoutMs: 15_000 })) as {
        text?: string
      }
      return { text: result.text ?? '任务已停止', online: true }
    } catch (error) {
      // The health probe may have succeeded just before the daemon died. A
      // transport failure falls back to the offline lease path; a domain error
      // from the daemon is a real answer and is reported as such.
      if (error instanceof AppError) throw error
    }
  }
  // A lost response after the daemon committed `stopped` must not turn into a
  // misleading "task is not active" error on the retry.
  const current = await loadState(paths).catch(() => null)
  if (current !== null && current.status !== 'active') {
    return { text: `任务已停止（${current.status}）`, online: false }
  }
  const result = await withWebOwnership(paths, async (engine) => {
    return engine.stopTask(reason)
  })
  return { text: `${result.text}（运行时未在运行，已直接落盘）`, online: false }
}

async function setInformationFromWeb(
  tasksRoot: string,
  taskId: string,
  op: 'task.set_end' | 'task.set_start',
  text: string,
): Promise<ActionResult> {
  if (text.trim().length === 0) throw new AppError('INVALID_ARGUMENT', '信息不能为空')
  const paths = makeTaskPaths(tasksRoot, taskId)
  if (composeWebMode()) {
    const opName = op === 'task.set_end' ? 'set-end' : 'set-start'
    if (await setDockerTaskInformation(paths, opName, text)) {
      return { text: '已更新（Docker 容器）', online: true }
    }
  }
  const info = await readDaemonInfo(paths)
  if (info !== null && (await daemonOnline(info))) {
    try {
      const result = (await callDaemon(info, '/admin', op, { text }, { timeoutMs: 15_000 })) as { text?: string }
      return { text: result.text ?? '已更新', online: true }
    } catch (error) {
      // The daemon may have exited between the health probe and the call; the
      // offline path takes the writer lease and retries the same edit.
      if (error instanceof AppError) throw error
    }
  }
  const result = await withWebOwnership(paths, async (engine) => {
    return op === 'task.set_end' ? engine.setEndInformation(text) : engine.setStartInformation(text)
  })
  return { text: `${result.text}（运行时未在运行，已直接落盘）`, online: false }
}

export async function setEndFromWeb(tasksRoot: string, taskId: string, text: string): Promise<ActionResult> {
  return setInformationFromWeb(tasksRoot, taskId, 'task.set_end', text)
}

/** Delete a task directory after refusing while its runtime is still alive. */
export async function deleteTaskFromWeb(tasksRoot: string, taskId: string): Promise<ActionResult> {
  const paths = makeTaskPaths(tasksRoot, taskId)
  const state = await loadState(paths)
  if (state.status === 'active') {
    const info = await readDaemonInfo(paths)
    if (info !== null && (await daemonOnline(info))) {
      throw new AppError('TASK_RUNNING', '任务正在运行；请先停止任务再删除')
    }
  }
  if (composeWebMode()) {
    if (await dockerTaskRunning(paths)) {
      throw new AppError('TASK_RUNNING', '任务容器正在运行；请先停止任务再删除')
    }
    await removeDockerTaskContainer(paths)
  }
  // Deleting the directory is a write too: refuse while another writer's
  // lease is live (for example a daemon that is alive but whose health probe
  // is failing).
  const lease = await acquireTaskOwnership(paths, 'web', { waitMs: 10_000 })
  try { await deleteOwnedTask(paths, lease) }
  finally { await releaseTaskOwnership(paths, lease) }
  return { text: `任务 ${taskId} 已删除`, online: false }
}

export async function setStartFromWeb(tasksRoot: string, taskId: string, text: string): Promise<ActionResult> {
  return setInformationFromWeb(tasksRoot, taskId, 'task.set_start', text)
}

/**
 * Send one task-level human command.
 *
 * Unlike start/end edits, a command is only meaningful to a live executor
 * loop, so this path never edits `state.json` offline: the Web UI must first
 * reach the single runtime writer (through the container in Compose mode or
 * the loopback admin API in host mode). If that is impossible, the user gets
 * an explicit "not saved" result and may retry with the same request id.
 */
export async function sendCommandFromWeb(  tasksRoot: string,
  taskId: string,
  text: string,
  requestId: string,
): Promise<ActionResult> {
  if (text.trim().length === 0) throw new AppError('INVALID_ARGUMENT', '命令内容不能为空')
  const trimmedRequestId = requestId.trim()
  if (trimmedRequestId.length === 0) {
    throw new AppError('INVALID_ARGUMENT', '缺少 requestId；客户端应为同一次提交复用同一个 ID')
  }
  const paths = makeTaskPaths(tasksRoot, taskId)
  const state = await loadState(paths)
  if (state.status !== 'active') {
    throw new AppError(
      'TASK_NOT_ACTIVE',
      `任务已${state.status === 'completed' ? '完成' : '停止'}，命令未保存。请使用“继续并发送”开启新一轮。`,
    )
  }
  if (composeWebMode()) {
    const result = await sendDockerTaskCommand(paths, text, trimmedRequestId)
    if (result !== null) return { text: result.text, online: true }
    throw new AppError(
      'RUNTIME_OFFLINE',
      '任务容器未在运行；命令未保存。请先启动运行时，然后用同一 request ID 重试。',
    )
  }
  const info = await readDaemonInfo(paths)
  if (info === null || !(await daemonOnline(info))) {
    throw new AppError(
      'RUNTIME_OFFLINE',
      '任务运行时未在运行；命令未保存。请先启动运行时，然后用同一 request ID 重试。',
    )
  }
  try {
    const result = (await callDaemon(
      info,
      '/admin',
      'task.command',
      { text, request_id: trimmedRequestId, source: 'web' },
      { timeoutMs: 30_000 },
    )) as { text?: string }
    return { text: result.text ?? '命令已保存', online: true }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(
      'RUNTIME_OFFLINE',
      `无法连接任务运行时（${describeError(error)}）；命令未保存。请用同一 request ID 重试。`,
    )
  }
}

export interface ContinueWebResult extends ActionResult {
  runId: string
  workId: string
  commandId: string
  idempotent: boolean
  started: boolean
  startError?: string
}

/**
 * Continue an ended task: one new run with one new work and the user's
 * instruction, followed by a container start when running under Compose.
 *
 * The state edit itself is offline and guarded by the writer lease. Any live
 * container is stopped first so the previous run's managed execution cannot
 * overlap the new run. If the container fails to start afterwards, the run
 * stays committed and the UI can retry "启动运行时" with the same result.
 */
export async function continueTaskFromWeb(
  tasksRoot: string,
  taskId: string,
  text: string,
  requestId: string,
): Promise<ContinueWebResult> {
  if (text.trim().length === 0) throw new AppError('INVALID_ARGUMENT', '继续指令不能为空')
  const trimmedRequestId = requestId.trim()
  if (trimmedRequestId.length === 0) {
    throw new AppError('INVALID_ARGUMENT', '缺少 requestId；客户端应为同一次提交复用同一个 ID')
  }
  const paths = makeTaskPaths(tasksRoot, taskId)
  const before = await loadState(paths)
  // A retry of a committed continue must return the same run/work even after
  // the task became active; never stop or start anything for a replay.
  const previousRun = before.runs.find((run) => run.continueRequestId === trimmedRequestId)
  if (previousRun !== undefined) {
    if (previousRun.continueText !== text) {
      throw new AppError(
        'REQUEST_CONFLICT',
        `request_id ${trimmedRequestId} 已用于另一次继续操作；同 ID 不能提交不同正文`,
      )
    }
    const work = previousRun.workIds.map((id) => before.works[id]).find((item) => item !== undefined)
    const command = previousRun.commandIds
      .map((id) => before.commands.find((item) => item.id === id))
      .find((item) => item !== undefined)
    if (work === undefined || command === undefined) {
      throw new AppError('STATE_CORRUPT', `继续请求 ${trimmedRequestId} 的记录缺少 work 或命令`)
    }
    return {
      text: `request ID 已提交过，返回原继续结果：轮次 ${previousRun.id}，work ${work.id}，命令 ${command.id}。未重复创建轮次。`,
      online: false,
      runId: previousRun.id,
      workId: work.id,
      commandId: command.id,
      idempotent: true,
      started: false,
    }
  }
  if (before.status === 'active') {
    const active = Object.values(before.works).filter(
      (work) => work.runId === before.currentRunId && work.runtimeStatus !== 'exited' && work.runtimeStatus !== 'finished',
    )
    throw new AppError(
      'TASK_ACTIVE',
      active.length === 0
        ? '任务正在进行中但没有参与 work；请使用“恢复工作”创建承接执行者。'
        : '任务正在进行中；请使用发送命令，或先停止任务。',
    )
  }
  const info = await readDaemonInfo(paths)
  if (info !== null && (await daemonAlive(info, 1_200))) {
    throw new AppError('RUNTIME_STOPPING', '任务运行时仍在运行；请等它停止后，用同一 request ID 重试继续。')
  }
  if (composeWebMode()) {
    const stopped = await stopDockerTaskContainer(paths)
    if (stopped) {
      // The graceful stop releases the old daemon's writer lease; give its
      // last heartbeat a moment to be removed before taking the lease.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const result = await withWebOwnership(paths, async (engine) => {
    return engine.continueTask({
      text,
      requestId: trimmedRequestId,
      source: 'web',
      executionsStopped: true,
    })
  })
  let started = false
  let startError: string | undefined
  if (composeWebMode()) {
    try {
      await startDockerTask(paths)
      started = true
    } catch (error) {
      startError = describeError(error)
    }
  }
  return {
    text:
      result.text +
      (started
        ? '\n任务运行时已启动。'
        : composeWebMode()
          ? `\n新一轮已提交，但启动运行时失败${startError === undefined ? '' : `：${startError}`}。可在任务页重试“启动运行时”。`
          : '\n请通过 docker compose 或 Web UI 启动任务运行时。'),
    online: started,
    runId: result.run.id,
    workId: result.work.id,
    commandId: result.command.id,
    idempotent: result.idempotent,
    started,
    ...(startError === undefined ? {} : { startError }),
  }
}

export interface RecoverWebResult extends ActionResult {
  runId: string
  workId: string | null
  created: boolean
  idempotent: boolean
  participants: string[]
  started: boolean
  startError?: string
}

/**
 * Recover an active task with no participants by creating one takeover work.
 * If any participant still exists, no work is created ("优先恢复原有 work").
 */
export async function recoverTaskFromWeb(
  tasksRoot: string,
  taskId: string,
  requestId: string,
): Promise<RecoverWebResult> {
  const trimmedRequestId = requestId.trim()
  if (trimmedRequestId.length === 0) {
    throw new AppError('INVALID_ARGUMENT', '缺少 requestId；客户端应为同一次提交复用同一个 ID')
  }
  const paths = makeTaskPaths(tasksRoot, taskId)
  const state = await loadState(paths)
  if (state.status !== 'active') {
    throw new AppError(
      'TASK_NOT_ACTIVE',
      `任务状态为 ${state.status}；恢复只用于进行中的任务，已结束任务请使用“继续并发送”。`,
    )
  }
  const info = await readDaemonInfo(paths)
  if (info !== null && (await daemonAlive(info, 1_200))) {
    try {
      const result = (await callDaemon(
        info,
        '/admin',
        'task.recover',
        { request_id: trimmedRequestId, source: 'web' },
        { timeoutMs: 30_000 },
      )) as {
        text?: string
        run?: { id?: string }
        work?: { id?: string } | null
        created?: boolean
        idempotent?: boolean
        participants?: string[]
      }
      return {
        text: result.text ?? '恢复请求已提交',
        online: true,
        runId: result.run?.id ?? state.currentRunId,
        workId: result.work?.id ?? null,
        created: result.created === true,
        idempotent: result.idempotent === true,
        participants: result.participants ?? [],
        started: false,
      }
    } catch (error) {
      // Transport failure means the daemon answer is unknown; the offline path
      // replays the same request id, which engine.recoverTask treats as
      // idempotent, so a committed recovery is not duplicated.
      if (error instanceof AppError) throw error
    }
  }
  if (composeWebMode() && (await dockerTaskRunning(paths))) {
    throw new AppError(
      'RUNTIME_UNREACHABLE',
      '任务容器在运行但管理 API 不可达；为避免产生第二个写入者，未修改状态。请稍后重试或先停止容器。',
    )
  }
  const result = await withWebOwnership(paths, async (engine) => {
    return engine.recoverTask({ requestId: trimmedRequestId, source: 'web' })
  })
  let started = false
  let startError: string | undefined
  if (result.created && composeWebMode()) {
    try {
      await startDockerTask(paths)
      started = true
    } catch (error) {
      startError = describeError(error)
    }
  }
  return {
    text:
      result.text +
      (started
        ? '\n任务运行时已启动。'
        : result.created && composeWebMode()
          ? `\n承接 work 已创建，但启动运行时失败${startError === undefined ? '' : `：${startError}`}。可在任务页重试“启动运行时”。`
          : ''),
    online: started,
    runId: result.run.id,
    workId: result.work?.id ?? null,
    created: result.created,
    idempotent: result.idempotent,
    participants: result.participants,
    started,
    ...(startError === undefined ? {} : { startError }),
  }
}
