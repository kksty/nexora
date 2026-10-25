import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { listenInPortRange, parsePort } from '../src/util/ports.ts'
import { waitForRuntimeReady } from '../src/web/readiness.ts'

test('host 端口绑定：占用时失败，多任务系统分配不冲突，非法配置拒绝', async (t) => {
  const first = createServer()
  const second = createServer()
  t.after(() => { first.close(); second.close() })
  await listenInPortRange(first, '0')
  const port = (first.address() as { port: number }).port
  await assert.rejects(listenInPortRange(second, String(port)), { code: 'PORT_RANGE_EXHAUSTED' })
  await listenInPortRange(second, '0')
  assert.notEqual((second.address() as { port: number }).port, port)
  for (const value of ['8000x', '', '-1', '65536']) assert.throws(() => parsePort(value))
  for (const range of ['50000-49999', '10000-60000', '1-2-3', '0-10']) {
    await assert.rejects(listenInPortRange(createServer(), range), { code: 'INVALID_ARGUMENT' })
  }
})

test('启动就绪：等待有效 PID；早退与超时必须报错', async () => {
  let polls = 0
  const result = await waitForRuntimeReady({ timeoutMs: 300, intervalMs: 1,
    running: async () => true, probe: async () => ++polls < 3 ? { pid: 0 } : { pid: 27 } })
  assert.equal(result.pid, 27)
  assert.equal(polls, 3)
  await assert.rejects(waitForRuntimeReady({ timeoutMs: 100, running: async () => false, probe: async () => ({ pid: 27 }) }), { code: 'TASK_START_FAILED' })
  await assert.rejects(waitForRuntimeReady({ timeoutMs: 15, intervalMs: 1, running: async () => true, probe: async () => null }), { code: 'TASK_START_TIMEOUT' })
})
