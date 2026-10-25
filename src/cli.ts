/**
 * Human-facing command line.
 *
 * Agents never use this CLI: their only interface is the MCP bridge. Humans use
 * it to create a task, run (or resume) the runtime, inspect state, change the
 * task definition while running, and stop the task explicitly.
 */

import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startApiServer, type ApiServer } from './api/server.ts'
import { callDaemon, daemonAlive, readDaemonInfo, removeDaemonInfo, writeDaemonInfo } from './core/daemon.ts'
import { acquireTaskOwnership, releaseTaskOwnership, startOwnershipHeartbeat } from './core/ownership.ts'
import { Engine } from './core/engine.ts'
import { createTask, assertTaskDoesNotExist } from './core/task.ts'
import { defaultTasksRoot, makeTaskPaths, resolveTaskPaths, type TaskPaths } from './core/paths.ts'
import { renderRound, renderWorksMarkdown, renderCurrentFindingsHeader, renderFindingBlock } from './core/render.ts'
import { buildFindingsIndex } from './core/findings.ts'
import { normalizeReportKey, renderReportMeta } from './core/reports.ts'
import { loadState } from './core/state.ts'
import { SdkHarnessDriver } from './harness/sdk-driver.ts'
import { renderHarnessPatch } from './harness/patch.ts'
import type { HarnessDriver } from './harness/driver.ts'
import type { CommandRecord, RuntimeState, TaskStatus } from './types.ts'
import { COMMAND_DELIVERY_STATUS_TEXT } from './types.ts'
import { AppError, describeError } from './util/errors.ts'
import { newTaskId } from './util/ids.ts'
import { createLogger } from './util/log.ts'
import { modelConcurrencyFromEnv } from './util/semaphore.ts'
import { readTextIfExists, writeFileAtomic } from './util/atomic.ts'
import { startWebServer } from './web/server.ts'
import { DEFAULT_WEB_PORT, parsePort } from './util/ports.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MCP_ENTRY = fileURLToPath(new URL('./mcp/main.ts', import.meta.url))

/**
 * Keep harness state (profile, credentials lookup, sessions cache) inside the
 * repository by default. Recovery itself lives in the task directory; this only
 * avoids writing into the user's home directory when DSH_HOME is not set.
 */
function ensureRepoLocalDshHome(): void {
  const configured = process.env.DSH_HOME
  if (configured === undefined || configured.length === 0) {
    process.env.DSH_HOME = join(REPO_ROOT, '.dsh')
  }
}

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      if (equals > 2) {
        flags.set(token.slice(2, equals), token.slice(equals + 1))
        continue
      }
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next)
        index += 1
      } else {
        flags.set(key, true)
      }
      continue
    }
    positionals.push(token)
  }
  return { positionals, flags }
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

/**
 * A request id is the caller's promise to retry idempotently. A flag that was
 * written without a value must fail loudly instead of silently minting a new
 * id (which would make the retry create a second command/run/work).
 */
function requestIdFrom(args: ParsedArgs): string {
  const value = args.flags.get('request-id')
  if (value === true) {
    throw new AppError('INVALID_ARGUMENT', '--request-id 需要一个值，例如 --request-id cmd-001')
  }
  if (typeof value === 'string') {
    if (value.trim().length === 0) throw new AppError('INVALID_ARGUMENT', '--request-id 不能为空')
    return value.trim()
  }
  return randomUUID()
}

/** Read one text input, refusing to silently consume stdin without a flag. */
async function requiredInput(args: ParsedArgs, label: string): Promise<string> {
  const file = args.flags.get('file')
  if (file === true) throw new AppError('INVALID_ARGUMENT', '--file 需要路径或 -')
  return readInput(typeof file === 'string' ? file : undefined, label)
}

