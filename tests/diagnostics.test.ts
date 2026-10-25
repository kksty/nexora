import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DiagnosticLog, activityDiagnostic } from '../src/util/diagnostics.ts'

test('诊断日志：轮转有界、顺序可追踪，凭据和正文不进入指标', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'liebian-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const log = new DiagnosticLog(join(root, 'diagnostics.jsonl'), { taskId: 'T-test' }, { maxBytes: 1800, files: 3 })
  for (let i = 0; i < 80; i++) log.record('event', { i, authorization: 'Bearer super-secret', apiKey: 'super-secret', message: 'Bearer super-secret' })
  await log.flush()
  const files = await readdir(root)
  assert.equal(files.length, 3)
  const sequences: number[] = []
  for (const file of files) {
    const data = await readFile(join(root, file), 'utf8')
    assert.ok(Buffer.byteLength(data) <= 1800)
    assert.ok(!data.includes('super-secret'))
    for (const line of data.split('\n').filter(Boolean)) sequences.push(JSON.parse(line).seq)
  }
  assert.equal(new Set(sequences).size, sequences.length)
  assert.equal(Math.max(...sequences), 80)
  const activity = activityDiagnostic({ kind: 'tool-call', name: 'bash', arguments: 'password=hidden' })
  assert.equal(activity.arguments, undefined)
  assert.equal(activity.argumentBytes, 15)
})

test('诊断日志：慢盘队列有界，溢出计数可见；坏路径不影响任务', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'liebian-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'log.jsonl')
  const log = new DiagnosticLog(file, {}, { maxQueueBytes: 800, warn: () => {} })
  for (let i = 0; i < 100; i++) log.record('burst', { i })
  assert.ok(log.stats.queuedBytes <= 800)
  await log.flush()
  assert.ok(log.stats.dropped > 0)
  log.record('recovered')
  await log.flush()
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  assert.ok(JSON.parse(lines.at(-1)!).dropped > 0)
  const blocker = join(root, 'blocked')
  await writeFile(blocker, 'file')
  const broken = new DiagnosticLog(join(blocker, 'out.jsonl'), {}, { warn: () => {} })
  broken.record('event')
  await broken.flush()
  assert.equal(broken.stats.failedWrites, 1)
})

test('诊断日志：崩溃留下的半行不会吞掉重启后的第一条事件', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'liebian-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'log.jsonl')
  await writeFile(file, '{"broken":')
  const log = new DiagnosticLog(file, {})
  log.record('restart')
  await log.flush()
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  assert.equal(JSON.parse(lines[1]).event, 'restart')
})

test('日志汇总：跨轮转计算用量与耗时，保留缺失用量和截断计数', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'liebian-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const log = new DiagnosticLog(join(root, 'diagnostics.jsonl'), { taskId: 'T-summary' })
  log.record('model-queued', { permitId: 'one', workId: 'W-1', runId: 'R-1' })
  log.record('model-finished', { permitId: 'one', metrics: { outcome: 'completed', streamMs: 20, waitMs: 5, usage: { inputTokens: 7, outputTokens: 3 } } })
  log.record('model-finished', { permitId: 'two', metrics: { outcome: 'error', streamMs: 40 } })
  await log.flush()
  await writeFile(join(root, 'diagnostics.jsonl.1'), '{partial\n')
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/analyze-diagnostics.mjs', import.meta.url)), root], { windowsHide: true })
  const summary = JSON.parse(stdout)
  assert.equal(summary.model.finished, 2)
  assert.equal(summary.model.usageRequests, 1)
  assert.equal(summary.model.usage.inputTokens, 7)
  assert.equal(summary.latency.streamMs.mean, 30)
  assert.equal(summary.integrity.invalidLines, 1)
})

