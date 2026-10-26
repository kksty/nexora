/**
 * Bounded synthetic growth probe for the authoritative state document.
 *
 * This is a short, repeatable smoke test, not a soak test. It writes deterministic
 * findings and messages through the production Engine persistence path into an
 * isolated .scratch directory. No model, network, Docker, or user task is used.
 *
 * Usage:
 *   node scripts/probe-state-growth.mjs
 *   node scripts/probe-state-growth.mjs --rounds=6 --findings=200 --messages=100
 *   node scripts/probe-state-growth.mjs --keep
 *   node scripts/probe-state-growth.mjs --rounds=1 --findings=500 --messages=250 \
 *     --save-samples=7 --report=.scratch/capacity-state-growth/scale-500.json
 *
 * --keep retains the synthetic task and JSON report under the probe directory.
 * --report additionally writes a compact machine-readable report at the given
 * path, which must be inside the repository's .scratch directory. Defaults
 * clean the synthetic task directory created by this invocation.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from '../src/core/engine.ts'
import { makeTaskPaths } from '../src/core/paths.ts'
import { createTask } from '../src/core/task.ts'
import { loadState, saveState, serializeState } from '../src/core/state.ts'
import { nullLogger } from '../src/util/log.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
const scratchRoot = join(repo, '.scratch', 'state-growth-probe')
const taskId = 'T-growth-probe'
const sampledEntries = 7

function parsePositiveInteger(name, fallback, maximum) {
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

const rounds = parsePositiveInteger('rounds', 5, 20)
const findingsPerRound = parsePositiveInteger('findings', 120, 2_000)
const messagesPerRound = parsePositiveInteger('messages', 60, 1_000)
const saveSamples = parsePositiveInteger('save-samples', 5, 30)
const keep = process.argv.includes('--keep')
const label = argumentValue('label', `synthetic-${rounds}x${findingsPerRound}-${messagesPerRound}`)
if (!/^[A-Za-z0-9._-]{1,80}$/.test(label)) {
  throw new Error(`--label 只能包含字母、数字、点、下划线和连字符，且不超过 80 字符：${label}`)
}
const reportArgument = argumentValue('report', '')
const reportPath = reportArgument.length === 0 ? null : guardedScratchPath(reportArgument)
const unknownArguments = process.argv.slice(2).filter(
  (value) =>
    value !== '--keep' &&
    !/^--(rounds|findings|messages|save-samples)=\d+$/.test(value) &&
    !/^--label=[A-Za-z0-9._-]{1,80}$/.test(value) &&
    !/^--report=.+$/.test(value),
)
if (unknownArguments.length > 0) {
  throw new Error(`未知参数：${unknownArguments.join(', ')}`)
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits))
}

function mib(bytes) {
  return round(bytes / (1024 * 1024))
}

function timed(action) {
  const started = performance.now()
  return Promise.resolve(action()).then((result) => ({
    result,
    durationMs: round(performance.now() - started),
  }))
}

function argumentValue(name, fallback) {
  const prefix = `--${name}=`
  const argument = process.argv.find((value) => value.startsWith(prefix))
  return argument === undefined ? fallback : argument.slice(prefix.length)
}

function guardedScratchPath(value) {
  const path = resolve(repo, value)
  const scratch = resolve(repo, '.scratch')
  const withinScratch = relative(scratch, path)
  if (
    withinScratch === '' ||
    withinScratch === '..' ||
    withinScratch.startsWith(`..${sep}`) ||
    withinScratch.startsWith(sep)
  ) {
    throw new Error(`--report 必须位于仓库 .scratch 目录内：${path}`)
  }
  return path
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index]
}

function timingStats(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    samples: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
  }
}

async function directoryUsage(directory) {
  let bytes = 0
  let files = 0
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        bytes += (await lstat(path)).size
        files += 1
      }
    }
  }
  await visit(directory)
  return { bytes, files }
}

async function fileSize(path) {
  return stat(path).then((info) => info.size, () => 0)
}

/**
 * Reduce the full state to deterministic IDs, counts and sampled record hashes.
 * This detects loss or reordering of the synthetic records without publishing
 * the generated bodies in the summary.
 */
