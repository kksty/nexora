import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildTaskService,
  readTasksCompose,
  reconcileTaskServices,
  removeTaskService,
  toComposePath,
  upsertTaskService,
} from '../src/web/docker-launcher.ts'

async function tempTasksFile(t: test.TestContext): Promise<string> {
  const base = fileURLToPath(new URL('../.scratch', import.meta.url))
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'liebian-compose-'))
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined))
  return join(root, 'tasks.yaml')
}

function useTasksFile(file: string): () => void {
  const previous = process.env.LIEBIAN_TASKS_COMPOSE_FILE
  process.env.LIEBIAN_TASKS_COMPOSE_FILE = file
  return () => {
    if (previous === undefined) delete process.env.LIEBIAN_TASKS_COMPOSE_FILE
    else process.env.LIEBIAN_TASKS_COMPOSE_FILE = previous
  }
}

function sampleService() {
  return buildTaskService({
    taskId: 'T-1',
    taskHostDir: 'D:\\code\\liebian\\tasks\\T-1',
    dshHostDir: 'D:\\code\\liebian\\.dsh',
    image: 'liebian:latest',
    environment: {
      DEEPSEEK_API_KEY: 'sk-test',
      LIEBIAN_PROVIDER: 'deepseek-official',
      LIEBIAN_MODEL: 'deepseek-flash',
      LIEBIAN_MODEL_CONCURRENCY: '4',
      TZ: 'Asia/Shanghai',
    },
  })
}

test('Compose：任务 service 使用独立挂载、NET_RAW/NET_ADMIN 与 run 命令', () => {
  const service = sampleService()
  assert.equal(service.image, 'liebian:latest')
  assert.equal(service.network_mode, 'host')
  assert.equal('ports' in service, false)
  assert.equal(service.container_name, 'liebian-T-1')
  assert.deepEqual(service.command, ['run', '--task', 'T-1'])
  assert.deepEqual(service.cap_add, ['NET_RAW', 'NET_ADMIN'])
  assert.equal(service.user, '0:0')
  assert.equal(service.restart, 'no')
  assert.deepEqual(service.volumes, [
    'D:/code/liebian/tasks/T-1:/tasks/T-1',
    'D:/code/liebian/.dsh:/dsh-home',
  ])
  assert.equal(service.environment.DSH_HOME, '/dsh-home')
  assert.equal(service.environment.LIEBIAN_TASKS_DIR, '/tasks')
  assert.equal(service.environment.LIEBIAN_TASK_ID, 'T-1')
  assert.equal(service.environment.DEEPSEEK_API_KEY, 'sk-test')
  assert.equal(service.environment.LIEBIAN_MODEL_CONCURRENCY, '4')
  assert.equal(service.environment.TZ, 'Asia/Shanghai')
})

test('Compose：生成文件可以新增、读取并移除任务 service', async (t) => {
  const file = await tempTasksFile(t)
  const restore = useTasksFile(file)
  t.after(restore)
  await writeFile(file, '{"services": {}}\n', 'utf8')

  assert.deepEqual(await readTasksCompose(), { services: {} })
  await upsertTaskService('T-1', sampleService())

  const data = await readTasksCompose()
  assert.deepEqual(Object.keys(data.services), ['task-T-1'])
  const persisted = JSON.parse(await readFile(file, 'utf8')) as {
    services: Record<string, { container_name: string }>
  }
  assert.equal(persisted.services['task-T-1']?.container_name, 'liebian-T-1')

  await removeTaskService('T-1')
  assert.deepEqual((await readTasksCompose()).services, {})
  // Removing an absent service is idempotent.
  await removeTaskService('T-1')
})

test('Compose：并发新增不同任务 service 不会互相覆盖', async (t) => {
  const file = await tempTasksFile(t)
  const restore = useTasksFile(file)
  t.after(restore)
  await writeFile(file, '{"services": {}}\n', 'utf8')
  const serviceFor = (taskId: string) =>
    buildTaskService({
      taskId,
      taskHostDir: `/tasks/${taskId}`,
      dshHostDir: '/dsh-home',
      image: 'liebian:latest',
      environment: {},
    })

  await Promise.all([
    upsertTaskService('T-AAAA', serviceFor('T-AAAA')),
    upsertTaskService('T-BBBB', serviceFor('T-BBBB')),
  ])
  const data = await readTasksCompose()
  assert.deepEqual(Object.keys(data.services).sort(), ['task-T-AAAA', 'task-T-BBBB'])
})

test('Compose：任务目录不可读时不会回收任何 service', async (t) => {
  const file = await tempTasksFile(t)
  const restore = useTasksFile(file)
  const previousMode = process.env.LIEBIAN_WEB_LAUNCHER
  process.env.LIEBIAN_WEB_LAUNCHER = 'compose'
  t.after(() => {
    restore()
    if (previousMode === undefined) delete process.env.LIEBIAN_WEB_LAUNCHER
    else process.env.LIEBIAN_WEB_LAUNCHER = previousMode
  })
  const service = buildTaskService({
    taskId: 'T-LIVE',
    taskHostDir: '/tasks/T-LIVE',
    dshHostDir: '/dsh-home',
    image: 'liebian:latest',
    environment: {},
  })
  await writeFile(file, `${JSON.stringify({ services: { 'task-T-LIVE': service } }, null, 2)}\n`, 'utf8')

  // A regular file cannot be readdir'd: treat this as "cannot verify" and keep
  // the live service instead of force-removing its container.
  const notADirectory = join(dirname(file), 'not-a-directory.txt')
  await writeFile(notADirectory, 'x', 'utf8')
  await reconcileTaskServices(notADirectory)
  assert.ok((await readTasksCompose()).services['task-T-LIVE'], '服务不应被回收')
})

test('Compose：非法生成文件给出明确错误且不会被覆盖', async (t) => {
  const file = await tempTasksFile(t)
  const restore = useTasksFile(file)
  t.after(restore)
  const broken = 'services:\n  bad: [\n'
  await writeFile(file, broken, 'utf8')

  await assert.rejects(
    readTasksCompose(),
    (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'COMPOSE_FILE_INVALID',
  )
  assert.equal(await readFile(file, 'utf8'), broken)
})

test('Compose：宿主机路径转成 compose 使用的正斜杠形式', () => {
  assert.equal(toComposePath('D:\\code\\liebian\\tasks'), 'D:/code/liebian/tasks')
  assert.equal(toComposePath('/srv/liebian/tasks'), '/srv/liebian/tasks')
})

test('Compose：环境变量里的 $ 会被转义，避免 Compose 插值改写 API Key', () => {
  const service = buildTaskService({
    taskId: 'T-1',
    taskHostDir: '/srv/tasks/T-1',
    dshHostDir: '/srv/.dsh',
    image: 'liebian:latest',
    environment: { DEEPSEEK_API_KEY: 'sk-a$b${c}' },
  })
  assert.equal(service.environment.DEEPSEEK_API_KEY, 'sk-a$$b$${c}')
})
