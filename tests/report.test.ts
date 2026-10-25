import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Engine } from '../src/core/engine.ts'
import { loadState } from '../src/core/state.ts'
import type { HarnessDriver } from '../src/harness/driver.ts'
import type { AppError } from '../src/util/errors.ts'
import { nullLogger } from '../src/util/log.ts'
import { createHarness } from './support/harness.ts'

function offlineDriver(): HarnessDriver {
  const fail = async (): Promise<never> => {
    throw new Error('offline test driver')
  }
  return {
    ensure: fail,
    prompt: fail,
    waitForIdle: fail,
    quiesce: async () => undefined,
    stop: async () => undefined,
    stopAll: async () => undefined,
  }
}

function isCode(code: string) {
  return (error: unknown): boolean => (error as AppError).code === code
}

test('报告首次发布、读取、旧版本冲突与幂等', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  await writeFile(join(harness.paths.taskDir, 'draft.md'), '# 报告 v1\n\n第一版内容。\n', 'utf8')
  const before = harness.engine.state.sharedStateVersion
  const v1 = await harness.engine.publishReport('W-0001', {
    draft_path: 'draft.md',
    path: 'report.md',
    base_revision: 0,
    request_id: 'report-1',
  })
  assert.equal(v1.revision, 1)
  assert.equal(v1.entryState, 'synced')
  assert.equal(v1.idempotent, false)
  assert.ok(harness.engine.state.sharedStateVersion > before, '发布递增共享状态版本')
  assert.equal(await readFile(join(harness.paths.taskDir, 'report.md'), 'utf8'), '# 报告 v1\n\n第一版内容。\n')
  assert.equal(harness.engine.state.reports['report']?.contentHash, v1.contentHash)

  const read = await harness.engine.readReport('W-0001', {})
  assert.equal(read.found, true)
  assert.equal(read.report?.revision, 1)
  assert.match(read.content ?? '', /第一版内容/)

  await writeFile(join(harness.paths.taskDir, 'draft2.md'), '# 报告 v2\n\n第二版内容。\n', 'utf8')
  await assert.rejects(
    harness.engine.publishReport('W-0001', {
      draft_path: 'draft2.md',
      base_revision: 0,
      request_id: 'report-stale',
    }),
    isCode('REPORT_CONFLICT'),
  )
  const v2 = await harness.engine.publishReport('W-0001', {
    draft_path: 'draft2.md',
    base_revision: 1,
    request_id: 'report-2',
  })
  assert.equal(v2.revision, 2)
  assert.equal(await readFile(join(harness.paths.taskDir, 'report.md'), 'utf8'), '# 报告 v2\n\n第二版内容。\n')

  const versionAfterPublish = harness.engine.state.sharedStateVersion
  const replay = await harness.engine.publishReport('W-0001', {
    draft_path: 'draft2.md',
    base_revision: 1,
    request_id: 'report-2',
  })
  assert.equal(replay.idempotent, true)
  assert.equal(replay.revision, 2)
  assert.equal(harness.engine.state.sharedStateVersion, versionAfterPublish, '幂等重试不再次递增版本')

  // A replay of the older r1 request returns the original result, not the
  // newer current revision, and does not touch the current entry.
  const oldReplay = await harness.engine.publishReport('W-0001', {
    draft_path: 'draft.md',
    path: 'report.md',
    base_revision: 0,
    request_id: 'report-1',
  })
  assert.equal(oldReplay.idempotent, true)
  assert.equal(oldReplay.revision, 1)
  assert.equal(oldReplay.contentHash, v1.contentHash)
  assert.equal(harness.engine.state.reports['report']?.revision, 2)
  assert.equal(await readFile(join(harness.paths.taskDir, 'report.md'), 'utf8'), '# 报告 v2\n\n第二版内容。\n')

  await assert.rejects(
    harness.engine.publishReport('W-0001', {
      draft_path: 'draft.md',
      base_revision: 1,
      request_id: 'report-2',
    }),
    isCode('REQUEST_CONFLICT'),
  )
})

test('报告并发冲突、直接修改后的漂移与恢复', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  await writeFile(join(harness.paths.taskDir, 'draft.md'), '# r1\n', 'utf8')
  await harness.engine.publishReport('W-0001', {
    draft_path: 'draft.md',
    path: 'report.md',
    base_revision: 0,
    request_id: 'drift-1',
  })

  // Two works reading the same revision: the first publish wins, the second
  // gets a conflict instead of silently overwriting.
  await writeFile(join(harness.paths.taskDir, 'other.md'), '# other\n', 'utf8')
  const second = await harness.engine.publishReport('W-0001', {
    draft_path: 'other.md',
    base_revision: 1,
    request_id: 'drift-2',
  })
  assert.equal(second.revision, 2)
  await assert.rejects(
    harness.engine.publishReport('W-0001', {
      draft_path: 'draft.md',
      base_revision: 1,
      request_id: 'drift-3',
    }),
    isCode('REPORT_CONFLICT'),
  )

  await writeFile(join(harness.paths.taskDir, 'report.md'), '# 直接修改\n', 'utf8')
  const versionBeforeDrift = harness.engine.state.sharedStateVersion
  const drifted = await harness.engine.completionStatus('W-0001')
  assert.equal(harness.engine.state.reports['report']?.entryState, 'drift')
  assert.ok(
    harness.engine.state.sharedStateVersion > versionBeforeDrift,
    '漂移登记使共享状态版本递增，旧完成票失效',
  )
  assert.ok(drifted.blockers.some((blocker) => blocker.includes('报告')), drifted.blockers.join('\n'))

  const accepted = await harness.engine.publishReport('W-0001', {
    draft_path: 'report.md',
    base_revision: 2,
    request_id: 'drift-4',
  })
  assert.equal(accepted.revision, 3)
  assert.equal(harness.engine.state.reports['report']?.entryState, 'synced')
  const afterAccept = await harness.engine.completionStatus('W-0001')
  assert.ok(!afterAccept.blockers.some((blocker) => blocker.includes('报告')), afterAccept.blockers.join('\n'))

  await writeFile(join(harness.paths.taskDir, 'report.md'), '# 再改一次\n', 'utf8')
  await harness.engine.completionStatus('W-0001')
  assert.equal(harness.engine.state.reports['report']?.entryState, 'drift')
  const restored = await harness.engine.publishReport('W-0001', {
    restore: true,
    key: 'report',
    request_id: 'drift-5',
  })
  assert.equal(restored.restored, true)
  assert.equal(restored.revision, 3, '恢复登记版本不创建新版本')
  assert.equal(harness.engine.state.reports['report']?.entryState, 'synced')
  assert.equal(
    await readFile(join(harness.paths.taskDir, 'report.md'), 'utf8'),
    '# 直接修改\n',
    '恢复的是最后一次已登记发布内容',
  )
})