const USAGE = `Nexora

用法：
  liebian task new --start <文件|-> --end <文件|-> [--id 任务ID] [--tasks-dir 目录]
  liebian run --task <任务ID|任务目录> [--provider P] [--model M]
  liebian status --task <任务ID|任务目录> [--json]
  liebian stop --task <任务ID|任务目录> [--reason 原因]
  liebian set-end --task <任务ID|任务目录> --file <文件|->
  liebian set-start --task <任务ID|任务目录> --file <文件|->
  liebian command --task <任务ID|任务目录> (--text 文本 | --file 文件|-) [--request-id ID]
  liebian commands --task <任务ID|任务目录> [--json]
  liebian continue --task <任务ID|任务目录> (--text 文本 | --file 文件|-) [--request-id ID]
  liebian recover --task <任务ID|任务目录> [--request-id ID]
  liebian works --task <任务ID|任务目录>
  liebian findings --task <任务ID|任务目录> [--history]
  liebian report --task <任务ID|任务目录> [--key 报告键]
  liebian messages --task <任务ID|任务目录>
  liebian task list [--tasks-dir 目录]
  liebian web [--port 43187] [--host 127.0.0.1] [--tasks-dir 目录]

说明：
  - 任务目录默认是仓库内 tasks/，可用 --tasks-dir 或 LIEBIAN_TASKS_DIR 覆盖。
  - 任务只由 Docker Compose 启动：Web UI 把任务写成 compose service，并用
    docker compose up 启停；宿主入口是 docker compose up -d。
  - web 供 compose 的 web service 在容器内调用；默认只监听 127.0.0.1，
    容器内用 --host 0.0.0.0（docker compose 已代劳）。
  - LIEBIAN_WEB_TOKEN 可固定访问令牌；LIEBIAN_WEB_ALLOWED_ORIGINS 可追加允许的来源。
  - command 只在运行时在线时写入；离线不会直接改 state，请用同一 --request-id 稍后重试。
  - continue 只用于已结束（completed/stopped）的任务：同一任务开启新一轮、新 work 和空表态集合；
    旧轮次终态与完成记录保留。先用同一 --request-id 重试可避免重复创建轮次。
  - recover 用于 active 但已没有参与 work 的任务；仍有参与 work 时不会创建新 work。
  - 只有全体参与 work 明确同意终点已达成时任务才会 completed；stop 只记录停止。
`

async function readInput(value: string | undefined, stdinLabel: string): Promise<string> {
  if (value === undefined) throw new AppError('INVALID_ARGUMENT', `缺少 ${stdinLabel} 输入（使用 --file 或 --text）`)
  if (value === '-') {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const absolute = resolve(value)
  const info = await stat(absolute).catch(() => null)
  if (info === null || !info.isFile()) throw new AppError('INVALID_ARGUMENT', `文件不存在：${absolute}`)
  return readFile(absolute, 'utf8')
}

function taskPathsFrom(args: ParsedArgs): Promise<TaskPaths> {
  // `positionals[0]` is the command itself; the optional task reference follows.
  const reference = flagString(args, 'task') ?? args.positionals[1]
  if (reference === undefined) throw new AppError('INVALID_ARGUMENT', '缺少 --task')
  const tasksRoot = flagString(args, 'tasks-dir') ?? defaultTasksRoot()
  return resolveTaskPaths(reference, tasksRoot)
}

async function writePatch(paths: TaskPaths): Promise<void> {
  const content = renderHarnessPatch({
    paths,
    mcpEntry: MCP_ENTRY,
    nodeExecutable: process.execPath,
  })
  await writeFileAtomic(paths.patchFile, content)
}

// ---------------------------------------------------------------------------
// Offline helpers (daemon not running)
// ---------------------------------------------------------------------------

/** Engine with a driver that cannot start sessions; used for offline state edits. */
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
    logger: createLogger({ file: join(paths.logsDir, 'cli.log') }),
    dispatch: false,
  })
}

/**
 * Take the task's single-writer lease around one offline mutation. A live
 * daemon keeps its heartbeat current, so this fails with TASK_BUSY instead of
 * letting the CLI become a second writer just because `/health` timed out.
 */
