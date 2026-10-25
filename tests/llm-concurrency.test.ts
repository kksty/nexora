import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { startApiServer, type ApiServer } from '../src/api/server.ts'
import { apply } from '../src/harness/llm-concurrency.ts'
import { DEFAULT_MODEL_CONCURRENCY, Semaphore, parseModelConcurrency } from '../src/util/semaphore.ts'
import { nullLogger } from '../src/util/log.ts'
import { createHarness, waitUntil, type TestHarness } from './support/harness.ts'
import type { HarnessDriver } from '../src/harness/driver.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
test('进程代次：旧进程退出只回收自己的名额，旧请求被拒绝', async (t) => {
  const harness = await createHarness({ modelConcurrency: 2 })
  t.after(() => harness.cleanup())
  await harness.engine.start()
  const driver: HarnessDriver = harness.driver
  driver.onWorkerStart?.('W-0001', 11)
  const old = await harness.engine.acquireModelSlot('W-0001', { generation: 11 })
  driver.onWorkerStart?.('W-0001', 12)
  const next = await harness.engine.acquireModelSlot('W-0001', { generation: 12 })
  driver.onWorkerExit?.('W-0001', 'old exit', 11)
  assert.equal(harness.engine.modelSlotStats.active, 1)
  assert.equal(harness.engine.releaseModelSlot(old.permitId), false)
  await assert.rejects(harness.engine.acquireModelSlot('W-0001', { generation: 11 }),
    (e: unknown) => (e as { code: string }).code === 'STALE_GENERATION')
  assert.throws(() => harness.engine.releaseModelRequest('W-0001', 11, next.permitId, false))
  assert.equal(harness.engine.releaseModelRequest('W-0001', 12, next.permitId, false), true)
  driver.onWorkerExit?.('W-0001', 'current exit', 12)
  await assert.rejects(harness.engine.acquireModelSlot('W-0001', { generation: 12 }))
})

test('信号量：重复的迟到 acquire 不能穿过取消墓碑', async () => {
  const pool = new Semaphore(1)
  pool.cancel('late')
  for (let i = 0; i < 3; i += 1) await assert.rejects(pool.acquire({ workId: 'W-1', permitId: 'late' }))
  assert.equal(pool.stats.active, 0)
})

test('插件：消费者停在 yield 时取消也会关闭上游并归还名额', async (t) => {
  const { harness, listener } = await startPluginRuntime(t, 1)
  let closed = false
  const controller = new AbortController()
  const stream = listener({ signal: controller.signal }, async function* () {
    try { yield 'one'; yield 'two' } finally { closed = true }
  })[Symbol.asyncIterator]()
  assert.equal((await stream.next()).value, 'one')
  controller.abort()
  await waitUntil(() => closed && harness.engine.modelSlotStats.active === 0, 2000)
  await assert.rejects(stream.next())
})

