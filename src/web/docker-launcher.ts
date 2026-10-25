/**
 * Compose launcher for the Web UI.
 *
 * The Web UI never starts a task with `docker run` anymore: it writes one
 * service into the generated `compose/tasks.yaml`, then runs `docker compose up`
 * for that service. The service belongs to the same `liebian` Compose project
 * as the Web UI, so the host's `docker compose ps/down/up` covers web and tasks
 * together.
 *
 * Web and Task services share host networking. The authenticated loopback API
 * is reachable directly; existing lifecycle CLI calls also use docker exec.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTaskPaths, type TaskPaths } from '../core/paths.ts'
import { loadState } from '../core/state.ts'
import { writeFileAtomic } from '../util/atomic.ts'
import { AppError, describeError } from '../util/errors.ts'
import { isValidTaskId } from '../util/ids.ts'
import type { Logger } from '../util/log.ts'
import { Mutex } from '../util/mutex.ts'
import { effectiveWebSettings } from './settings.ts'
import { readDaemonInfo, callDaemon } from '../core/daemon.ts'
import { taskStartTimeout, waitForRuntimeReady } from './readiness.ts'

export interface DockerStartResult {
  pid: number
}

/**
 * Serialize every read-modify-write of `compose/tasks.yaml`. Two concurrent
 * starts (or a start racing a delete) must not overwrite each other's service,
 * otherwise a running container would disappear from Compose management.
 */
const tasksComposeLock = new Mutex()
/** Never let a wedged docker CLI hang an HTTP request forever. */
const DOCKER_TIMEOUT_MS = 120_000

export function composeWebMode(): boolean {
  const mode = process.env.LIEBIAN_WEB_LAUNCHER
  return mode === 'compose' || mode === 'docker'
}

export function dockerContainerName(taskId: string): string {
  return `${process.env.LIEBIAN_CONTAINER_PREFIX ?? 'liebian'}-${taskId}`
}

function dockerBin(): string {
  return process.env.LIEBIAN_DOCKER_BIN ?? 'docker'
}

function image(): string {
  return process.env.LIEBIAN_IMAGE ?? 'liebian:latest'
}

function dshHome(paths: TaskPaths): string {
  // Container mode sets DSH_HOME (=/dsh-home); the CLI sets it to the repo
  // .dsh in host mode. LIEBIAN_DSH_HOME remains the launcher-specific override.
  return process.env.LIEBIAN_DSH_HOME ?? process.env.DSH_HOME ?? resolve(paths.tasksRoot, '..', '.dsh')
}

function composeFile(): string {
  const configured = (process.env.LIEBIAN_COMPOSE_FILE ?? '').trim()
  if (configured.length > 0) return configured
  return fileURLToPath(new URL('../../compose.yaml', import.meta.url))
}

function tasksComposeFile(): string {
  const configured = (process.env.LIEBIAN_TASKS_COMPOSE_FILE ?? '').trim()
  if (configured.length > 0) return configured
  return fileURLToPath(new URL('../../compose/tasks.yaml', import.meta.url))
}

function composeProject(): string {
  return (process.env.LIEBIAN_COMPOSE_PROJECT ?? '').trim() || 'liebian'
}

function taskServiceName(taskId: string): string {
  return `task-${taskId}`
}

function composeArgs(args: string[]): string[] {
  return ['compose', '--project-name', composeProject(), '--file', composeFile(), ...args]
}

/**
 * When the Web UI itself runs in a container, a sibling Task container cannot
 * be given the Web UI's own container paths as bind sources: the Docker daemon
 * resolves them on the host. The sources are recovered from the Web UI
 * container's own mounts, so users only ever configure the relative paths in
 * compose (`./tasks`, `./.dsh`).
 */
const DOCKER_SOCKET = process.env.LIEBIAN_DOCKER_SOCKET ?? '/var/run/docker.sock'
let cachedSelfMounts: Map<string, string> | null | undefined

function runningInContainer(): boolean {
  return process.env.LIEBIAN_WEB_IN_CONTAINER === '1' || existsSync('/.dockerenv')
}