async function withTaskOwnership<T>(
  paths: TaskPaths,
  fn: (engine: Engine) => Promise<T>,
  waitMs = 10_000,
): Promise<T> {
  const lease = await acquireTaskOwnership(paths, 'cli', { waitMs, staleMs: 8_000 })
  let engine: Engine | undefined
  try {
    engine = await openOfflineEngine(paths)
    return await fn(engine)
  } finally {
    await engine?.finishOffline()
    await releaseTaskOwnership(paths, lease).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandTaskNew(args: ParsedArgs): Promise<void> {
  const tasksRoot = flagString(args, 'tasks-dir') ?? defaultTasksRoot()
  const taskId = flagString(args, 'id') ?? newTaskId()
  const paths = makeTaskPaths(tasksRoot, taskId)
  await assertTaskDoesNotExist(paths)

  const startText = flagString(args, 'start-text')
  const endText = flagString(args, 'end-text')
  const startInformation =
    startText ?? (await readInput(flagString(args, 'start'), '起始信息 --start'))
  const endInformation = endText ?? (await readInput(flagString(args, 'end'), '终点信息 --end'))

  const state = await createTask(paths, { startInformation, endInformation })
  await writePatch(paths)
  process.stdout.write(
    `已创建任务 ${state.taskId}\n目录：${paths.taskDir}\n\n下一步：\n  liebian run --task ${paths.taskDir}\n`,
  )
}

async function commandTaskList(args: ParsedArgs): Promise<void> {
  const tasksRoot = flagString(args, 'tasks-dir') ?? defaultTasksRoot()
  const entries = await readdir(tasksRoot, { withFileTypes: true }).catch(() => [])
  const rows: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const paths = makeTaskPaths(tasksRoot, entry.name)
    const state = await loadState(paths).catch(() => null)
    if (state === null) continue
    const active = Object.values(state.works).filter(
      (work) => work.runtimeStatus !== 'exited' && work.runtimeStatus !== 'finished',
    )
    rows.push(
      `${state.taskId}\t${state.status}\t参与 work ${active.length}\t发现 ${state.findings.length}\t目标版本 v${state.targetVersion}\t${state.updatedAt}`,
    )
  }
  if (rows.length === 0) {
    process.stdout.write(`没有任务（${tasksRoot}）\n`)
    return
  }
  process.stdout.write(`任务（${tasksRoot}）：\n${rows.join('\n')}\n`)
}

async function commandStatus(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const info = await readDaemonInfo(paths)
  if (args.flags.has('json')) {
    const state = await loadState(paths)
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  if (info !== null) {
    try {
      const result = (await callDaemon(info, '/admin', 'task.status', {})) as { text?: string }
      if (typeof result.text === 'string') {
        process.stdout.write(`${result.text}\n`)
        return
      }
    } catch {
      // fall through to offline rendering
    }
  }
  const state = await loadState(paths)
  process.stdout.write(`${renderOfflineStatus(state)}\n`)
}

function renderOfflineStatus(state: RuntimeState): string {
  const active = Object.values(state.works)
    .filter((work) => work.runtimeStatus !== 'exited' && work.runtimeStatus !== 'finished')
    .sort((left, right) => left.id.localeCompare(right.id))
  const round = state.currentRoundId === null
    ? null
    : state.rounds.find((item) => item.id === state.currentRoundId && item.status === 'open') ?? null
  const lines = [
    `任务 ${state.taskId}: ${state.status}`,
    state.statusReason === undefined ? '' : `说明：${state.statusReason}`,
    `运行轮次：${state.currentRunId}（累计 ${state.runs.length} 轮）`,
    `目标版本：v${state.targetVersion}；共享状态版本：${state.sharedStateVersion}`,
    `参与 work：${active.length === 0 ? '（无）' : active.map((work) => work.id).join(', ')}`,
    `发现：${state.findings.length}；消息：${state.messages.length}；共识轮次：${state.rounds.length}`,
    state.interruptedAt === undefined ? '' : `上次中断：${state.interruptedAt}（再次 run 可恢复）`,
    '',
    renderWorksMarkdown(state).trim(),
  ]
  if (round !== null) lines.push('', renderRound(round, state.works).trim())
  return lines.filter((line) => line !== '').join('\n')
}

async function commandRun(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const state = await loadState(paths)
  if (state.status !== 'active') {
    process.stdout.write(`任务 ${state.taskId} 状态为 ${state.status}，不需要运行。\n`)
    return
  }
  const previous = await readDaemonInfo(paths)
  if (previous !== null) {
    const alive = await daemonAlive(previous)
    if (alive) throw new AppError('ALREADY_RUNNING', `任务已在运行：${previous.url}（pid ${previous.pid}）`)
  }

  // The daemon is the task's long-lived writer. Its heartbeat lease is what
  // blocks an offline CLI/Web edit from writing state concurrently.
  // Validate before opening a server; otherwise invalid config leaves a live
  // HTTP handle and writer lock behind after main reports startup failure.
  const modelConcurrency = modelConcurrencyFromEnv()
  const ownerLease = await acquireTaskOwnership(paths, 'daemon', { waitMs: 10_000, staleMs: 8_000 })
  const heartbeat = startOwnershipHeartbeat(paths, ownerLease)

  try {
    await mkdir(paths.logsDir, { recursive: true })
    await writePatch(paths)
  } catch (error) {
    await heartbeat.stop()
    await releaseTaskOwnership(paths, ownerLease)
    throw error
  }

  const logger = createLogger({
    file: join(paths.logsDir, 'daemon.log'),
    echo: process.env.LIEBIAN_LOG_ECHO === '1',
  })
  const holder: { engine?: Engine } = {}
  let server: ApiServer
  try {
    server = await startApiServer({
      getEngine: () => holder.engine,
      logger: logger.child('api'),
    })
  } catch (error) {
    await heartbeat.stop()
    await releaseTaskOwnership(paths, ownerLease).catch(() => undefined)
    throw error
  }

  const provider = flagString(args, 'provider') ?? process.env.LIEBIAN_PROVIDER ?? 'deepseek-official'
  const model = flagString(args, 'model') ?? process.env.LIEBIAN_MODEL ?? 'deepseek-flash'
  // Validate before booting any executor so a bad value cannot silently fall
  // back to the default or leave half-started sessions behind.
  const driver = new SdkHarnessDriver({
    taskDir: paths.taskDir,
    patchFile: paths.patchFile,
    mcpEntry: MCP_ENTRY,
    logDir: paths.logsDir,
    daemonUrl: server.url,
    daemonToken: server.token,
    provider,
    model,
    logger: logger.child('harness'),
  })
  let engine: Engine
  try {
    engine = await Engine.open({ paths, driver, logger: logger.child('engine'), modelConcurrency })
    holder.engine = engine
    engine.recordDiagnostic('model-configuration', { provider, model, modelConcurrency })
    await writeDaemonInfo(paths, {
      url: server.url, token: server.token, pid: process.pid, taskId: paths.taskId,
    })
  } catch (error) {
    await holder.engine?.close('startup-failed').catch(() => undefined)
    await server.close().catch(() => undefined)
    await heartbeat.stop()
    await releaseTaskOwnership(paths, ownerLease).catch(() => undefined)
    throw error
  }

  let shuttingDown = false
  /** Stop writing immediately when the lease is proven lost (never save state). */
  const abandonOnLostOwnership = (): void => {
    logger.error('任务写入所有权已丢失（心跳租约被替换或过期）；停止运行时，避免成为第二个写入者')
    shuttingDown = true
    // Deliberately do not call engine.close(): its interruptedAt write would be
    // the second-writer write this guard exists to prevent.
    void driver
      .stopAll()
      .catch((error: unknown) => logger.warn(`停止 harness 进程失败：${describeError(error)}`))
      .finally(() => process.exit(70))
  }
  const ownershipWatch: NodeJS.Timeout = setInterval(() => {
    if (shuttingDown) return
    if (heartbeat.lost()) abandonOnLostOwnership()
  }, 1_000)
  ownershipWatch.unref?.()

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(ownershipWatch)
    logger.info(`关闭运行时：${reason}`)
    await engine.close(reason).catch((error: unknown) => logger.warn(`关闭 engine 失败：${describeError(error)}`))
    await server.close().catch(() => undefined)
    await removeDaemonInfo(paths)
    await heartbeat.stop()
    await releaseTaskOwnership(paths, ownerLease).catch(() => undefined)
    process.exit(exitCode)
  }

  engine.onTaskEnded = (status: TaskStatus) => {
    const timer = setTimeout(() => {
      process.stdout.write(`任务结束：${status}\n`)
      void shutdown(`task-${status}`, 0)
    }, 400)
    timer.unref?.()
  }

  process.on('SIGINT', () => {
    void shutdown('signal-int', 130)
  })
  process.on('SIGTERM', () => {
    void shutdown('signal-term', 143)
  })

  try {
    await engine.start()
  } catch (error) {
    logger.error(`运行时启动失败：${describeError(error)}`)
    await shutdown('start-failed', 1)
    throw error
  }
  process.stdout.write(
    `任务 ${paths.taskId} 运行中\n` +
      `API：${server.url}\n` +
      `模型：${provider}/${model}\n` +
      `模型请求并发：${modelConcurrency}\n` +
      `任务目录：${paths.taskDir}\n` +
      `日志：${join(paths.logsDir, 'daemon.log')}\n` +
      `按 Ctrl+C 保存中断状态；liebian status --task ${paths.taskId} 查看进度。\n`,
  )
}

async function commandSetEnd(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const text = await requiredInput(args, '终点信息 --file')
  const info = await readDaemonInfo(paths)
  if (info !== null) {
    try {
      const result = (await callDaemon(info, '/admin', 'task.set_end', { text })) as { text?: string }
      process.stdout.write(`${result.text ?? '终点信息已更新'}\n`)
      return
    } catch (error) {
      if (error instanceof AppError && error.code === 'DAEMON_NOT_RUNNING') throw error
      // fall through to offline edit
    }
  }
  const result = await withTaskOwnership(paths, async (engine) => {
    return engine.setEndInformation(text)
  })
  process.stdout.write(`${result.text}\n（运行时未在运行；通知已排队，下次 run 时投递。）\n`)
}

async function commandSetStart(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const text = await requiredInput(args, '起始信息 --file')
  const info = await readDaemonInfo(paths)
  if (info !== null) {
    try {
      const result = (await callDaemon(info, '/admin', 'task.set_start', { text })) as { text?: string }
      process.stdout.write(`${result.text ?? '起始信息已更新'}\n`)
      return
    } catch {
      // fall through
    }
  }
  const result = await withTaskOwnership(paths, async (engine) => {
    return engine.setStartInformation(text)
  })
  process.stdout.write(`${result.text}\n（运行时未在运行；通知已排队，下次 run 时投递。）\n`)
}

async function commandStop(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const reason = flagString(args, 'reason') ?? '用户手动停止'
  const info = await readDaemonInfo(paths)
  if (info !== null) {
    try {
      const result = (await callDaemon(info, '/admin', 'task.stop', { reason })) as { text?: string }
      process.stdout.write(`${result.text ?? '任务已停止'}\n`)
      return
    } catch {
      // fall through
    }
  }
  const result = await withTaskOwnership(paths, async (engine) => {
    return engine.stopTask(reason)
  })
  process.stdout.write(`${result.text}\n`)
}

/** Render commands and their per-work delivery status for the CLI. */
function renderCommandsText(commands: readonly CommandRecord[]): string {
  if (commands.length === 0) return '没有用户命令。'
  const sourceText: Record<CommandRecord['source'], string> = { web: 'Web UI', cli: 'CLI', api: 'API' }
  return commands
    .map((command) => {
      const deliveries = Object.values(command.deliveries)
      return (
        `${command.id}\t${command.createdAt}\t${sourceText[command.source]}\trequest=${command.requestId}\n` +
        `  ${command.text.replace(/\n/g, '\n  ')}\n` +
        `  投递：${
          deliveries.length === 0
            ? '（无收件 work）'
            : deliveries
                .map(
                  (delivery) =>
                    `${delivery.workId}=${COMMAND_DELIVERY_STATUS_TEXT[delivery.status]}` +
                    (delivery.enteredContextAt === undefined ? '' : `@${delivery.enteredContextAt}`),
                )
                .join('；')
        }`
      )
    })
    .join('\n')
}

/**
 * Send one task-level human command. The runtime must own the task directory:
 * an offline CLI never edits state just because a health check failed.
 */
async function commandSend(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const inlineText = flagString(args, 'text')
  if (inlineText === undefined && args.flags.get('file') === undefined) {
    throw new AppError('INVALID_ARGUMENT', '缺少命令输入：使用 --text 或 --file（--file - 读取 stdin）')
  }
  const text = inlineText ?? (await requiredInput(args, '命令 --file（或使用 --text）'))
  const requestId = requestIdFrom(args)
  const source = process.env.LIEBIAN_COMMAND_SOURCE === 'web' ? 'web' : 'cli'
  const info = await readDaemonInfo(paths)
  if (info === null) {
    throw new AppError(
      'RUNTIME_OFFLINE',
      `任务运行时未在运行；命令未保存。请先启动运行时，然后用同一 --request-id ${requestId} 重试。`,
    )
  }
  let result: { text?: string; command?: CommandRecord }
  try {
    result = (await callDaemon(
      info,
      '/admin',
      'task.command',
      { text, request_id: requestId, source },
      { timeoutMs: 30_000 },
    )) as { text?: string; command?: CommandRecord }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(
      'RUNTIME_OFFLINE',
      `无法连接任务运行时（${describeError(error)}）；命令未保存。请用同一 --request-id ${requestId} 重试。`,
    )
  }
  if (args.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${result.text ?? '命令已保存'}\n`)
  }
}

async function commandList(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const info = await readDaemonInfo(paths)
  let commands: CommandRecord[] | null = null
  if (info !== null) {
    try {
      const result = (await callDaemon(info, '/admin', 'commands.list', {}, { timeoutMs: 10_000 })) as {
        commands?: CommandRecord[]
      }
      commands = result.commands ?? []
    } catch {
      // Fall back to the persisted state; this is a read-only path.
    }
  }
  if (commands === null) {
    const state = await loadState(paths)
    commands = state.commands
  }
  if (args.flags.has('json')) {
    process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`)
    return
  }
  process.stdout.write(`${renderCommandsText(commands)}\n`)
}