test('插件：消费者遗弃流且不取消，空闲看门狗回收并记录原因', async (t) => {
  const previous = process.env.LIEBIAN_MODEL_STREAM_IDLE_MS
  process.env.LIEBIAN_MODEL_STREAM_IDLE_MS = '40'
  t.after(() => { if (previous === undefined) delete process.env.LIEBIAN_MODEL_STREAM_IDLE_MS; else process.env.LIEBIAN_MODEL_STREAM_IDLE_MS = previous })
  const { harness, listener } = await startPluginRuntime(t, 1)
  let closed = false
  const stream = listener({}, async function* () { try { yield 'one' } finally { closed = true } })[Symbol.asyncIterator]()
  await stream.next()
  await waitUntil(() => closed && harness.engine.modelSlotStats.active === 0, 2000)
  await harness.engine.close()
  const lines = (await readFile(join(harness.paths.logsDir, 'diagnostics.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.ok(lines.some((e) => e.event === 'model-finished' && e.data.metrics.outcome === 'idle-timeout'))
  await stream.return?.()
})

test('插件：dispose 主动关闭未消费完的流', async (t) => {
  const { harness, listener, context } = await startPluginRuntime(t, 1)
  let closed = false
  const stream = listener({}, async function* () { try { yield 1; yield 2 } finally { closed = true } })[Symbol.asyncIterator]()
  await stream.next()
  context.dispose()
  await waitUntil(() => closed && harness.engine.modelSlotStats.active === 0, 2000)
  await stream.return?.()
})

test('诊断：模型用量、首块耗时和关联标识随真实流记录', async (t) => {
  const { harness, listener } = await startPluginRuntime(t, 1)
  await consume(listener({}, async function* () {
    yield { type: 'text-delta', text: 'hello' }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }))
  await waitUntil(() => harness.engine.modelSlotStats.active === 0)
  await harness.engine.close()
  const lines = (await readFile(join(harness.paths.logsDir, 'diagnostics.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const completed = lines.find((e) => e.event === 'model-finished')
  assert.equal(completed.data.metrics.usage.inputTokens, 12)
  assert.equal(completed.data.metrics.textChars, 5)
  assert.equal(completed.data.generation, 1)
  assert.equal(completed.taskId, harness.paths.taskId)
  assert.ok(completed.bootId && completed.data.runId)
  assert.ok(completed.data.metrics.firstChunkMs >= 0)
  assert.ok(lines.some((e) => e.event === 'runtime-sample' && e.data.stateBytes > 0))
})

test('插件：上游拒绝关闭时不提前释放名额，改为停止对应进程', async (t) => {
  const previous = process.env.LIEBIAN_MODEL_STREAM_IDLE_MS
  process.env.LIEBIAN_MODEL_STREAM_IDLE_MS = '30'
  t.after(() => { if (previous === undefined) delete process.env.LIEBIAN_MODEL_STREAM_IDLE_MS; else process.env.LIEBIAN_MODEL_STREAM_IDLE_MS = previous })
  const { harness, listener } = await startPluginRuntime(t, 1)
  const driver: HarnessDriver = harness.driver
  driver.onWorkerStart?.('W-0001', 1)
  let stopped = false
  const originalStop = driver.stop.bind(driver)
  driver.stop = async (workId) => {
    assert.equal(harness.engine.modelSlotStats.active, 1, '停止前不能假装请求已结束')
    await originalStop(workId)
    driver.onWorkerExit?.(workId, 'timeout cleanup', 1)
    stopped = true
  }
  const stream = listener({}, () => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: 'one' }),
      return: () => new Promise<IteratorResult<unknown>>(() => {}),
    }),
  }))[Symbol.asyncIterator]()
  await stream.next()
  await delay(100)
  assert.equal(harness.engine.modelSlotStats.active, 1)
  await waitUntil(() => stopped && harness.engine.modelSlotStats.active === 0, 8000)
  await stream.return?.()
})

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

test('信号量：10 个请求合计最多 4 个持有名额', async () => {
  const semaphore = new Semaphore(4)
  let active = 0
  let maximum = 0

  await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const permit = await semaphore.acquire({ workId: `W-${index}` })
      active += 1
      maximum = Math.max(maximum, active)
      await delay(15)
      active -= 1
      assert.equal(semaphore.release(permit.permitId), true)
    }),
  )

  assert.equal(maximum, 4)
  assert.deepEqual(semaphore.stats, { limit: 4, active: 0, queued: 0 })
})

