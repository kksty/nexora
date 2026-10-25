/** Offline, streaming summary of retained diagnostics; never contacts models. */
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

function distribution(values) {
  if (!values.length) return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null }
  values.sort((a, b) => a - b)
  const at = (p) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))]
  return { count: values.length, min: values[0], max: values.at(-1),
    mean: values.reduce((a, b) => a + b, 0) / values.length, p50: at(.5), p95: at(.95), p99: at(.99) }
}

export async function analyzeDiagnostics(input) {
  const root = resolve(input)
  const directory = await stat(join(root, 'runtime', 'logs')).then(() => join(root, 'runtime', 'logs')).catch(() => root)
  const files = (await readdir(directory)).filter((name) => /^diagnostics(?:-offline)?\.jsonl(?:\.\d+)?$/.test(name)).sort()
  const events = {}, apiErrors = {}, outcomes = {}, finishKinds = {}, boots = new Map(), requests = new Map(), tools = new Map()
  const durations = { waitMs: [], streamMs: [], firstChunkMs: [], firstTextMs: [], stateWriteMs: [], toolMs: [] }
  const usage = {}
  const samples = []
  const slowest = []
  let invalidLines = 0, unsupportedSchema = 0, usageRequests = 0, firstAt, lastAt
  let maxRss = 0, maxHeapUsed = 0, maxStateBytes = 0, maxWorkerRssKiB = 0, maxEventLoopP99Ms = 0
  let reclaimedActive = 0, reclaimedQueued = 0, failedStateWrites = 0
  const sourceFiles = []
  const runs = new Set()
  for (const name of files) {
    const file = join(directory, name)
    sourceFiles.push({ name, bytes: (await stat(file)).size })
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { invalidLines++; continue }
      if (event.schema !== 1) { unsupportedSchema++; continue }
      const data = event.data ?? {}
      events[event.event] = (events[event.event] ?? 0) + 1
      if (typeof event.at === 'string') {
        if (firstAt === undefined || event.at < firstAt) firstAt = event.at
        if (lastAt === undefined || event.at > lastAt) lastAt = event.at
      }
      if (data.runId) runs.add(data.runId)
      const boot = boots.get(event.bootId) ?? { dropped: 0, failedWrites: 0 }
      boot.dropped = Math.max(boot.dropped, event.dropped ?? 0)
      boot.failedWrites = Math.max(boot.failedWrites, event.failedWrites ?? 0)
      boots.set(event.bootId, boot)
      if (event.event === 'api-error') apiErrors[data.code] = (apiErrors[data.code] ?? 0) + 1
      if (event.event === 'worker-exit') {
        reclaimedActive += data.reclaimed?.active ?? 0
        reclaimedQueued += data.reclaimed?.queued ?? 0
      }
      if (event.event === 'state-write') {
        if (data.ok === true && Number.isFinite(data.durationMs)) durations.stateWriteMs.push(data.durationMs)
        if (data.ok === false) failedStateWrites++
      }
      if (data.permitId && ['model-queued', 'model-acquired', 'model-finished'].includes(event.event)) {
        const key = event.bootId + ':' + data.permitId
        const request = requests.get(key) ?? { permitId: data.permitId, workId: data.workId, generation: data.generation }
        if (event.event === 'model-queued') request.queued = true
        if (event.event === 'model-acquired') request.acquired = true
        if (event.event === 'model-finished' && !request.finished) {
          request.finished = true
          const metrics = data.metrics ?? {}
          const outcome = metrics.outcome ?? 'unknown'
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
          if (metrics.finishReason?.kind) finishKinds[metrics.finishReason.kind] = (finishKinds[metrics.finishReason.kind] ?? 0) + 1
          for (const name of ['waitMs', 'streamMs', 'firstChunkMs', 'firstTextMs']) {
            if (Number.isFinite(metrics[name])) durations[name].push(metrics[name])
          }
          if (metrics.usage && typeof metrics.usage === 'object') {
            usageRequests++
            for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
              if (Number.isFinite(metrics.usage[key])) usage[key] = (usage[key] ?? 0) + metrics.usage[key]
            }
          }
          slowest.push({ ...request, at: event.at, model: metrics.model, outcome, streamMs: metrics.streamMs, waitMs: metrics.waitMs })
          slowest.sort((a, b) => (b.streamMs ?? 0) - (a.streamMs ?? 0))
          if (slowest.length > 20) slowest.pop()
        }
        requests.set(key, request)
      }
      if (event.event === 'activity' && data.accepted && data.callId) {
        const key = event.bootId + ':' + data.workId + ':' + data.generation + ':' + data.callId
        const tool = tools.get(key) ?? {}
        if (data.kind === 'tool-call') tool.start = Date.parse(data.at)
        if (data.kind === 'tool-result') tool.end = Date.parse(data.at)
        tools.set(key, tool)
      }
      if (event.event === 'runtime-sample') {
        maxRss = Math.max(maxRss, data.memory?.rss ?? 0)
        maxHeapUsed = Math.max(maxHeapUsed, data.memory?.heapUsed ?? 0)
        maxStateBytes = Math.max(maxStateBytes, data.stateBytes ?? 0)
        maxEventLoopP99Ms = Math.max(maxEventLoopP99Ms, data.eventLoopP99Ms ?? 0)
        for (const worker of data.processes ?? []) maxWorkerRssKiB = Math.max(maxWorkerRssKiB, worker.rssKiB ?? 0)
        samples.push({ at: event.at, bootId: event.bootId, runId: data.runId, stateBytes: data.stateBytes,
          rss: data.memory?.rss, heapUsed: data.memory?.heapUsed, cpuUserUs: data.cpuUserUs,
          cpuSystemUs: data.cpuSystemUs, elapsedMs: data.elapsedMs, modelSlots: data.modelSlots,
          findings: data.findings, messages: data.messages, worksTotal: data.worksTotal })
      }
    }
  }
  for (const tool of tools.values()) if (Number.isFinite(tool.start) && Number.isFinite(tool.end) && tool.end >= tool.start) durations.toolMs.push(tool.end - tool.start)
  samples.sort((a, b) => a.at.localeCompare(b.at))
  return {
    schema: 1, generatedAt: new Date().toISOString(), directory, sourceFiles,
    range: { firstAt, lastAt }, bootCount: boots.size, runs: [...runs], events,
    integrity: { invalidLines, unsupportedSchema,
      dropped: [...boots.values()].reduce((sum, b) => sum + b.dropped, 0),
      failedWrites: [...boots.values()].reduce((sum, b) => sum + b.failedWrites, 0) },
    model: { observedRequests: requests.size, finished: Object.values(outcomes).reduce((a, b) => a + b, 0),
      usageRequests, usage, outcomes, finishKinds, slowest,
      withoutFinishInRetainedLogs: [...requests.values()].filter((r) => !r.finished).slice(0, 100) },
    latency: Object.fromEntries(Object.entries(durations).map(([key, values]) => [key, distribution(values)])),
    reliability: { apiErrors, failedStateWrites, reclaimedActive, reclaimedQueued },
    resources: { maxRss, maxHeapUsed, maxStateBytes, maxWorkerRssKiB, maxEventLoopP99Ms, sampleCount: samples.length, samples: samples.slice(-1000) },
    limitations: ['Only retained rotating logs are included; missing finish can mean rotation, crash, reclaim or an active request.',
      'Missing provider token fields remain unknown; no token estimates or quality scores are invented.',
      'For answer quality, correlate task state, findings, reports and original runtime/sessions using work/session/run IDs.',
      'Copy logs after stopping or pausing writes for a consistent snapshot; analysis of live rotating files is best effort.'],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2)
  if (!input) throw new Error('Usage: node scripts/analyze-diagnostics.mjs <task directory or logs directory> [output.json]')
  const summary = await analyzeDiagnostics(input)
  const json = JSON.stringify(summary, null, 2) + '\n'
  if (output) { await writeFile(resolve(output), json); console.log(resolve(output)) }
  else process.stdout.write(json)
}