/**
 * Continue an ended task as a new run. The state edit is offline (the ended
 * runtime must be gone); starting the new turn is done by the Web UI or by
 * `docker compose up`.
 */
async function commandContinue(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const inlineText = flagString(args, 'text')
  if (inlineText === undefined && args.flags.get('file') === undefined) {
    throw new AppError('INVALID_ARGUMENT', '缺少继续指令：使用 --text 或 --file（--file - 读取 stdin）')
  }
  const text = inlineText ?? (await requiredInput(args, '继续指令 --file（或使用 --text）'))
  const requestId = requestIdFrom(args)
  const state = await loadState(paths)
  if (state.status === 'active') {
    throw new AppError(
      'TASK_ACTIVE',
      '任务正在进行中，不能继续；请用 liebian command 发送要求，或先停止任务。',
    )
  }
  const info = await readDaemonInfo(paths)
  if (info !== null) {
    const alive = await daemonAlive(info)
    if (alive) {
      throw new AppError('ALREADY_RUNNING', '任务运行时仍在运行；请先停止运行时，再用同一 --request-id 重试继续。')
    }
  }
  const result = await withTaskOwnership(paths, async (engine) => {
    return engine.continueTask({
      text,
      requestId,
      source: 'cli',
      executionsStopped: true,
    })
  })
  if (args.flags.has('json')) {
    process.stdout.write(
      `${JSON.stringify({ run: result.run, work: result.work, command: result.command, idempotent: result.idempotent }, null, 2)}\n`,
    )
    return
  }
  process.stdout.write(
    `${result.text}\n\n` +
      `下一步：在 Web UI 启动任务，或执行 docker compose up -d task-${paths.taskId}。\n` +
      `同一 request ID 重试不会再次创建轮次：${requestId}\n`,
  )
}