async function selfMountSources(): Promise<Map<string, string> | null> {
  if (cachedSelfMounts !== undefined) return cachedSelfMounts
  if (!existsSync(DOCKER_SOCKET)) {
    cachedSelfMounts = null
    return null
  }
  const name = (process.env.LIEBIAN_WEB_CONTAINER ?? '').trim() || hostname()
  try {
    const output = await dockerOutput(['inspect', '-f', '{{json .Mounts}}', name])
    const parsed = JSON.parse(output) as { Destination?: unknown; Source?: unknown }[]
    if (!Array.isArray(parsed)) return null
    const mounts = new Map<string, string>()
    for (const mount of parsed) {
      if (typeof mount.Destination === 'string' && typeof mount.Source === 'string') {
        mounts.set(resolve(mount.Destination), mount.Source)
      }
    }
    cachedSelfMounts = mounts
    return mounts
  } catch {
    // Do not cache a transient failure (for example the socket not being ready
    // yet); the next start attempt retries.
    return null
  }
}

/** Join a host path, keeping the separator style the host reported. */
export function joinHostPath(base: string, name: string): string {
  if (/^[A-Za-z]:[\\/]/.test(base) || base.startsWith('\\\\')) {
    return `${base.replace(/[\\/]+$/, '').replace(/\//g, '\\')}\\${name}`
  }
  return `${base.replace(/\/+$/, '')}/${name}`
}

/** Docker accepts forward slashes for Windows host paths; compose is happier. */
export function toComposePath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** Compose interpolates `$` in string values; `$$` keeps a literal dollar. */
function composeLiteral(value: string): string {
  return value.replace(/\$/g, () => '$$')
}

export interface HostBinds {
  /** Host path that becomes `/tasks/<id>` in the Task container. */
  taskDir: string
  /** Host path that becomes `/dsh-home` in the Task container. */
  dshHome: string
}

/**
 * Resolve the host-side bind sources for a Task container.
 *
 * Returns null when the Web UI is not running in a container (normal host
 * mode). `LIEBIAN_HOST_TASKS_DIR` / `LIEBIAN_HOST_DSH_HOME` override detection
 * for unusual deployments where the socket cannot be inspected.
 */
export async function resolveHostBinds(paths: TaskPaths, home: string): Promise<HostBinds | null> {
  const tasksOverride = (process.env.LIEBIAN_HOST_TASKS_DIR ?? '').trim()
  const dshOverride = (process.env.LIEBIAN_HOST_DSH_HOME ?? '').trim()
  if (tasksOverride.length > 0 && dshOverride.length > 0) {
    return { taskDir: joinHostPath(tasksOverride, paths.taskId), dshHome: dshOverride }
  }
  const mounts = await selfMountSources()
  if (mounts === null) return null
  const tasksSource = mounts.get(resolve(paths.tasksRoot))
  const dshSource = mounts.get(resolve(home))
  if (tasksSource === undefined || dshSource === undefined) return null
  return { taskDir: joinHostPath(tasksSource, paths.taskId), dshHome: dshSource }
}

export interface ComposeTaskService {
  network_mode: 'host'
  image: string
  container_name: string
  command: string[]
  user: string
  cap_add: string[]
  restart: string
  stop_grace_period: string
  volumes: string[]
  environment: Record<string, string>
}

export interface TaskServiceOptions {
  taskId: string
  taskHostDir: string
  dshHostDir: string
  image: string
  environment: NodeJS.ProcessEnv
}

/** Environment values worth forwarding to the Task container. */
const PASSTHROUGH_ENV = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'LIEBIAN_PROVIDER',
  'LIEBIAN_MODEL',
  'LIEBIAN_MODEL_CONCURRENCY',
  'LIEBIAN_MODEL_STREAM_IDLE_MS',
  'LIEBIAN_DIAGNOSTICS_INTERVAL_MS',
  'LIEBIAN_DIAGNOSTICS_MAX_BYTES',
  'LIEBIAN_DIAGNOSTICS_FILES',
  'LIEBIAN_API_PORT_RANGE',
  'LIEBIAN_CALLBACK_HOST',
  'DSH_TELEMETRY_DISABLED',
  'LIEBIAN_LOG_ECHO',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]

