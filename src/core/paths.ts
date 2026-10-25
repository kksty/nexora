/** Filesystem layout for one task, per docs/ARCHITECTURE.md. */

import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isValidTaskId } from '../util/ids.ts'
import { AppError } from '../util/errors.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export interface TaskPaths {
  /** Directory containing every task (`<repo>/tasks` by default). */
  readonly tasksRoot: string
  readonly taskId: string
  readonly taskDir: string
  readonly taskFile: string
  readonly findingsFile: string
  readonly worksFile: string
  readonly evidenceDir: string
  readonly runtimeDir: string
  readonly stateFile: string
  readonly journalFile: string
  readonly daemonFile: string
  readonly ownerFile: string
  readonly patchFile: string
  readonly sessionsDir: string
  readonly consensusDir: string
  readonly reportsDir: string
  readonly logsDir: string
}

/**
 * Default tasks root, overridable with `LIEBIAN_TASKS_DIR`.
 *
 * Host-side data stays inside the repository by default, regardless of the
 * process working directory. Pass `--tasks-dir` for an explicit location.
 */
export function defaultTasksRoot(): string {
  const configured = process.env.LIEBIAN_TASKS_DIR
  return configured === undefined || configured.length === 0 ? resolve(REPO_ROOT, 'tasks') : resolve(configured)
}

/** Build the path bundle for a task id under a tasks root. */
export function makeTaskPaths(tasksRoot: string, taskId: string): TaskPaths {
  if (!isValidTaskId(taskId)) throw new AppError('INVALID_ARGUMENT', `非法任务 ID：${taskId}`)
  const taskDir = join(resolve(tasksRoot), taskId)
  const runtimeDir = join(taskDir, 'runtime')
  return {
    tasksRoot: resolve(tasksRoot),
    taskId,
    taskDir,
    taskFile: join(taskDir, 'task.md'),
    findingsFile: join(taskDir, 'findings.md'),
    worksFile: join(taskDir, 'works.md'),
    evidenceDir: join(taskDir, 'evidence'),
    runtimeDir,
    stateFile: join(runtimeDir, 'state.json'),
    journalFile: join(runtimeDir, 'journal.jsonl'),
    daemonFile: join(runtimeDir, 'daemon.json'),
    ownerFile: join(runtimeDir, 'owner.json'),
    patchFile: join(runtimeDir, 'harness.patch.yml'),
    sessionsDir: join(runtimeDir, 'sessions'),
    consensusDir: join(runtimeDir, 'consensus'),
    reportsDir: join(runtimeDir, 'reports'),
    logsDir: join(runtimeDir, 'logs'),
  }
}

function containsPath(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent)
  const normalizedChild = resolve(child)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + sep)
}

/**
 * Resolve a user-supplied task reference.
 *
 * An existing directory is accepted directly (so a task may live outside the
 * default root), otherwise the value is treated as a task id under the tasks
 * root. Paths outside the tasks root are allowed only when the directory
 * already exists and contains a task state file.
 */
export async function resolveTaskPaths(input: string, tasksRoot = defaultTasksRoot()): Promise<TaskPaths> {
  const { stat } = await import('node:fs/promises')
  const absolute = resolve(input)
  const candidate = await stat(absolute).catch(() => null)
  if (candidate?.isDirectory()) {
    const stateFile = join(absolute, 'runtime', 'state.json')
    const stateExists = await stat(stateFile).catch(() => null)
    if (stateExists === null) throw new AppError('TASK_NOT_FOUND', `目录不是已初始化的任务：${absolute}`)
    return makeTaskPaths(dirname(absolute), basename(absolute))
  }
  if (containsPath(tasksRoot, join(tasksRoot, input)) && isValidTaskId(input)) {
    const candidatePaths = makeTaskPaths(tasksRoot, input)
    const directory = await stat(candidatePaths.taskDir).catch(() => null)
    if (directory?.isDirectory()) return candidatePaths
  }
  throw new AppError('TASK_NOT_FOUND', `找不到任务：${input}`)
}