test('发布已提交但入口未写出时，同一 request ID 重试先补齐再返回成功', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  await writeFile(join(harness.paths.taskDir, 'draft.md'), '# 待补齐报告\n', 'utf8')
  const first = await harness.engine.publishReport('W-0001', {
    draft_path: 'draft.md',
    path: 'report.md',
    base_revision: 0,
    request_id: 'retry-pending',
  })
  assert.equal(first.revision, 1)

  // Simulate a crash after the logical commit: the committed pointer still
  // says pending and the fixed entry is gone.
  harness.engine.state.reports['report']!.entryState = 'pending'
  await rm(join(harness.paths.taskDir, 'report.md'))

  const retried = await harness.engine.publishReport('W-0001', {
    draft_path: 'draft.md',
    path: 'report.md',
    base_revision: 0,
    request_id: 'retry-pending',
  })
  assert.equal(retried.idempotent, true)
  assert.equal(retried.revision, 1)
  assert.equal(retried.entryState, 'synced')
  assert.equal(await readFile(join(harness.paths.taskDir, 'report.md'), 'utf8'), '# 待补齐报告\n')
})

test('报告发布在提交后崩溃时，下次启动补齐固定入口', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  await writeFile(join(harness.paths.taskDir, 'draft.md'), '# 崩溃前发布\n', 'utf8')
  const published = await harness.engine.publishReport('W-0001', {
    draft_path: 'draft.md',
    path: 'report.md',
    base_revision: 0,
    request_id: 'crash-1',
  })
  await harness.engine.close('simulate-crash')

  // Simulate the crash window: authoritative pointer committed, entry gone.
  await rm(join(harness.paths.taskDir, 'report.md'))
  const state = await loadState(harness.paths)
  state.reports['report']!.entryState = 'pending'
  await writeFile(harness.paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  const reopened = await Engine.open({
    paths: harness.paths,
    driver: offlineDriver(),
    logger: nullLogger,
    dispatch: false,
  })
  t.after(() => reopened.close('test-cleanup'))
  await reopened.start()
  await reopened.whenQuiet()
  assert.equal(
    await readFile(join(harness.paths.taskDir, 'report.md'), 'utf8'),
    '# 崩溃前发布\n',
  )
  const repaired = await loadState(harness.paths)
  assert.equal(repaired.reports['report']?.entryState, 'synced')
  assert.equal(repaired.reports['report']?.contentHash, published.contentHash)
})

test('没有报告的活跃任务不因报告被阻塞；非法草稿路径被拒绝', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()

  const status = await harness.engine.completionStatus('W-0001')
  assert.ok(!status.blockers.some((blocker) => blocker.includes('报告')), status.blockers.join('\n'))

  await assert.rejects(
    harness.engine.publishReport('W-0001', {
      draft_path: '../escape.md',
      path: 'report.md',
      base_revision: 0,
      request_id: 'bad-1',
    }),
    isCode('INVALID_ARGUMENT'),
  )
  await assert.rejects(
    harness.engine.publishReport('W-0001', {
      draft_path: 'missing.md',
      path: 'report.md',
      base_revision: 0,
      request_id: 'bad-2',
    }),
    isCode('INVALID_ARGUMENT'),
  )
  await assert.rejects(
    harness.engine.publishReport('W-0001', {
      draft_path: 'missing.md',
      base_revision: 0,
      request_id: 'bad-3',
    }),
    isCode('INVALID_ARGUMENT'),
    '首次发布必须给出固定入口 path',
  )
  await assert.rejects(
    harness.engine.publishReport('W-0001', {
      draft_path: 'missing.md',
      path: 'task.md',
      base_revision: 0,
      request_id: 'bad-4',
    }),
    isCode('INVALID_ARGUMENT'),
    '不能覆盖共享文档',
  )
  // Windows treats `TASK.md` and `task.md` as the same file; the reserved-name
  // check must not depend on the client's casing.
  await assert.rejects(
    harness.engine.publishReport('W-0001', {
      draft_path: 'missing.md',
      path: 'TASK.MD',
      base_revision: 0,
      request_id: 'bad-5',
    }),
    isCode('INVALID_ARGUMENT'),
    '大小写不同的共享文档名也不能作为报告入口',
  )
  await assert.rejects(
    harness.engine.publishReport('W-0001', {
      draft_path: 'missing.md',
      path: 'Runtime/notes.md',
      base_revision: 0,
      request_id: 'bad-6',
    }),
    isCode('INVALID_ARGUMENT'),
    '大小写不同的 runtime/ 前缀同样拒绝',
  )
})