/** Pure builder for one generated Compose service. */
export function buildTaskService(options: TaskServiceOptions): ComposeTaskService {
  const environment: Record<string, string> = {
    DSH_HOME: '/dsh-home',
    LIEBIAN_TASKS_DIR: '/tasks',
    LIEBIAN_TASK_ID: options.taskId,
  }
  for (const name of PASSTHROUGH_ENV) {
    const value = options.environment[name]
    if (value !== undefined && value.length > 0) environment[name] = composeLiteral(value)
  }
  return {
    network_mode: 'host',
    image: options.image,
    container_name: dockerContainerName(options.taskId),
    command: ['run', '--task', options.taskId],
    user: '0:0',
    cap_add: ['NET_RAW', 'NET_ADMIN'],
    restart: 'no',
    stop_grace_period: '30s',
    volumes: [
      `${composeLiteral(toComposePath(options.taskHostDir))}:/tasks/${options.taskId}`,
      `${composeLiteral(toComposePath(options.dshHostDir))}:/dsh-home`,
    ],
    environment,
  }
}

export interface TasksCompose {
  services: Record<string, ComposeTaskService>
}

/**
 * The generated file is JSON (valid YAML) to avoid hand-rolled YAML escaping.
 * An empty or missing file means "no task services".
 */
export async function readTasksCompose(): Promise<TasksCompose> {
  const file = tasksComposeFile()
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null || raw.trim().length === 0) return { services: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError(
      'COMPOSE_FILE_INVALID',
      `${file} 不是合法的生成文件；请将它重置为 {"services": {}} 或删除后重启 Web UI。`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('COMPOSE_FILE_INVALID', `${file} 的顶层必须是对象。`)
  }
  const services = (parsed as Record<string, unknown>).services
  if (services === undefined) return { services: {} }
  if (typeof services !== 'object' || services === null || Array.isArray(services)) {
    throw new AppError('COMPOSE_FILE_INVALID', `${file} 的 services 必须是对象。`)
  }
  return { services: services as Record<string, ComposeTaskService> }
}

async function writeTasksCompose(data: TasksCompose): Promise<void> {
  const file = tasksComposeFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
  // The file can contain API keys; keep it private where the filesystem allows.
  await chmod(file, 0o600).catch(() => undefined)
}

export async function upsertTaskService(taskId: string, service: ComposeTaskService): Promise<void> {
  await tasksComposeLock.run(async () => {
    const data = await readTasksCompose()
    data.services[taskServiceName(taskId)] = service
    await writeTasksCompose(data)
  })
}

export async function removeTaskService(taskId: string): Promise<void> {
  await tasksComposeLock.run(async () => {
    const data = await readTasksCompose()
    const name = taskServiceName(taskId)
    if (data.services[name] === undefined) return
    delete data.services[name]
    await writeTasksCompose(data)
  })
}

function runDocker(
  args: string[],
  stdio: 'pipe' | ['ignore', number, number],
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(dockerBin(), args, {
      stdio,
      windowsHide: true,
      env,
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new AppError('DOCKER_TIMEOUT', `docker 命令超时（${args.join(' ')}）`))
    }, DOCKER_TIMEOUT_MS)
    timer.unref?.()
    let stdout = ''
    let stderr = ''
    if (child.stdout !== null) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
    }
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new AppError('DOCKER_LAUNCH_FAILED', `无法执行 docker：${describeError(error)}`))
    })
    if (child.stdin !== null) {
      child.stdin.end(input)
    }
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise(0)
        return
      }
      reject(
        new AppError(
          'DOCKER_COMMAND_FAILED',
          `docker 命令失败（code=${String(code)}, signal=${String(signal)}）：${stderr.trim().slice(-800) || stdout.trim().slice(-800)}`,
          { args },
        ),
      )
    })
  })
}

function runCompose(
  args: string[],
  stdio: 'pipe' | ['ignore', number, number],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return runDocker(composeArgs(args), stdio, undefined, env)
}