test('信号量：排队取消、幂等归还与按 work 回收', async () => {
  const semaphore = new Semaphore(2)
  const first = await semaphore.acquire({ workId: 'W-0001' })
  const second = await semaphore.acquire({ workId: 'W-0002' })

  const controller = new AbortController()
  const cancelled = semaphore.acquire({ workId: 'W-0002', signal: controller.signal })
  assert.equal(semaphore.stats.queued, 1)
  controller.abort()
  await assert.rejects(cancelled, (error: unknown) => (error as NodeJS.ErrnoException).code === 'REQUEST_ABORTED')
  assert.equal(semaphore.stats.queued, 0)

  // Releasing the same permit twice never drives the count below zero.
  assert.equal(semaphore.release(first.permitId), true)
  assert.equal(semaphore.release(first.permitId), false)
  assert.equal(semaphore.stats.active, 1)

  // Fill the free slot again so the next W-0001 acquire has to queue.
  await semaphore.acquire({ workId: 'W-0001' })
  const queued = semaphore.acquire({ workId: 'W-0001' })
  assert.equal(semaphore.stats.queued, 1)
  const reclaimed = semaphore.releaseWork('W-0001')
  assert.deepEqual(reclaimed, { active: 1, queued: 1 })
  await assert.rejects(queued, (error: unknown) => (error as NodeJS.ErrnoException).code === 'WORK_EXITED')
  assert.equal(semaphore.stats.active, 1, 'W-0002 的名额不应被回收')

  assert.equal(semaphore.release(second.permitId), true)
  assert.deepEqual(semaphore.stats, { limit: 2, active: 0, queued: 0 })
})

test('信号量：取消可以追上尚未到达的 acquire', async () => {
  const semaphore = new Semaphore(1)
  const held = await semaphore.acquire({ workId: 'W-0001' })
  const permitId = 'late-acquire'

  // The cancel (from an aborted stream) arrives before its acquire request.
  assert.equal(semaphore.cancel(permitId), false)
  await assert.rejects(
    semaphore.acquire({ workId: 'W-0002', permitId }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'REQUEST_ABORTED',
  )
  assert.equal(semaphore.release(held.permitId), true)
  assert.deepEqual(semaphore.stats, { limit: 1, active: 0, queued: 0 })
})

test('并发配置只接受正整数，默认 4', () => {
  assert.equal(parseModelConcurrency(undefined), DEFAULT_MODEL_CONCURRENCY)
  assert.equal(parseModelConcurrency('4'), 4)
  assert.equal(parseModelConcurrency(8), 8)
  for (const bad of ['0', '-1', '1.5', 'abc', true]) {
    assert.throws(
      () => parseModelConcurrency(bad),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'INVALID_ARGUMENT',
    )
  }
})

test('裂变不占模型名额：名额已满时仍可创建新执行者', async (t) => {
  const harness = await createHarness({ modelConcurrency: 1 })
  t.after(() => harness.cleanup())
  await harness.engine.start()

  const held = await harness.engine.acquireModelSlot('W-0001')
  assert.equal(harness.engine.modelSlotStats.active, 1)

  const spawned = await harness.engine.spawnWork('W-0001', {
    reason: '验证名额耗尽时仍可裂变',
    start_prompt: '读取共享状态后自行决定工作。',
  })
  assert.equal(spawned.workId, 'W-0002')
  assert.ok(harness.engine.state.works['W-0002'] !== undefined)
  // Spawning itself must not take or wait for a model slot.
  assert.equal(harness.engine.modelSlotStats.active, 1)
  assert.equal(harness.engine.releaseModelSlot(held.permitId), true)
})

// ---------------------------------------------------------------------------
// Loopback API
// ---------------------------------------------------------------------------

interface SlotEnvelope {
  ok?: boolean
  result?: { permitId?: string; workId?: string; released?: boolean }
  error?: { code?: string; message?: string }
}

async function startRuntime(harness: TestHarness, modelConcurrency: number): Promise<ApiServer> {
  assert.equal(harness.engine.modelConcurrency, modelConcurrency)
  await harness.engine.start()
  await harness.engine.whenQuiet()
  return startApiServer({ getEngine: () => harness.engine, logger: nullLogger })
}

async function acquire(
  server: ApiServer,
  workId: string,
  options: { permitId?: string; signal?: AbortSignal } = {},
): Promise<SlotEnvelope & { status: number }> {
  const response = await fetch(`${server.url}/llm/acquire`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${server.token}`,
      'x-liebian-work': workId,
    },
    body: JSON.stringify({ generation: 1, permitId: options.permitId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return { status: response.status, ...((await response.json()) as SlotEnvelope) }
}

async function release(
  server: ApiServer,
  permitId: string,
  cancel = false,
): Promise<SlotEnvelope & { status: number }> {
  const response = await fetch(`${server.url}/llm/release`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${server.token}`,
      'x-liebian-work': 'W-0001',
    },
    body: JSON.stringify({ permitId, cancel, generation: 1 }),
  })
  return { status: response.status, ...((await response.json()) as SlotEnvelope) }
}

