import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
test('系统锁：心跳过期仍不能抢走活进程的写入权；并发接管只有一个赢家', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const first = await acquireTaskOwnership(harness.paths, 'cli')
  const staleAt = new Date(Date.now() - 60_000).toISOString()
  await writeOwner(harness.paths.ownerFile, { ...first, heartbeatAt: staleAt })
  await assert.rejects(acquireTaskOwnership(harness.paths, 'web', { staleMs: 1 }), isCode('TASK_BUSY'))
  await releaseTaskOwnership(harness.paths, first)
  const contenders = await Promise.allSettled(Array.from({ length: 12 }, () => acquireTaskOwnership(harness.paths, 'web')))
  const winners = contenders.filter((r) => r.status === 'fulfilled')
  assert.equal(winners.length, 1)
  for (const winner of winners) await releaseTaskOwnership(harness.paths, winner.value)
})

test('系统锁：子进程强杀后立即接管，旧元数据不阻塞恢复', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireTaskOwnership } from './src/core/ownership.ts';
    const paths = JSON.parse(process.argv[1]);
    await acquireTaskOwnership(paths, 'cli');
    console.log('ready');
    setInterval(() => {}, 1000);
  `, JSON.stringify(harness.paths)], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const exited = once(child, 'exit')
  t.after(() => { child.kill('SIGKILL') })
  const ready = await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error('child exited early') })])
  assert.match(String(ready[0]), /ready/)
  await assert.rejects(acquireTaskOwnership(harness.paths, 'web'), isCode('TASK_BUSY'))
  child.kill('SIGKILL')
  await exited
  const recovered = await acquireTaskOwnership(harness.paths, 'web')
  await releaseTaskOwnership(harness.paths, recovered)
})

test('系统锁：不同操作系统锁域拒绝写入且不改动元数据', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await writeFile(harness.paths.ownerFile + '.lock.sqlite.domain', 'liebian-lock-v1:foreign\n')
  await assert.rejects(acquireTaskOwnership(harness.paths, 'web'), isCode('LOCK_DOMAIN_MISMATCH'))
  assert.equal(await readTaskOwnership(harness.paths), null)
})

test('所有权释放与心跳竞争：释放完成后不会重建旧记录', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const lease = await acquireTaskOwnership(harness.paths, 'cli')
  await Promise.all([renewTaskOwnership(harness.paths, lease), releaseTaskOwnership(harness.paths, lease), renewTaskOwnership(harness.paths, lease)])
  assert.equal(await readTaskOwnership(harness.paths), null)
  assert.equal(await renewTaskOwnership(harness.paths, lease), false)
})
import { writeDaemonInfo } from '../src/core/daemon.ts'
import {
  acquireTaskOwnership,
  readTaskOwnership,
  releaseTaskOwnership,
  renewTaskOwnership,
  startOwnershipHeartbeat,
  type TaskOwnerRecord,
} from '../src/core/ownership.ts'
import { createHarness } from './support/harness.ts'

async function writeOwner(path: string, record: Partial<TaskOwnerRecord>): Promise<void> {
  await writeFile(path, `${JSON.stringify({ ...record }, null, 2)}\n`, 'utf8')
}

function isCode(code: string) {
  return (error: unknown) => (error as { code?: string }).code === code
}

test('所有权租约：同一任务只有一个写入者，释放后可重新取得', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const lease = await acquireTaskOwnership(harness.paths, 'web', { staleMs: 8_000 })
  assert.equal((await readTaskOwnership(harness.paths))?.token, lease.token)
  assert.equal(await renewTaskOwnership(harness.paths, lease), true)

  await assert.rejects(
    acquireTaskOwnership(harness.paths, 'cli', { staleMs: 8_000, waitMs: 0 }),
    isCode('TASK_BUSY'),
  )
  await releaseTaskOwnership(harness.paths, lease)
  assert.equal(await readTaskOwnership(harness.paths), null)

  const next = await acquireTaskOwnership(harness.paths, 'cli', { staleMs: 8_000 })
  await releaseTaskOwnership(harness.paths, next)
})

test('过期租约可被接管；心跳更新与丢失检测', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const staleAt = new Date(Date.now() - 60_000).toISOString()
  await writeOwner(harness.paths.ownerFile, {
    owner: 'cli',
    pid: 999_999,
    taskId: harness.paths.taskId,
    token: 'stale-token',
    acquiredAt: staleAt,
    heartbeatAt: staleAt,
  })
  const lease = await acquireTaskOwnership(harness.paths, 'web', { staleMs: 1_000, waitMs: 500 })
  assert.notEqual(lease.token, 'stale-token')

  const heartbeat = startOwnershipHeartbeat(harness.paths, lease, 20)
  const early = await readTaskOwnership(harness.paths)
  await new Promise((resolve) => setTimeout(resolve, 90))
  const later = await readTaskOwnership(harness.paths)
  await heartbeat.stop()
  assert.ok(later !== null)
  assert.ok(Date.parse(later.heartbeatAt) >= Date.parse(early?.heartbeatAt ?? later.heartbeatAt))

  // Another owner replacing the lease makes renewal fail.
  const replacement: TaskOwnerRecord = { ...lease, token: 'someone-else', owner: 'cli' }
  await writeOwner(harness.paths.ownerFile, replacement)
  assert.equal(await renewTaskOwnership(harness.paths, lease), false)
  await releaseTaskOwnership(harness.paths, lease)
  assert.equal((await readTaskOwnership(harness.paths))?.token, 'someone-else', '不得删除他人的租约')
})

test('过期的 daemon 租约在运行时仍响应时不能被接管', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, taskId: harness.paths.taskId }))
      return
    }
    response.writeHead(404).end()
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      resolve(address.port)
    })
  })
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  )
  await writeDaemonInfo(harness.paths, {
    url: `http://127.0.0.1:${port}`,
    token: 'fake',
    pid: 1234,
    taskId: harness.paths.taskId,
  })
  const staleAt = new Date(Date.now() - 60_000).toISOString()
  await writeOwner(harness.paths.ownerFile, {
    owner: 'daemon',
    pid: 1234,
    taskId: harness.paths.taskId,
    token: 'daemon-token',
    acquiredAt: staleAt,
    heartbeatAt: staleAt,
  })
  // The heartbeat is stale, but the runtime still answers /health: refuse.
  await assert.rejects(
    acquireTaskOwnership(harness.paths, 'web', { staleMs: 1_000, waitMs: 0 }),
    isCode('TASK_BUSY'),
  )
  assert.equal((await readTaskOwnership(harness.paths))?.token, 'daemon-token')

  // Once the descriptor is gone, the same stale lease may be taken over.
  const { rm } = await import('node:fs/promises')
  await rm(harness.paths.daemonFile, { force: true })
  const lease = await acquireTaskOwnership(harness.paths, 'web', { staleMs: 1_000, waitMs: 1_000 })
  assert.notEqual(lease.token, 'daemon-token')
  await releaseTaskOwnership(harness.paths, lease)
})

test('损坏的所有权记录不会被当作活写入者', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await writeFile(harness.paths.ownerFile, '{"owner":"web","pid":', 'utf8')
  // A genuinely old malformed record is removed; a fresh one is treated as a
  // creation still in progress and never stolen.
  const old = new Date(Date.now() - 60_000)
  await utimes(harness.paths.ownerFile, old, old)
  const lease = await acquireTaskOwnership(harness.paths, 'cli', { staleMs: 1_000, waitMs: 1_000 })
  assert.equal((await readTaskOwnership(harness.paths))?.token, lease.token)
  await releaseTaskOwnership(harness.paths, lease)
  assert.equal(await readFile(harness.paths.ownerFile, 'utf8').catch(() => null), null)
})
