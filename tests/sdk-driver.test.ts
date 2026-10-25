import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { SdkHarnessDriver } from '../src/harness/sdk-driver.ts'
import type { Logger } from '../src/util/log.ts'

const FAKE_DSH = `import { appendFileSync } from 'node:fs'
const log = process.env.FAKE_DSH_LOG
if (process.env.FAKE_DSH_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
if (log) appendFileSync(log, 'start\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length > 0) handle(JSON.parse(line))
    index = buffer.indexOf('\\n')
  }
})
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
function handle(message) {
  if (message.method === 'initialize') return reply(message.id, { serverInfo: { name: 'fake', version: '0' } })
  if (message.method === 'shutdown') {
    reply(message.id, {})
    const delay = Number(process.env.FAKE_DSH_SHUTDOWN_DELAY ?? '0')
    setTimeout(() => process.exit(0), delay)
    return
  }
  reply(message.id, {})
}
`

function stubLogger(warnings: string[]): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => warnings.push(message),
    error: () => undefined,
    child: () => logger,
  }
  return logger
}

async function makeDriver(t: { after: (fn: () => Promise<void> | void) => void }) {
  const scratch = fileURLToPath(new URL('../.scratch', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'driver-test-'))
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined))
  const taskDir = join(root, 'task')
  const logsDir = join(taskDir, 'runtime', 'logs')
  await mkdir(logsDir, { recursive: true })
  const dshBin = join(root, 'fake-dsh.mjs')
  await writeFile(dshBin, FAKE_DSH, 'utf8')
  const warnings: string[] = []
  const driver = new SdkHarnessDriver({
    taskDir,
    patchFile: join(taskDir, 'runtime', 'harness.patch.yml'),
    mcpEntry: join(root, 'mcp.js'),
    logDir: logsDir,
    daemonUrl: 'http://127.0.0.1:1',
    daemonToken: 'token',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    logger: stubLogger(warnings),
    dshBin,
  })
  return { root, taskDir, logsDir, driver, warnings }
}

test('stopAll 之后 ensure 拒绝启动新进程', async (t) => {
  const { root, taskDir, driver } = await makeDriver(t)
  const startLog = join(root, 'starts.log')
  process.env.FAKE_DSH_LOG = startLog
  t.after(() => {
    delete process.env.FAKE_DSH_LOG
  })
  await driver.stopAll()
  await assert.rejects(
    driver.ensure({ workId: 'W-0001', sessionId: 's-1', sessionStarted: false, taskDir }),
    (error: Error & { code?: string }) => error.code === 'HARNESS_STOPPED',
  )
  assert.equal(await readFile(startLog, 'utf8').catch(() => ''), '')
})

test('并发 stop 后，正在替换旧进程的 ensure 不会残留新进程', async (t) => {
  const { root, taskDir, driver } = await makeDriver(t)
  const startLog = join(root, 'starts.log')
  process.env.FAKE_DSH_LOG = startLog
  process.env.FAKE_DSH_SHUTDOWN_DELAY = '400'
  t.after(() => {
    delete process.env.FAKE_DSH_LOG
    delete process.env.FAKE_DSH_SHUTDOWN_DELAY
  })

  await driver.ensure({ workId: 'W-0001', sessionId: 's-1', sessionStarted: false, taskDir })
  // Replacing the process takes ~400ms because the old one lingers on shutdown.
  const replacing = driver.ensure({ workId: 'W-0001', sessionId: 's-2', sessionStarted: false, taskDir })
  await new Promise((resolve) => setTimeout(resolve, 100))
  // The old worker is already out of the map here; stopAll only sees an empty
  // set, so the ensure itself must notice the stop before spawning a new one.
  await driver.stopAll()
  await assert.rejects(
    replacing,
    (error: Error & { code?: string }) => error.code === 'HARNESS_STOPPED',
  )
  const starts = (await readFile(startLog, 'utf8')).trim().split('\n').filter(Boolean)
  assert.equal(starts.length, 1, '只应存在最初那个进程')
})

test('harness 日志不可写时只记录警告，不击穿运行时', async (t) => {
  const { taskDir, logsDir, driver, warnings } = await makeDriver(t)
  // Make the log directory itself a file so createWriteStream fails.
  await rm(logsDir, { recursive: true, force: true })
  await writeFile(logsDir, 'not a directory', 'utf8')
  await driver.ensure({ workId: 'W-0001', sessionId: 's-1', sessionStarted: false, taskDir })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(warnings.some((line) => line.includes('harness 日志写入失败')), warnings.join('\n'))
  await driver.stopAll()
})

test('停止必须等到顽固进程真实退出，必要时升级为强制终止', async (t) => {
  const { taskDir, driver } = await makeDriver(t)
  process.env.FAKE_DSH_SHUTDOWN_DELAY = '30000'
  process.env.FAKE_DSH_IGNORE_TERM = '1'
  t.after(() => { delete process.env.FAKE_DSH_SHUTDOWN_DELAY; delete process.env.FAKE_DSH_IGNORE_TERM })
  const ensured = await driver.ensure({ workId: 'W-0001', sessionId: 'stubborn', sessionStarted: false, taskDir })
  let exitGeneration: number | undefined
  driver.onWorkerExit = (_work, _reason, generation) => { exitGeneration = generation }
  await Promise.all([driver.stop('W-0001'), driver.stopAll()])
  assert.equal(exitGeneration, ensured.generation)
  assert.deepEqual(await driver.inspectProcesses(), [])
})
