import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { CURRENT_SCHEMA_VERSION, loadState } from '../src/core/state.ts'
import { createHarness } from './support/harness.ts'

test('schemaVersion=1 的任务升级到 5 时保留 v1 备份、旧 ID 和活动字段', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const raw = JSON.parse(await readFile(harness.paths.stateFile, 'utf8')) as {
    schemaVersion: number
    works: Record<string, { id: string; activity?: unknown; runId?: string; origin?: string }>
  }
  raw.schemaVersion = 1
  delete (raw as { runs?: unknown }).runs
  delete (raw as { currentRunId?: unknown }).currentRunId
  for (const work of Object.values(raw.works)) {
    delete work.activity
    delete work.runId
    delete work.origin
  }
  await writeFile(harness.paths.stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

  const state = await loadState(harness.paths)
  assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION)
  assert.equal(state.works['W-0001']?.id, 'W-0001')
  assert.ok(state.works['W-0001']?.activity)
  assert.equal(state.works['W-0001']?.activity.generation, 0)
  assert.deepEqual(state.commands, [])
  assert.equal(state.counters.command, 0)
  assert.deepEqual(state.reports, {})
  assert.deepEqual(state.reportPublishes, {})
  assert.equal(state.runs.length, 1)
  assert.equal(state.currentRunId, 'R-0001')
  assert.equal(state.runs[0]?.status, 'active')
  assert.equal(state.runs[0]?.cleanup, 'none')
  assert.equal(state.works['W-0001']?.runId, 'R-0001')
  assert.equal(state.works['W-0001']?.origin, 'initial')
  assert.deepEqual(state.runs[0]?.workIds, ['W-0001'])

  const backup = JSON.parse(
    await readFile(join(harness.paths.runtimeDir, 'state.v1.backup.json'), 'utf8'),
  ) as { schemaVersion: number }
  assert.equal(backup.schemaVersion, 1)
})

test('schemaVersion=2 的任务升级到 5 时保留命令记录并修正 command 计数器', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const sent = await harness.engine.sendCommand({ text: '升级前保存的命令', requestId: 'migrate-1' })

  const raw = JSON.parse(await readFile(harness.paths.stateFile, 'utf8')) as {
    schemaVersion: number
    counters: Record<string, number>
    commands: { id: string; deliveries: Record<string, { status: string }>; runId?: string }[]
  }
  raw.schemaVersion = 2
  delete raw.counters.command
  delete (raw as { runs?: unknown }).runs
  delete (raw as { currentRunId?: unknown }).currentRunId
  for (const command of raw.commands) delete command.runId
  await writeFile(harness.paths.stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

  const state = await loadState(harness.paths)
  assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION)
  assert.equal(state.counters.command, sent.command.sequence, '计数器至少覆盖已存在的命令，避免重复 ID')
  assert.equal(state.commands.length, 1)
  assert.equal(state.commands[0]?.id, sent.command.id)
  assert.equal(state.commands[0]?.runId, 'R-0001')
  assert.equal(state.commands[0]?.deliveries['W-0001']?.status, 'saved')
  assert.deepEqual(state.runs[0]?.commandIds, [sent.command.id])

  const backup = JSON.parse(
    await readFile(join(harness.paths.runtimeDir, 'state.v2.backup.json'), 'utf8'),
  ) as { schemaVersion: number }
  assert.equal(backup.schemaVersion, 2)
})

test('schemaVersion=3 的任务升级到 5 时补齐报告字段、保留发现与终态', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const finding = await harness.engine.appendFinding('W-0001', { text: '升级前的发现' })

  const raw = JSON.parse(await readFile(harness.paths.stateFile, 'utf8')) as Record<string, unknown>
  raw.schemaVersion = 3
  delete raw.reports
  delete raw.reportPublishes
  delete raw.runs
  delete raw.currentRunId
  await writeFile(harness.paths.stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

  const state = await loadState(harness.paths)
  assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION)
  assert.equal(state.findings[0]?.id, finding.id)
  assert.deepEqual(state.reports, {})
  assert.deepEqual(state.reportPublishes, {})
  assert.equal(state.status, 'active')
  assert.equal(state.currentRunId, 'R-0001')

  const backup = JSON.parse(
    await readFile(join(harness.paths.runtimeDir, 'state.v3.backup.json'), 'utf8'),
  ) as { schemaVersion: number }
  assert.equal(backup.schemaVersion, 3)
})

test('schemaVersion=4 的已结束任务升级到 5：终态放入首个 run 且不自动执行', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '升级前完成' })
  await harness.engine.respondCompletion('W-0001', { round_id: proposal.round.id, opinion: 'agree' })
  const deadline = Date.now() + 3_000
  while (harness.engine.state.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await harness.engine.close('before-migration')
  assert.equal(harness.engine.state.status, 'completed')

  const raw = JSON.parse(await readFile(harness.paths.stateFile, 'utf8')) as Record<string, unknown> & {
    works: Record<string, { runId?: string; origin?: string }>
    rounds: { runId?: string; id: string }[]
    completion: { runId?: string; roundId: string } | null
  }
  raw.schemaVersion = 4
  delete raw.runs
  delete raw.currentRunId
  for (const work of Object.values(raw.works)) {
    delete work.runId
    delete work.origin
  }
  for (const round of raw.rounds) delete round.runId
  if (raw.completion !== null) delete raw.completion.runId
  await writeFile(harness.paths.stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

  const state = await loadState(harness.paths)
  assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION)
  assert.equal(state.status, 'completed')
  assert.equal(state.currentRunId, 'R-0001')
  assert.equal(state.runs.length, 1)
  const run = state.runs[0]!
  assert.equal(run.status, 'completed')
  assert.equal(run.cleanup, 'pending', '迁移只登记待清理，不自动启动')
  assert.equal(run.completion?.roundId, proposal.round.id)
  assert.equal(run.completion?.runId, 'R-0001', '迁移补齐完成记录的 runId')
  assert.equal(state.completion?.roundId, proposal.round.id)
  assert.equal(state.completion?.runId, 'R-0001')
  assert.equal(state.rounds[0]?.runId, 'R-0001')
  for (const work of Object.values(state.works)) {
    assert.equal(work.runId, 'R-0001')
  }
  assert.deepEqual(run.workIds, ['W-0001'])

  const backup = JSON.parse(
    await readFile(join(harness.paths.runtimeDir, 'state.v4.backup.json'), 'utf8'),
  ) as { schemaVersion: number }
  assert.equal(backup.schemaVersion, 4)
})

test('缺少 counters 或 findings 的状态报 STATE_CORRUPT，而不是隐式 TypeError', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  const raw = JSON.parse(await readFile(harness.paths.stateFile, 'utf8')) as Record<string, unknown>
  const isCorrupt = (error: unknown): boolean =>
    error instanceof Error && (error as Error & { code?: string }).code === 'STATE_CORRUPT'

  delete raw.counters
  await writeFile(harness.paths.stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  await assert.rejects(loadState(harness.paths), isCorrupt)

  raw.counters = { run: 1, work: 0, finding: 0, message: 0, round: 0, command: 0 }
  delete raw.findings
  await writeFile(harness.paths.stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  await assert.rejects(loadState(harness.paths), isCorrupt)
})
