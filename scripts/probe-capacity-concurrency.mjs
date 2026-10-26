/**
 * Bounded local semaphore capacity probe.
 *
 * This measures only the task-level model-request gate implemented by
 * src/util/semaphore.ts. It sends no model request, opens no network connection,
 * and writes no task data. Timings describe Node scheduling and synthetic work
 * on this host; they are not tokens/sec, RPM/TPM capacity, provider latency, or a
 * production concurrency limit.
 *
 * Usage:
 *   node scripts/probe-capacity-concurrency.mjs
 *   node scripts/probe-capacity-concurrency.mjs --permits=2 --works=8 \
 *     --requests-per-work=5 --hold-ms=50 --tasks=3
 *   node scripts/probe-capacity-concurrency.mjs \
 *     --report=.scratch/capacity-concurrency/pools.json
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Semaphore } from '../src/util/semaphore.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
const scratch = resolve(repo, '.scratch')

function positiveInteger(name, fallback, maximum) {
  const prefix = `--${name}=`
  const argument = process.argv.find((value) => value.startsWith(prefix))
  if (argument === undefined) return fallback
  const text = argument.slice(prefix.length)
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`--${name} 必须是 1..${maximum} 的整数，收到：${text}`)
  }
  return value
}

function nonNegativeInteger(name, fallback, maximum) {
  const prefix = `--${name}=`
  const argument = process.argv.find((value) => value.startsWith(prefix))
  if (argument === undefined) return fallback
  const text = argument.slice(prefix.length)
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`--${name} 必须是 0..${maximum} 的整数，收到：${text}`)
  }
  return value
}

const permits = positiveInteger('permits', 2, 64)
const works = positiveInteger('works', 8, 1_000)
const requestsPerWork = positiveInteger('requests-per-work', 5, 1_000)
const holdMs = nonNegativeInteger('hold-ms', 25, 10_000)
const tasks = positiveInteger('tasks', 3, 20)
const reportArgument = argumentValue('report', '')
const reportPath = reportArgument.length === 0 ? null : guardedScratchPath(reportArgument)
const knownArguments = /^--(permits|works|requests-per-work|hold-ms|tasks)=\d+$/
const unknown = process.argv.slice(2).filter(
  (value) => !knownArguments.test(value) && !/^--report=.+$/.test(value),
)
if (unknown.length > 0) throw new Error(`未知参数：${unknown.join(', ')}`)

function argumentValue(name, fallback) {
  const prefix = `--${name}=`
  const argument = process.argv.find((value) => value.startsWith(prefix))
  return argument === undefined ? fallback : argument.slice(prefix.length)
}

function guardedScratchPath(value) {
  const path = resolve(repo, value)
  const within = relative(scratch, path)
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || within.startsWith(sep)) {
    throw new Error(`--report 必须位于仓库 .scratch 目录内：${path}`)
  }
  return path
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits))
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    samples: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
  }
}

function mib(bytes) {
  return round(bytes / (1024 * 1024))
}

/**
 * Measure one independent semaphore pool. Each work issues synthetic requests
 * sequentially; different works compete only inside their own task pool.
 */