test('API：名额并发、排队、幂等归还与进程退出回收', async (t) => {
  const harness = await createHarness({ modelConcurrency: 2 })
  const server = await startRuntime(harness, 2)
  t.after(async () => {
    await server.close()
    await harness.cleanup()
  })

  const first = await acquire(server, 'W-0001')
  assert.equal(first.status, 200)
  assert.equal(first.ok, true)
  const firstPermit = first.result?.permitId
  assert.ok(firstPermit !== undefined)

  const second = await acquire(server, 'W-0001')
  assert.equal(second.ok, true)
  assert.equal(harness.engine.modelSlotStats.active, 2)

  // The third request is queued, not rejected: executor_spawn still works and
  // the new child simply waits behind the two active streams.
  let thirdSettled = false
  const third = acquire(server, 'W-0001').finally(() => {
    thirdSettled = true
  })
  await waitUntil(() => harness.engine.modelSlotStats.queued === 1, 2_000, '第三个请求排队')
  await delay(30)
  assert.equal(thirdSettled, false)

  assert.equal((await release(server, firstPermit)).result?.released, true)
  const thirdBody = await third
  assert.equal(thirdBody.ok, true)
  assert.equal(harness.engine.modelSlotStats.active, 2)

  // Second release is a harmless no-op.
  assert.equal((await release(server, firstPermit)).result?.released, false)

  // Reclaim all slots held by the work (the harness-process crash path).
  const reclaimed = harness.engine.releaseModelSlotsForWork('W-0001')
  assert.deepEqual(reclaimed, { active: 2, queued: 0 })
  assert.equal(harness.engine.modelSlotStats.active, 0)
})

test('API：客户端取消排队请求后名额不会丢失', async (t) => {
  const harness = await createHarness({ modelConcurrency: 1 })
  const server = await startRuntime(harness, 1)
  t.after(async () => {
    await server.close()
    await harness.cleanup()
  })

  const held = await acquire(server, 'W-0001')
  const heldPermit = held.result?.permitId
  assert.ok(heldPermit !== undefined)

  const controller = new AbortController()
  const queued = acquire(server, 'W-0001', { signal: controller.signal })
  await waitUntil(() => harness.engine.modelSlotStats.queued === 1, 2_000, '请求进入队列')
  controller.abort()
  await assert.rejects(queued)
  await waitUntil(() => harness.engine.modelSlotStats.queued === 0, 2_000, '取消后队列清空')

  // A later request can still take the slot, proving the abort released it.
  await release(server, heldPermit)
  const next = await acquire(server, 'W-0001')
  assert.equal(next.ok, true)
  const nextPermit = next.result?.permitId
  if (nextPermit !== undefined) await release(server, nextPermit)
  assert.equal(harness.engine.modelSlotStats.active, 0)
})

// ---------------------------------------------------------------------------
// Harness plugin
// ---------------------------------------------------------------------------

type StreamListener = (
  options: { signal?: AbortSignal },
  next: () => AsyncIterable<unknown>,
) => AsyncIterable<unknown>

class FakePluginContext {
  listener: StreamListener | undefined
  private readonly disposers: (() => void)[] = []

