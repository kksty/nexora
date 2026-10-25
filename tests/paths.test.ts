import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveTaskPaths, defaultTasksRoot } from '../src/core/paths.ts'
import { createHarness } from './support/harness.ts'

test('任务路径可以按任务 ID 或已有的绝对目录解析', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())

  const byId = await resolveTaskPaths(harness.paths.taskId, harness.paths.tasksRoot)
  assert.equal(byId.taskDir, harness.paths.taskDir)
  assert.equal(byId.stateFile, harness.paths.stateFile)
  assert.equal(byId.taskId, harness.paths.taskId)

  const byDirectory = await resolveTaskPaths(harness.paths.taskDir)
  assert.equal(byDirectory.taskDir, harness.paths.taskDir)
  assert.equal(byDirectory.taskId, harness.paths.taskId)
})

test('未知任务返回明确错误', async () => {
  await assert.rejects(
    resolveTaskPaths('T-does-not-exist-xyz', defaultTasksRoot()),
    (error: unknown) => (error as { code?: string }).code === 'TASK_NOT_FOUND',
  )
})