async function runPool(taskNumber, aggregate) {
  const semaphore = new Semaphore(permits)
  const waits = []
  const durations = []
  let active = 0
  let maximumActive = 0
  let maximumQueued = 0
  let acquireRejections = 0
  const started = performance.now()

  async function request(workNumber, requestNumber) {
    const permitId = `${taskNumber}-${workNumber}-${requestNumber}-${randomUUID()}`
    const waitStarted = performance.now()
    let permit
    try {
      permit = await semaphore.acquire({ workId: `W-${workNumber}`, permitId })
    } catch {
      acquireRejections += 1
      throw new Error('合成请求未取得名额')
    }
    waits.push(performance.now() - waitStarted)
    active += 1
    aggregate.active += 1
    aggregate.maximumActive = Math.max(aggregate.maximumActive, aggregate.active)
    maximumActive = Math.max(maximumActive, active)
    maximumQueued = Math.max(maximumQueued, semaphore.stats.queued)
    const workStarted = performance.now()
    try {
      if (holdMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, holdMs))
      else await Promise.resolve()
      assert.equal(semaphore.owner(permit.permitId)?.workId, permit.workId)
    } finally {
      active -= 1
      aggregate.active -= 1
      assert.equal(semaphore.release(permit.permitId), true)
      assert.equal(semaphore.release(permit.permitId), false, '重复归还不应再次释放名额')
    }
    durations.push(performance.now() - workStarted)
  }

  const workRuns = []
  for (let workNumber = 1; workNumber <= works; workNumber += 1) {
    workRuns.push((async () => {
      for (let requestNumber = 1; requestNumber <= requestsPerWork; requestNumber += 1) {
        await request(workNumber, requestNumber)
      }
    })())
  }
  await Promise.all(workRuns)
  const wallMs = performance.now() - started
  assert.deepEqual(semaphore.stats, { limit: permits, active: 0, queued: 0 })
  assert.ok(maximumActive <= permits, `任务 ${taskNumber} 活跃数超过限制`)
  semaphore.close()
  return {
    task: taskNumber,
    permits,
    works,
    requestsPerWork,
    requests: works * requestsPerWork,
    wallMs: round(wallMs),
    maximumActive,
    maximumQueued,
    acquireRejections,
    waitMs: stats(waits),
    heldWorkMs: stats(durations),
    finalSlots: { limit: permits, active: 0, queued: 0 },
  }
}

const startedAt = new Date().toISOString()
const wallStarted = performance.now()
const memoryBefore = process.memoryUsage()
const aggregate = { active: 0, maximumActive: 0 }
const pools = await Promise.all(
  Array.from({ length: tasks }, (_, index) => runPool(index + 1, aggregate)),
)
const wallMs = performance.now() - wallStarted
const memoryAfter = process.memoryUsage()
const totalRequests = pools.reduce((sum, pool) => sum + pool.requests, 0)
assert.equal(aggregate.active, 0, '全部任务完成后不应残留跨任务活跃名额')
const report = {
  probe: 'capacity-concurrency',
  classification:
    'bounded local semaphore scheduling smoke test; not model/server throughput or a production capacity claim',
  startedAt,
  completedAt: new Date().toISOString(),
  wallMs: round(wallMs),
  platform: process.platform,
  architecture: process.arch,
  node: process.versions.node,
  host: {
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryMiB: mib(totalmem()),
  },
  parameters: { permits, works, requestsPerWork, holdMs, tasks },
  summary: {
    totalRequests,
    theoreticalTaskPeak: tasks * permits,
    observedLargestTaskActive: Math.max(...pools.map((pool) => pool.maximumActive)),
    observedAggregateActiveMaximum: aggregate.maximumActive,
    localSchedulingRequestsPerSecond: round((totalRequests * 1000) / wallMs),
  },
  memory: {
    rssMiB: mib(memoryAfter.rss),
    heapUsedMiB: mib(memoryAfter.heapUsed),
    rssDeltaMiB: mib(memoryAfter.rss - memoryBefore.rss),
  },
  pools,
  interpretation: {
    perTaskLimit: 'Each pool independently allows its configured permits.',
    aggregate:
      'Task pools run at the same time and do not share permits. observedAggregateActiveMaximum is a shared instantaneous counter of concurrently granted synthetic requests.',
    unavailableFromThisProbe: [
      'provider RPM/TPM',
      'tokens per second',
      'model latency and timeouts',
      '429 behavior',
      'long-context KV cache memory',
      'server maximum context',
      'maximum number of active works',
    ],
  },
  controls: { callsModel: false, usesNetwork: false, usesDocker: false, writesUserTasks: false },
}

console.log(
  `[capacity] permits=${permits} tasks=${tasks} works/task=${works} ` +
  `requests=${totalRequests} holdMs=${holdMs} wallMs=${report.wallMs} ` +
  `maxActivePerTask=${report.summary.observedLargestTaskActive} ` +
  `rssMiB=${report.memory.rssMiB}`,
)
console.log(JSON.stringify({ ok: true, report }, null, 2))
if (reportPath !== null) {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}