  on(_event: 'llm/stream', listener: StreamListener): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  effect(callback: () => (() => void) | void): void {
    const dispose = callback()
    if (dispose !== undefined) this.disposers.push(dispose)
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers.length = 0
  }
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

interface PluginRuntime {
  harness: TestHarness
  server: ApiServer
  context: FakePluginContext
  listener: StreamListener
}

async function startPluginRuntime(t: TestContext, modelConcurrency: number): Promise<PluginRuntime> {
  const harness = await createHarness({ modelConcurrency })
  const server = await startRuntime(harness, modelConcurrency)
  const previous = {
    generation: process.env.LIEBIAN_GENERATION,
    url: process.env.LIEBIAN_DAEMON_URL,
    token: process.env.LIEBIAN_DAEMON_TOKEN,
    work: process.env.LIEBIAN_WORK,
  }
  process.env.LIEBIAN_DAEMON_URL = server.url
  process.env.LIEBIAN_DAEMON_TOKEN = server.token
  process.env.LIEBIAN_WORK = 'W-0001'
  process.env.LIEBIAN_GENERATION = '1'
  const context = new FakePluginContext()
  apply(context)
  const listener = context.listener
  assert.ok(listener !== undefined)

  t.after(async () => {
    context.dispose()
    await server.close()
    await harness.cleanup()
    for (const [name, value] of [
      ['LIEBIAN_GENERATION', previous.generation],
      ['LIEBIAN_DAEMON_URL', previous.url],
      ['LIEBIAN_DAEMON_TOKEN', previous.token],
      ['LIEBIAN_WORK', previous.work],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  return { harness, server, context, listener }
}

test('插件：10 个流式请求合计最多 4 个进入模型，异常流也会归还名额', async (t) => {
  const { harness, listener } = await startPluginRuntime(t, 4)

  let active = 0
  let maximum = 0
  const runStream = async (holdMs = 15): Promise<void> => {
    await consume(
      listener({}, async function* () {
        active += 1
        maximum = Math.max(maximum, active)
        try {
          await delay(holdMs)
          yield 'chunk'
        } finally {
          active -= 1
        }
      }),
    )
  }

  await Promise.all(Array.from({ length: 10 }, () => runStream()))
  assert.equal(maximum, 4)
  await waitUntil(() => harness.engine.modelSlotStats.active === 0, 2_000, '插件归还全部名额')

  // A stream that fails before yielding still releases its permit in finally.
  await assert.rejects(
    consume(
      listener({}, async function* () {
        throw new Error('模拟模型请求失败')
      }),
    ),
  )
  await waitUntil(() => harness.engine.modelSlotStats.active === 0, 2_000, '失败流归还名额')
  await runStream(1)
  await waitUntil(() => harness.engine.modelSlotStats.active === 0, 2_000, '后续流仍可运行')
})

test('插件：排队中的流被取消后，名额仍可正常使用', async (t) => {
  const { harness, listener } = await startPluginRuntime(t, 1)

  let releaseFirst: (() => void) | undefined
  const firstDone = consume(
    listener({}, async function* () {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      yield 'first'
    }),
  )
  await waitUntil(() => harness.engine.modelSlotStats.active === 1, 2_000, '第一个流持有名额')

  const controller = new AbortController()
  const cancelled = consume(
    listener({ signal: controller.signal }, async function* () {
      yield 'never'
    }),
  )
  await waitUntil(() => harness.engine.modelSlotStats.queued === 1, 2_000, '第二个流排队')
  controller.abort()
  await assert.rejects(cancelled)
  await waitUntil(() => harness.engine.modelSlotStats.queued === 0, 2_000, '取消后队列清空')

  if (releaseFirst === undefined) throw new Error('第一个流未启动')
  releaseFirst()
  await firstDone
  await waitUntil(() => harness.engine.modelSlotStats.active === 0, 2_000, '第一个流归还名额')

  await consume(
    listener({}, async function* () {
      yield 'after-cancel'
    }),
  )
  await waitUntil(() => harness.engine.modelSlotStats.active === 0, 2_000, '取消后仍可再次申请')
})