function integritySnapshot(state) {
  const findings = state.findings.map((finding) => ({
    id: finding.id,
    authorWorkId: finding.authorWorkId,
    fingerprint: digest(JSON.stringify(finding)),
  }))
  const messages = state.messages.map((message) => ({
    id: message.id,
    fromWorkId: message.fromWorkId,
    toWorkId: message.toWorkId,
    fingerprint: digest(JSON.stringify(message)),
  }))
  const sampled = {
    findings: findings.filter((_, index) => index % Math.max(1, Math.ceil(findings.length / sampledEntries)) === 0),
    messages: messages.filter((_, index) => index % Math.max(1, Math.ceil(messages.length / sampledEntries)) === 0),
  }
  return {
    findingCount: findings.length,
    messageCount: messages.length,
    counters: { ...state.counters },
    sharedStateVersion: state.sharedStateVersion,
    findingsIdsHash: digest(findings.map((item) => item.id).join(',')),
    messagesIdsHash: digest(messages.map((item) => item.id).join(',')),
    sampled,
  }
}

async function measureRound(engine, paths, number) {
  const beforeMemory = process.memoryUsage()
  const {
    result: reloaded,
    durationMs: initialReadMs,
  } = await timed(() => loadState(paths))
  const inMemory = integritySnapshot(engine.state)
  const onDisk = integritySnapshot(reloaded)
  assert.deepEqual(onDisk, inMemory, `第 ${number} 轮重载后的状态摘要不一致`)
  assert.equal(reloaded.taskId, taskId, `第 ${number} 轮 task ID 不一致`)
  assert.equal(reloaded.schemaVersion, 5, `第 ${number} 轮 schemaVersion 不是 5`)
  assert.equal(reloaded.counters.finding, reloaded.findings.length, `第 ${number} 轮 finding 计数器不一致`)
  assert.equal(reloaded.counters.message, reloaded.messages.length, `第 ${number} 轮 message 计数器不一致`)
  for (const [index, finding] of reloaded.findings.entries()) {
    assert.equal(finding.id, `F-${String(index + 1).padStart(4, '0')}`, 'finding ID 顺序或连续性不一致')
  }
  for (const [index, message] of reloaded.messages.entries()) {
    assert.equal(message.id, `M-${String(index + 1).padStart(4, '0')}`, 'message ID 顺序或连续性不一致')
  }

  const writeMsSamples = []
  const readMsSamples = []
  for (let sample = 0; sample < saveSamples; sample += 1) {
    writeMsSamples.push((await timed(() => saveState(paths, engine.state))).durationMs)
    const measurement = await timed(() => loadState(paths))
    readMsSamples.push(measurement.durationMs)
    assert.deepEqual(
      integritySnapshot(measurement.result),
      inMemory,
      `第 ${number} 轮第 ${sample + 1} 次重复保存重载后的状态摘要不一致`,
    )
  }

  const serialized = serializeState(engine.state)
  const finalReload = await loadState(paths)
  assert.deepEqual(
    integritySnapshot(finalReload),
    inMemory,
    `第 ${number} 轮重复保存后的最终状态摘要不一致`,
  )
  const disk = await stat(paths.stateFile)
  assert.equal(disk.size, Buffer.byteLength(serialized), `第 ${number} 轮文件大小与序列化结果不一致`)
  const stateWrite = timingStats(writeMsSamples)
  const stateRead = timingStats(readMsSamples)
  const directory = await directoryUsage(paths.taskDir)
  const memory = process.memoryUsage()
  return {
    round: number,
    findings: inMemory.findingCount,
    messages: inMemory.messageCount,
    sharedStateVersion: inMemory.sharedStateVersion,
    stateBytes: disk.size,
    stateMiB: mib(disk.size),
    stateWriteMs: stateWrite,
    stateReadMs: stateRead,
    // Backward-compatible single value: the repeated-read median.
    readMs: stateRead.p50Ms,
    initialReadMs,
    files: {
      taskMarkdownBytes: await fileSize(paths.taskFile),
      findingsMarkdownBytes: await fileSize(paths.findingsFile),
      worksMarkdownBytes: await fileSize(paths.worksFile),
      journalBytes: await fileSize(paths.journalFile),
      taskDirectoryBytes: directory.bytes,
      taskDirectoryFiles: directory.files,
    },
    serializedDigest: digest(serialized),
    keysHash: digest(
      JSON.stringify({
        findings: inMemory.findingsIdsHash,
        messages: inMemory.messagesIdsHash,
      }),
    ),
    sampled: inMemory.sampled,
    memory: {
      rssMiB: mib(memory.rss),
      heapUsedMiB: mib(memory.heapUsed),
      rssDeltaMiB: mib(memory.rss - beforeMemory.rss),
    },
  }
}