async function dockerOutput(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(dockerBin(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new AppError('DOCKER_TIMEOUT', `docker 命令超时（${args.join(' ')}）`))
    }, DOCKER_TIMEOUT_MS)
    timer.unref?.()
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new AppError('DOCKER_LAUNCH_FAILED', `无法执行 docker：${describeError(error)}`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else reject(new AppError('DOCKER_COMMAND_FAILED', `docker 命令失败：${stderr.trim().slice(-800)}`))
    })
  })
}

async function containerRunning(name: string): Promise<boolean> {
  try {
    const output = await dockerOutput(['inspect', '-f', '{{.State.Running}}', name])
    return output.trim() === 'true'
  } catch {
    return false
  }
}

/** True when the Task's container is running. */
export async function dockerTaskRunning(paths: TaskPaths): Promise<boolean> {
  return containerRunning(dockerContainerName(paths.taskId))
}

/** Stop and remove a Task service/container, tolerating an already-absent one. */
async function removeComposeTask(taskId: string): Promise<void> {
  const name = taskServiceName(taskId)
  try {
    await runCompose(['rm', '--force', '--stop', name], 'pipe')
  } catch {
    // The service may already be gone from the generated file; make sure the
    // container name does not linger.
    await runDocker(['rm', '-f', dockerContainerName(taskId)], 'pipe').catch(() => undefined)
  }
}

/** Remove a stopped Task container when deleting the task directory. */
export async function removeDockerTaskContainer(paths: TaskPaths): Promise<void> {
  await removeComposeTask(paths.taskId).catch(() => undefined)
  await removeTaskService(paths.taskId).catch(() => undefined)
}

async function removeStoppedContainer(name: string): Promise<void> {
  try {
    await dockerOutput(['inspect', name])
  } catch {
    return
  }
  if (await containerRunning(name)) {
    throw new AppError('ALREADY_RUNNING', `任务容器已在运行：${name}`)
  }
  await runDocker(['rm', '-f', name], 'pipe').catch(() => undefined)
}

/** Start one Task, await its authenticated API, and return its runtime PID. */
export async function startDockerTask(paths: TaskPaths, logger?: Logger): Promise<DockerStartResult> {
  const timeoutMs = taskStartTimeout()
  const previousToken = (await readDaemonInfo(paths))?.token
  const name = dockerContainerName(paths.taskId)
  if (await containerRunning(name)) {
    throw new AppError('ALREADY_RUNNING', `任务容器已在运行：${name}`)
  }
  await removeStoppedContainer(name)
  await mkdir(paths.logsDir, { recursive: true })
  const settings = await effectiveWebSettings(paths.tasksRoot)
  const containerEnv: NodeJS.ProcessEnv = { ...process.env }
  if (settings.apiKey.length > 0) containerEnv.DEEPSEEK_API_KEY = settings.apiKey
  if (settings.provider.length > 0) containerEnv.LIEBIAN_PROVIDER = settings.provider
  if (settings.model.length > 0) containerEnv.LIEBIAN_MODEL = settings.model
  if (settings.baseUrl.length > 0) containerEnv.DEEPSEEK_BASE_URL = settings.baseUrl
  containerEnv.LIEBIAN_MODEL_CONCURRENCY = String(settings.modelConcurrency)

  const home = dshHome(paths)
  await mkdir(home, { recursive: true })
  const binds = await resolveHostBinds(paths, home)
  if (binds === null && runningInContainer()) {
    throw new AppError(
      'DOCKER_BIND_UNRESOLVED',
      'Web UI 运行在容器内，但无法从它自己的挂载中解析 /tasks 与 /dsh-home 的宿主机路径。' +
        '请挂载 Docker socket，并保持 compose 中的 ./tasks、./.dsh 挂载；' +
        '或者设置 LIEBIAN_HOST_TASKS_DIR 与 LIEBIAN_HOST_DSH_HOME。',
    )
  }
  const service = buildTaskService({
    taskId: paths.taskId,
    taskHostDir: binds?.taskDir ?? paths.taskDir,
    dshHostDir: binds?.dshHome ?? home,
    image: image(),
    environment: containerEnv,
  })
  await upsertTaskService(paths.taskId, service)

  const runLog = await open(join(paths.logsDir, 'run.out.log'), 'a')
  try {
    await runCompose(['up', '--detach', taskServiceName(paths.taskId)], ['ignore', runLog.fd, runLog.fd], containerEnv)
  } catch (error) {
    await removeComposeTask(paths.taskId).catch(() => undefined)
    await removeTaskService(paths.taskId).catch(() => undefined)
    throw error
  } finally {
    await runLog.close().catch(() => undefined)
  }
  try {
    return await waitForRuntimeReady({
      timeoutMs,
      running: () => containerRunning(name),
      probe: async () => {
        const info = await readDaemonInfo(paths)
        if (info === null || info.taskId !== paths.taskId || info.token === previousToken) return null
        try {
          const snapshot = await callDaemon(info, '/admin', 'task.status', {}, { timeoutMs: 1000 }) as { task?: { taskId?: string } }
          return snapshot.task?.taskId === paths.taskId ? { pid: info.pid } : null
        } catch { return null }
      },
    })
  } catch (error) {
    const logs = await runDockerCapture(['logs', '--tail', '30', name], '').catch(() => null)
    const diagnostics = logs === null ? '' : `${logs.stdout}\n${logs.stderr}`
    logger?.warn(`任务启动失败：${describeError(error)}`)
    // Preserve the active run and its logs for retry, but stop the failed start
    // so it cannot become a second writer after the UI reports failure.
    await removeComposeTask(paths.taskId).catch(() => undefined)
    await removeTaskService(paths.taskId).catch(() => undefined)
    throw new AppError(error instanceof AppError ? error.code : 'TASK_START_FAILED',
      `${describeError(error)}${diagnostics.trim() ? `\n${diagnostics.trim().slice(-2000)}` : ''}\n详情见 runtime/logs/run.out.log 与 daemon.log`)
  }
}

