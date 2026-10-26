import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeTaskPaths } from '../src/core/paths.ts'
import { createTask } from '../src/core/task.ts'
import { startTaskRun } from '../src/web/task-service.ts'

const ENV_KEYS = [
  'LIEBIAN_WEB_LAUNCHER',
  'LIEBIAN_TASKS_COMPOSE_FILE',
  'LIEBIAN_DOCKER_BIN',
  'LIEBIAN_DSH_HOME',
  'LIEBIAN_TASK_START_TIMEOUT_MS',
  'FAKE_DOCKER_LOG',
  'FAKE_DOCKER_NODE',
  'FAKE_DOCKER_SCRIPT',
  'FAKE_DOCKER_RUNNING',
  'FAKE_DOCKER_DELAY_MS',
  'FAKE_DOCKER_UP_EXIT',
  'FAKE_DOCKER_INSPECT_ERROR',
] as const

interface FakeDocker {
  root: string
  tasksRoot: string
  taskId: string
  logFile: string
}

function dockerCalls(log: string): string[][] {
  return log
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}

function countCompose(log: string, action: 'up' | 'rm'): number {
  return dockerCalls(log).filter((args) => args[0] === 'compose' && args.includes(action)).length
}

async function waitForUp(logFile: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const log = await readFile(logFile, 'utf8').catch(() => '')
    if (countCompose(log, 'up') > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('假 Docker 未收到 compose up')
}

async function fakeDocker(
  t: test.TestContext,
  options: {
    running?: boolean | 'after-up'
    delayMs?: number
    inspectError?: string
  } = {},
): Promise<FakeDocker> {
  const scratch = fileURLToPath(new URL('../.scratch', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'liebian-backend-docker-'))
  const tasksRoot = join(root, 'tasks')
  const taskId = 'T-20261026-120000-dock'
  const paths = makeTaskPaths(tasksRoot, taskId)
  await createTask(paths, { startInformation: '测试启动', endInformation: '测试完成' })
  await writeFile(
    join(tasksRoot, '.web-settings.json'),
    JSON.stringify({
      modelApiProtocol: 'openai-compatible',
      provider: 'gateway',
      model: 'mock-model',
      baseUrl: 'http://gateway.example/v1',
      apiKey: '',
    }),
    'utf8',
  )

  const fakeScript = join(root, 'fake-docker.cjs')
  const logFile = join(root, 'docker-calls.jsonl')
  const runningFile = join(root, 'docker-running.txt')
  await writeFile(logFile, '', 'utf8')
  await writeFile(runningFile, options.running === true ? 'true' : 'false', 'utf8')
  await writeFile(
    fakeScript,
    `
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n')
if (process.env.FAKE_DOCKER_INSPECT_ERROR) {
  process.stderr.write(process.env.FAKE_DOCKER_INSPECT_ERROR)
  process.exit(1)
}
if (args[0] === 'inspect') {
  if (args.includes('-f') || args.some((arg) => arg.startsWith('{{json .Mounts}}'))) {
    const running = fs.readFileSync(process.env.FAKE_DOCKER_RUNNING, 'utf8').trim()
    process.stdout.write((running === 'after-up' && fs.existsSync(process.env.FAKE_DOCKER_LOG) &&
      fs.readFileSync(process.env.FAKE_DOCKER_LOG, 'utf8').includes('"up"') ? 'true' : running) + '\\n')
    process.exit(0)
  }
  process.stderr.write('Error: No such container: test\\n')
  process.exit(1)
}
if (args[0] === 'compose' && args.includes('up')) {
  const delay = Number(process.env.FAKE_DOCKER_DELAY_MS || '0')
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
  process.stderr.write('mock compose up failure\\n')
  process.exit(Number(process.env.FAKE_DOCKER_UP_EXIT || '1'))
}
process.exit(0)
`,
    'utf8',
  )
  const windows = process.platform === 'win32'
  const fakeBinary = join(root, windows ? 'fake-docker.cmd' : 'fake-docker')
  await writeFile(
    fakeBinary,
    windows
      ? '@echo off\r\n"%FAKE_DOCKER_NODE%" "%FAKE_DOCKER_SCRIPT%" %*\r\n'
      : '#!/bin/sh\nexec "$FAKE_DOCKER_NODE" "$FAKE_DOCKER_SCRIPT" "$@"\n',
    'utf8',
  )
  if (!windows) await chmod(fakeBinary, 0o755)

  const previous = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) previous.set(key, process.env[key])
  t.after(async () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  process.env.LIEBIAN_WEB_LAUNCHER = 'compose'
  process.env.LIEBIAN_TASKS_COMPOSE_FILE = join(root, 'compose', 'tasks.yaml')
  process.env.LIEBIAN_DOCKER_BIN = fakeBinary
  process.env.LIEBIAN_DSH_HOME = join(root, 'dsh')
  process.env.LIEBIAN_TASK_START_TIMEOUT_MS = '1000'
  process.env.FAKE_DOCKER_NODE = process.execPath
  process.env.FAKE_DOCKER_SCRIPT = fakeScript
  process.env.FAKE_DOCKER_LOG = logFile
  process.env.FAKE_DOCKER_RUNNING = runningFile
  process.env.FAKE_DOCKER_DELAY_MS = String(options.delayMs ?? 0)
  process.env.FAKE_DOCKER_UP_EXIT = '1'
  if (options.inspectError !== undefined) process.env.FAKE_DOCKER_INSPECT_ERROR = options.inspectError
  else delete process.env.FAKE_DOCKER_INSPECT_ERROR

  return { root, tasksRoot, taskId, logFile }
}

test('Docker 启动：失败后释放启动守卫并允许重试', async (t) => {
  const docker = await fakeDocker(t, { running: 'after-up' })
  const call = () => startTaskRun({ tasksRoot: docker.tasksRoot, taskId: docker.taskId })
  await assert.rejects(call(), (error: unknown) => (error as { code?: string }).code === 'DOCKER_COMMAND_FAILED')
  await assert.rejects(call(), (error: unknown) => (error as { code?: string }).code === 'DOCKER_COMMAND_FAILED')
  const log = await readFile(docker.logFile, 'utf8')
  assert.equal(countCompose(log, 'up'), 2)
})

test('Docker 启动：并发初始化只执行一次 up，第二个请求明确拒绝', async (t) => {
  const docker = await fakeDocker(t, { running: 'after-up', delayMs: 350 })
  const first = startTaskRun({ tasksRoot: docker.tasksRoot, taskId: docker.taskId })
  await waitForUp(docker.logFile)
  await assert.rejects(
    startTaskRun({ tasksRoot: docker.tasksRoot, taskId: docker.taskId }),
    (error: unknown) => (error as { code?: string }).code === 'ALREADY_STARTING',
  )
  await assert.rejects(first, (error: unknown) => (error as { code?: string }).code === 'DOCKER_COMMAND_FAILED')
  assert.equal(countCompose(await readFile(docker.logFile, 'utf8'), 'up'), 1)
})

test('Docker 启动：运行中的容器直接拒绝且不执行清理或 up', async (t) => {
  const docker = await fakeDocker(t, { running: true })
  await assert.rejects(
    startTaskRun({ tasksRoot: docker.tasksRoot, taskId: docker.taskId }),
    (error: unknown) => (error as { code?: string }).code === 'ALREADY_RUNNING',
  )
  const calls = dockerCalls(await readFile(docker.logFile, 'utf8'))
  assert.deepEqual(calls, [['inspect', '-f', '{{.State.Running}}', 'liebian-T-20261026-120000-dock']])
})

test('Docker 启动：inspect 瞬态错误不会被当作容器不存在', async (t) => {
  const docker = await fakeDocker(t, { inspectError: 'Cannot connect to the Docker daemon' })
  await assert.rejects(
    startTaskRun({ tasksRoot: docker.tasksRoot, taskId: docker.taskId }),
    (error: unknown) => (error as { code?: string }).code === 'DOCKER_COMMAND_FAILED',
  )
  assert.equal(countCompose(await readFile(docker.logFile, 'utf8'), 'up'), 0)
})

test('Docker 启动：Web 保存的模型限制实际进入任务服务环境', async (t) => {
  const docker = await fakeDocker(t, { running: 'after-up', delayMs: 350 })
  await writeFile(
    join(docker.tasksRoot, '.web-settings.json'),
    `${JSON.stringify({
      apiKey: '',
      modelApiProtocol: 'openai-compatible',
      provider: 'gateway',
      model: 'mock-model',
      baseUrl: 'http://gateway.example/v1',
      modelConcurrency: 2,
      modelMaxTokens: 4096,
      modelThinking: 'low',
    }, null, 2)}\n`,
    'utf8',
  )

  const starting = startTaskRun({ tasksRoot: docker.tasksRoot, taskId: docker.taskId })
  await waitForUp(docker.logFile)
  const compose = JSON.parse(await readFile(process.env.LIEBIAN_TASKS_COMPOSE_FILE!, 'utf8')) as {
    services: Record<string, { environment: Record<string, string> }>
  }
  const environment = compose.services[`task-${docker.taskId}`]?.environment
  assert.ok(environment)
  assert.equal(environment.LIEBIAN_MODEL_MAX_TOKENS, '4096')
  assert.equal(environment.LIEBIAN_MODEL_THINKING, 'low')
  assert.equal(environment.LIEBIAN_MODEL_CONCURRENCY, '2')
  await assert.rejects(starting, (error: unknown) => (error as { code?: string }).code === 'DOCKER_COMMAND_FAILED')
})
