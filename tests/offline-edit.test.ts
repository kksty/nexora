import assert from 'node:assert/strict'
import test from 'node:test'
import { Engine } from '../src/core/engine.ts'
import { nullLogger } from '../src/util/log.ts'
import { createHarness } from './support/harness.ts'
import { FakeDriver } from './support/fake-driver.ts'

test('守护进程未运行时修改终点只落盘，不尝试投递或改运行状态', async (t) => {
  const harness = await createHarness()
  t.after(() => harness.cleanup())
  await harness.engine.start()
  await harness.engine.whenQuiet()
  const proposal = await harness.engine.proposeCompletion('W-0001', { reason: '准备结束' })
  await harness.engine.whenQuiet()
  await harness.engine.close('daemon-down')
  assert.equal(harness.engine.state.currentRoundId, proposal.round.id)

  const driver = new FakeDriver()
  const offline = await Engine.open({
    paths: harness.paths,
    driver,
    logger: nullLogger,
    dispatch: false,
  })
  const changed = await offline.setEndInformation('离线更新的终点信息')
  assert.equal(changed.targetVersion, 2)
  assert.equal(offline.state.targetVersion, 2)
  assert.equal(offline.state.works['W-0001']?.runtimeStatus, 'idle')
  assert.equal(offline.state.works['W-0001']?.lastError, undefined)
  assert.equal(driver.prompts.length, 0)
  assert.equal(driver.ensures.length, 0)

  const oldRound = offline.state.rounds.find((round) => round.id === proposal.round.id)
  assert.equal(oldRound?.status, 'invalidated')
  const reopened = offline.state.rounds.find((round) => round.id === offline.state.currentRoundId)
  assert.ok(reopened)
  assert.equal(reopened.targetVersion, 2)
  assert.deepEqual(reopened.opinions, {})
  // The notification is queued for delivery on the next run.
  assert.ok(offline.state.messages.some((message) => message.system && message.status === 'pending'))
})