/** Create a takeover work for an active task with no participants. */
async function commandRecover(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const requestId = requestIdFrom(args)
  const state = await loadState(paths)
  if (state.status !== 'active') {
    throw new AppError('TASK_NOT_ACTIVE', `任务状态为 ${state.status}；恢复只用于 active 任务，已结束任务请用 liebian continue。`)
  }
  const info = await readDaemonInfo(paths)
  if (info !== null) {
    try {
      const result = (await callDaemon(
        info,
        '/admin',
        'task.recover',
        { request_id: requestId, source: 'cli' },
        { timeoutMs: 30_000 },
      )) as { text?: string; work?: { id?: string } }
      process.stdout.write(`${result.text ?? '恢复请求已提交'}\n`)
      return
    } catch (error) {
      // A stale descriptor is handled by the ownership lease below; a live
      // daemon keeps its heartbeat and therefore blocks the offline path.
      if (error instanceof AppError && error.code !== 'DAEMON_NOT_RUNNING') {
        // Fall through only for transport failures; protocol errors are final.
        if (!['ECONNREFUSED', 'RUNTIME_CLOSED'].includes(error.code)) throw error
      }
    }
  }
  const result = await withTaskOwnership(paths, async (engine) => {
    return engine.recoverTask({ requestId, source: 'cli' })
  })
  process.stdout.write(`${result.text}\n`)
  if (result.created) {
    process.stdout.write(
      `下一步：在 Web UI 启动任务，或执行 docker compose up -d task-${paths.taskId}。\n`,
    )
  }
}


