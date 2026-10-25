/**
 * Task creation and one-time file materialization.
 */

import { mkdir } from 'node:fs/promises'
import { appendFileDurable, ensureDir, writeFileAtomic } from '../util/atomic.ts'
import { AppError } from '../util/errors.ts'
import { nowIso } from '../util/time.ts'
import type { RuntimeState } from '../types.ts'
import type { TaskPaths } from './paths.ts'
import { renderFindingsHeader, renderTaskMarkdown, renderWorksMarkdown } from './render.ts'
import { createInitialState, saveState } from './state.ts'

export interface CreateTaskInput {
  startInformation: string
  endInformation: string
  at?: string
}

/** Create every directory and shared document for a new task. */
export async function createTask(paths: TaskPaths, input: CreateTaskInput): Promise<RuntimeState> {
  const state = createInitialState({
    taskId: paths.taskId,
    startInformation: input.startInformation,
    endInformation: input.endInformation,
    at: input.at,
  })
  await ensureDir(paths.taskDir)
  await mkdir(paths.evidenceDir, { recursive: true })
  await mkdir(paths.runtimeDir, { recursive: true })
  await mkdir(paths.consensusDir, { recursive: true })
  await mkdir(paths.sessionsDir, { recursive: true })
  await mkdir(paths.logsDir, { recursive: true })

  await saveState(paths, state)
  await writeFileAtomic(paths.taskFile, renderTaskMarkdown(state))
  await writeFileAtomic(paths.findingsFile, renderFindingsHeader(state))
  await writeFileAtomic(paths.worksFile, renderWorksMarkdown(state))
  await appendFileDurable(
    paths.journalFile,
    `${JSON.stringify({ at: nowIso(), event: 'task-created', taskId: state.taskId })}\n`,
  )
  return state
}

/** Throw when a task directory already holds a task. */
export async function assertTaskDoesNotExist(paths: TaskPaths): Promise<void> {
  const { stat } = await import('node:fs/promises')
  const existing = await stat(paths.stateFile).catch(() => null)
  if (existing !== null) throw new AppError('TASK_EXISTS', `任务已存在：${paths.taskId}`)
}