/** Stop a Task through its own runtime, then remove its Compose service. */
export async function stopDockerTask(paths: TaskPaths, reason: string, logger?: Logger): Promise<boolean> {
  const name = dockerContainerName(paths.taskId)
  if (!(await containerRunning(name))) {
    await removeComposeTask(paths.taskId).catch(() => undefined)
    await removeTaskService(paths.taskId).catch(() => undefined)
    return false
  }
  try {
    await runDocker(['exec', name, 'liebian', 'stop', '--task', paths.taskId, '--reason', reason], 'pipe')
  } catch (error) {
    logger?.warn(`容器内 stop 失败，尝试 compose stop：${describeError(error)}`)
    try {
      await runCompose(['stop', taskServiceName(paths.taskId)], 'pipe')
    } catch (stopError) {
      logger?.warn(`compose stop 失败：${describeError(stopError)}`)
    }
  }
  await removeComposeTask(paths.taskId).catch(() => undefined)
  await removeTaskService(paths.taskId).catch(() => undefined)
  // `docker exec ... stop` should have committed `stopped` before exiting. If
  // the container had to be killed instead, the authoritative state may still
  // say active; report that so the caller can take the offline-lease path.
  const state = await loadState(paths).catch(() => null)
  if (state !== null && state.status === 'active') {
    logger?.warn('容器已停止，但权威状态仍为 active；将交由离线写入完成停止')
    return false
  }
  return true
}

/**
 * Make sure no container process is left writing this task directory, without
 * changing task state. Used before an offline "continue" so a new run can
 * never overlap the previous run's managed execution.
 *
 * Returns true when a running container was stopped.
 */
export async function stopDockerTaskContainer(paths: TaskPaths, logger?: Logger): Promise<boolean> {
  const name = dockerContainerName(paths.taskId)
  if (!(await containerRunning(name))) {
    await removeComposeTask(paths.taskId).catch(() => undefined)
    await removeTaskService(paths.taskId).catch(() => undefined)
    return false
  }
  try {
    await runCompose(['stop', taskServiceName(paths.taskId)], 'pipe')
  } catch (error) {
    logger?.warn(`compose stop 失败，尝试 docker stop：${describeError(error)}`)
    await runDocker(['stop', name], 'pipe').catch(() => undefined)
  }
  await removeComposeTask(paths.taskId).catch(() => undefined)
  await removeTaskService(paths.taskId).catch(() => undefined)
  return true
}