async function writeReport(path, report) {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

const topLevelScratch = resolve(scratchRoot)
const repoScratch = resolve(repo, '.scratch')
const relativeScratch = relative(repoScratch, topLevelScratch)
if (relativeScratch.startsWith(`..${sep}`) || relativeScratch === '..' || relativeScratch.startsWith(sep)) {
  throw new Error(`拒绝在 .scratch/state-growth-probe 之外清理：${topLevelScratch}`)
}

await mkdir(scratchRoot, { recursive: true })
const runRoot = await mkdtemp(join(scratchRoot, 'run-'))
const paths = makeTaskPaths(join(runRoot, 'tasks'), taskId)
const statePath = paths.stateFile
let engine
let report

try {
  await createTask(paths, {
    startInformation: '合成状态增长探针，不包含用户资料。',
    endInformation: '验证有限轮次的状态写入、读取与完整性。',
  })
  engine = await Engine.open({
    paths,
    driver: inertDriver(),
    logger: nullLogger,
    retry: { initialMs: 20, factor: 2, maxMs: 100, jitter: 0 },
  })
  await engine.start()
  assert.equal(await engine.whenQuiet(), true, '合成运行时未进入静止状态')
  await engine.spawnWork('W-0001', {
    reason: '合成状态增长探针',
    start_prompt: '不调用模型，仅验证状态持久化。',
    request_id: 'growth-probe-spawn',
  })
  assert.equal(await engine.whenQuiet(), true, '第二个合成 work 未进入静止状态')

  const payload = 'synthetic-growth-record-'.repeat(64)
  const points = []
  const startedAt = new Date().toISOString()
  const wallStarted = performance.now()
  for (let number = 1; number <= rounds; number += 1) {
    const additions = []
    for (let index = 0; index < findingsPerRound; index += 1) {
      const author = index % 2 === 0 ? 'W-0001' : 'W-0002'
      additions.push(engine.appendFinding(author, {
        text: `${payload} finding ${number}-${index}`,
        type: 'synthetic-growth',
      }))
    }
    for (let index = 0; index < messagesPerRound; index += 1) {
      const [from, to] = index % 2 === 0 ? ['W-0001', 'W-0002'] : ['W-0002', 'W-0001']
      additions.push(engine.sendMessage(from, {
        to: [to],
        kind: 'hint',
        body: `${payload} message ${number}-${index}`,
      }))
    }

    const {
      durationMs: batchWriteMs,
    } = await timed(() => Promise.all(additions))
    assert.equal(await engine.whenQuiet(), true, `第 ${number} 轮异步写入未进入静止状态`)
    const point = await measureRound(engine, paths, number)
    points.push({ ...point, batchWriteMs })
    console.log(
      `[growth] round=${number} findings=${point.findings} messages=${point.messages} ` +
      `bytes=${point.stateBytes} batchWriteMs=${batchWriteMs} ` +
      `saveP50Ms=${point.stateWriteMs.p50Ms} saveP95Ms=${point.stateWriteMs.p95Ms} ` +
      `readP50Ms=${point.stateReadMs.p50Ms} readP95Ms=${point.stateReadMs.p95Ms} ` +
      `rssMiB=${point.memory.rssMiB} heapUsedMiB=${point.memory.heapUsedMiB}`,
    )
  }

  const finalPoint = points.at(-1)
  assert.ok(finalPoint !== undefined)
  assert.equal(finalPoint.findings, rounds * findingsPerRound)
  assert.equal(finalPoint.messages, rounds * messagesPerRound)
  // Load and compare the same immutable last committed bytes sampled above.
  // Engine.close() and asynchronous post-turn bookkeeping may legitimately
  // change runtimeStatus after this measurement; those changes are not part of
  // this synthetic append test's integrity boundary.
  const finalState = await loadState(paths)
  assert.deepEqual(
    JSON.parse(await readFile(statePath, 'utf8')),
    JSON.parse(serializeState(finalState)),
    '重载后的完整 JSON 状态与最终持久化状态不一致',
  )

  const finalBytes = (await stat(statePath)).size
  report = {
    probe: 'state-growth',
    classification: 'bounded synthetic growth smoke test; not a long-running soak test',
    startedAt,
    completedAt: new Date().toISOString(),
    wallTimeMs: round(performance.now() - wallStarted),
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    host: {
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      totalMemoryMiB: mib(totalmem()),
    },
    label,
    taskId,
    rounds,
    findingsPerRound,
    messagesPerRound,
    saveSamples,
    payloadChars: payload.length,
    points,
    final: {
      ...finalPoint,
      serializedBytes: finalBytes,
      fileMatchesSerialization: true,
      integrity: integritySnapshot(engine.state),
    },
    controls: {
      callsModel: false,
      usesDocker: false,
      usesNetwork: false,
      writesUserTasks: false,
      tempRoot: relative(repo, runRoot),
    },
  }
  console.log(JSON.stringify({ ok: true, report }, null, 2))
  if (keep) await writeReport(join(runRoot, 'growth-report.json'), report)
  if (reportPath !== null) {
    await mkdir(resolve(reportPath, '..'), { recursive: true })
    await writeReport(reportPath, report)
  }
} finally {
  if (engine !== undefined) await engine.close('growth-probe-finished').catch(() => undefined)
  if (!keep) {
    const resolvedRun = resolve(runRoot)
    if (!resolvedRun.startsWith(`${topLevelScratch}${sep}`)) {
      throw new Error(`拒绝清理探针目录之外的路径：${resolvedRun}`)
    }
    // The CodeBuddy host wrapper can report ENOTEMPTY during recursive delete.
    // Retry only this probe-owned directory and verify it is absent.
    await rm(resolvedRun, { recursive: true, force: true }).catch(() => undefined)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await stat(resolvedRun).then(() => false, () => true)) break
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      await rm(resolvedRun, { recursive: true, force: true }).catch(() => undefined)
    }
    if (await stat(resolvedRun).then(() => true, () => false)) {
      throw new Error(`探针临时目录未能清理：${resolvedRun}`)
    }
  }
}

function inertDriver() {
  // Deliberately a no-op test driver: this probe measures state persistence and
  // must never invoke a model or Docker.
  return {
    async ensure(spec) {
      return { resumed: spec.sessionStarted, freshFallback: false, generation: 1 }
    },
    async prompt() {
      return { messageId: 'synthetic-growth-probe' }
    },
    async waitForIdle() {},
    async quiesce() {},
    async stop() {},
    async stopAll() {},
  }
}