async function commandWeb(args: ParsedArgs): Promise<void> {
  const tasksRoot = resolve(flagString(args, 'tasks-dir') ?? defaultTasksRoot())
  const port = parsePort(flagString(args, 'port') ?? process.env.LIEBIAN_WEB_PORT ?? DEFAULT_WEB_PORT, true)
  // Host networking uses this bind address directly on Windows and Linux.
  const host = flagString(args, 'host') ?? process.env.LIEBIAN_WEB_HOST ?? '127.0.0.1'
  if (host.trim().length === 0) throw new AppError('INVALID_ARGUMENT', '--host 不能为空')
  await mkdir(tasksRoot, { recursive: true })
  const logger = createLogger({
    file: join(tasksRoot, 'web.log'),
    echo: process.env.LIEBIAN_LOG_ECHO === '1',
  })
  const server = await startWebServer({ tasksRoot, logger: logger.child('web'), port, host })
  const publicBase = (process.env.LIEBIAN_WEB_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  const authUrl = `${publicBase.length > 0 ? publicBase : server.url}/?token=${encodeURIComponent(server.token)}`
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'

  process.stdout.write(
    `Nexora Web UI\n` +
      `监听：${host}:${port}\n` +
      `地址：${server.url}\n` +
      `访问令牌：${server.token}\n` +
      `带令牌的入口：${authUrl}\n` +
      `任务目录：${tasksRoot}\n` +
      `启动模式：Docker Compose 任务服务\n` +
      (loopback
        ? `只监听 127.0.0.1；令牌等同于本机控制权限，请勿粘贴到不可信页面。\n`
        : `已监听非回环地址；拿到令牌的访问者可以完全控制任务，请只在本机端口映射下使用。\n`) +
      `按 Ctrl+C 关闭 Web UI（不会停止已在运行的任务运行时）。\n`,
  )

  let closing = false
  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    process.stdout.write('\n正在关闭 Web UI…\n')
    await server.close().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

async function commandMessages(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const state = await loadState(paths)
  if (state.messages.length === 0) {
    process.stdout.write('没有消息。\n')
    return
  }
  for (const message of state.messages) {
    const from = message.system ? '运行时' : message.fromWorkId
    process.stdout.write(
      `${message.id}\t${message.createdAt}\t${from} -> ${message.toWorkId}\t${message.kind}\t${message.status}\n` +
        `  ${message.body.replace(/\n/g, '\n  ')}\n`,
    )
  }
}

async function commandPrintFile(args: ParsedArgs, kind: 'findings' | 'works'): Promise<void> {
  const paths = await taskPathsFrom(args)
  const content = await readTextIfExists(kind === 'findings' ? paths.findingsFile : paths.worksFile)
  process.stdout.write(content ?? `（${kind}.md 尚未生成）\n`)
}

/** Print the current effective findings, or the complete append-only log. */
async function commandFindings(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const state = await loadState(paths)
  if (args.flags.has('history') || args.flags.has('all')) {
    const content = await readTextIfExists(paths.findingsFile)
    process.stdout.write(
      `# findings.md（完整追加日志，含已被替代的旧结论）\n\n${content ?? '（尚未生成）\n'}`,
    )
    return
  }
  const index = buildFindingsIndex(state.findings)
  const current = index.currentIds.flatMap((id) => {
    const finding = index.byId.get(id)
    return finding === undefined ? [] : [finding]
  })
  process.stdout.write(`${renderCurrentFindingsHeader(state, current.length, state.findings.length)}\n`)
  process.stdout.write(current.map((finding) => renderFindingBlock(finding)).join('\n'))
}

/** Print the current published report for one key. */
async function commandReport(args: ParsedArgs): Promise<void> {
  const paths = await taskPathsFrom(args)
  const state = await loadState(paths)
  const key = normalizeReportKey(flagString(args, 'key'))
  const report = state.reports?.[key]
  if (report === undefined) {
    const known = Object.keys(state.reports ?? {}).sort()
    process.stdout.write(`报告 ${key} 尚未发布。${known.length === 0 ? '' : `已登记：${known.join(', ')}`}\n`)
    return
  }
  const content = await readTextIfExists(join(paths.taskDir, report.contentFile))
  process.stdout.write(`${renderReportMeta(report)}\n${content ?? '（已提交内容文件缺失）\n'}`)
}

async function main(argv: string[]): Promise<void> {
  ensureRepoLocalDshHome()
  const args = parseArgs(argv)
  const [command, subcommand] = args.positionals
  if (command === undefined || command === 'help' || args.flags.has('help')) {
    process.stdout.write(USAGE)
    return
  }
  switch (command) {
    case 'task':
      if (subcommand === 'new') return commandTaskNew(args)
      if (subcommand === 'list') return commandTaskList(args)
      throw new AppError('INVALID_ARGUMENT', `未知 task 子命令：${String(subcommand)}`)
    case 'run':
      return commandRun(args)
    case 'status':
      return commandStatus(args)
    case 'set-end':
      return commandSetEnd(args)
    case 'set-start':
      return commandSetStart(args)
    case 'command':
      return commandSend(args)
    case 'commands':
      return commandList(args)
    case 'continue':
      return commandContinue(args)
    case 'recover':
      return commandRecover(args)
    case 'stop':
      return commandStop(args)
    case 'web':
      return commandWeb(args)
    case 'messages':
      return commandMessages(args)
    case 'findings':
      return commandFindings(args)
    case 'report':
      return commandReport(args)
    case 'works':
      return commandPrintFile(args, 'works')
    default:
      throw new AppError('INVALID_ARGUMENT', `未知命令：${command}\n\n${USAGE}`)
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', describeError(error))
  process.stderr.write(`错误 [${appError.code}]：${appError.message}\n`)
  process.exitCode = 1
})