/** Update start/end information inside a live Task container. */
export async function setDockerTaskInformation(
  paths: TaskPaths,
  op: 'set-end' | 'set-start',
  text: string,
  logger?: Logger,
): Promise<boolean> {
  const name = dockerContainerName(paths.taskId)
  if (!(await containerRunning(name))) return false
  try {
    await runDocker(
      ['exec', '-i', name, 'liebian', op, '--task', paths.taskId, '--file', '-'],
      'pipe',
      text,
    )
    return true
  } catch (error) {
    logger?.warn(`容器内 ${op} 失败：${describeError(error)}`)
    return false
  }
}

/** A captured docker command result (stdout/stderr), used for CLI output. */
function runDockerCapture(
  args: string[],
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(dockerBin(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new AppError('DOCKER_TIMEOUT', `docker 命令超时（${args.join(' ')}）`))
    }, DOCKER_TIMEOUT_MS)
    timer.unref?.()
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new AppError('DOCKER_LAUNCH_FAILED', `无法执行 docker：${describeError(error)}`))
    })
    child.stdin?.end(input)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * Send a task-level command into a live Task container. The container CLI
 * talks to the container's loopback admin API, which keeps the runtime the
 * only writer of `state.json`; a dead daemon surfaces as a non-zero exit rather
 * than an offline state edit.
 */
export async function sendDockerTaskCommand(
  paths: TaskPaths,
  text: string,
  requestId: string,
  logger?: Logger,
): Promise<{ text: string } | null> {
  const name = dockerContainerName(paths.taskId)
  if (!(await containerRunning(name))) return null
  const result = await runDockerCapture(
    [
      'exec',
      '-e',
      'LIEBIAN_COMMAND_SOURCE=web',
      '-i',
      name,
      'liebian',
      'command',
      '--task',
      paths.taskId,
      '--file',
      '-',
      '--request-id',
      requestId,
    ],
    text,
  )
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-800)
    logger?.warn(`容器内命令投递失败：${detail}`)
    const code = detail.includes('RUNTIME_OFFLINE') ? 'RUNTIME_OFFLINE' : 'COMMAND_DELIVERY_FAILED'
    throw new AppError(code, `容器内命令投递失败：${detail || '未知错误'}`)
  }
  return { text: result.stdout.trim() }
}

/**
 * Drop generated services for tasks that are no longer active. Runs at Web UI
 * startup and periodically, so a completed/stopped task does not get restarted
 * by the next `docker compose up` and the host's `compose down` does not wait
 * for stale services.
 */
export async function reconcileTaskServices(tasksRoot: string, logger?: Logger): Promise<void> {
  if (!composeWebMode()) return
  let data: TasksCompose
  try {
    data = await readTasksCompose()
  } catch (error) {
    logger?.warn(`读取 compose 任务文件失败：${describeError(error)}`)
    return
  }
  const serviceNames = Object.keys(data.services)
  if (serviceNames.length === 0) return

  const active = new Set<string>()
  const unknown = new Set<string>()
  const entries = await readdir(tasksRoot, { withFileTypes: true }).catch((error: unknown) => {
    // Never treat an unreadable tasks root as "no tasks": every service would
    // be removed and its running container force-killed.
    logger?.warn(`读取任务目录失败，跳过本次 compose service 回收：${describeError(error)}`)
    return null
  })
  if (entries === null) return
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidTaskId(entry.name)) continue
    const paths = makeTaskPaths(tasksRoot, entry.name)
    const state = await loadState(paths).catch(() => null)
    if (state === null) {
      // The directory exists but the state is unreadable (for example a
      // transient read during an atomic replace). Keep the service rather than
      // risking removal of a live task.
      unknown.add(entry.name)
      continue
    }
    if (state.status === 'active') active.add(entry.name)
  }

  for (const serviceName of serviceNames) {
    if (!serviceName.startsWith('task-')) continue
    const taskId = serviceName.slice('task-'.length)
    if (active.has(taskId) || unknown.has(taskId)) continue
    logger?.info(`回收非进行中任务的 compose service：${serviceName}`)
    await removeComposeTask(taskId).catch(() => undefined)
    await removeTaskService(taskId).catch(() => undefined)
  }
}
