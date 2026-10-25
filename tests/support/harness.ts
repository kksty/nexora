/** Shared test harness: a real task directory and a stubbed harness session. */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from '../../src/core/engine.ts'
import { createTask } from '../../src/core/task.ts'
import { makeTaskPaths, type TaskPaths } from '../../src/core/paths.ts'
import { nullLogger } from '../../src/util/log.ts'
import { FakeDriver } from './fake-driver.ts'

export interface TestHarness {
  root: string
  paths: TaskPaths
  driver: FakeDriver
  engine: Engine
  cleanup: () => Promise<void>
}

export interface HarnessOptions {
  startInformation?: string
  endInformation?: string
  autoFinish?: boolean
  modelConcurrency?: number
}

export const DEFAULT_START = '起始信息：目标站点为 example.test，已知一个登录入口 /login，没有凭据。'
export const DEFAULT_END = '终点信息：取得管理员权限，并把可复现的证据写入任务目录。'

/** Create an isolated task plus an Engine driven by FakeDriver. */
export async function createHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  // Keep test data in the repository, alongside the other host-side data.
  const testRoot = fileURLToPath(new URL('../../.scratch', import.meta.url))
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, 'liebian-test-'))
  const taskId = `T-test-${randomUUID().slice(0, 8)}`
  const paths = makeTaskPaths(join(root, 'tasks'), taskId)
  await createTask(paths, {
    startInformation: options.startInformation ?? DEFAULT_START,
    endInformation: options.endInformation ?? DEFAULT_END,
  })
  const driver = new FakeDriver()
  driver.autoFinish = options.autoFinish ?? true
  const engine = await Engine.open({
    paths,
    driver,
    logger: nullLogger,
    retry: { initialMs: 20, factor: 2, maxMs: 100, jitter: 0 },
    ...(options.modelConcurrency === undefined ? {} : { modelConcurrency: options.modelConcurrency }),
  })
  return {
    root,
    paths,
    driver,
    engine,
    cleanup: async () => {
      await engine.close('test-cleanup').catch(() => undefined)
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

/** Poll a predicate until it becomes true or the timeout elapses. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4_000,
  label = '条件',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
