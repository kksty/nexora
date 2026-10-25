import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSessionEvent } from '../src/harness/events.ts'
import { applyActivityEvent, emptyActivity, markActivityUnknown, reconcileActivity } from '../src/core/activity.ts'

function snapshot(seq: number, ids: string[], generation = 1) {
  return normalizeSessionEvent({ type: 'liebian/terminals', seq, time: Date.now(),
    data: { terminals: ids.map((id) => ({ id, label: id })) } }, 'session-1', generation)!
}

test('PTY 生命周期：发送返回后仍阻塞，关闭后结算，不需要伪造 job 通知', () => {
  const activity = emptyActivity(1)
  applyActivityEvent(activity, snapshot(1, ['pty-1', 'pty-2']))
  assert.equal(activity.jobs['terminal:1:pty-1']?.status, 'running')
  applyActivityEvent(activity, snapshot(2, ['pty-1', 'pty-2']))
  assert.equal(Object.keys(activity.jobs).length, 2)
  applyActivityEvent(activity, snapshot(3, ['pty-2']))
  assert.equal(activity.jobs['terminal:1:pty-1']?.status, 'completed')
  assert.equal(activity.jobs['terminal:1:pty-1']?.notice, 'none')
  assert.equal(activity.jobs['terminal:1:pty-2']?.status, 'running')
  applyActivityEvent(activity, snapshot(4, []))
  assert.ok(Object.values(activity.jobs).every((job) => job.status === 'completed'))
})

test('PTY 进程丢失：旧终端待核对，新代次快照不能误清除，旧代次不能污染', () => {
  const activity = emptyActivity(1)
  applyActivityEvent(activity, snapshot(1, ['pty-1']))
  markActivityUnknown(activity)
  activity.generation = 2
  applyActivityEvent(activity, snapshot(2, [], 2))
  assert.equal(activity.jobs['terminal:1:pty-1']?.status, 'unknown')
  assert.equal(applyActivityEvent(activity, snapshot(3, [], 1)).changed, false)
  assert.deepEqual(reconcileActivity(activity, ['terminal:1:pty-1'], '已确认旧进程结束').resolved, ['terminal:1:pty-1'])
})

test('PTY 恢复重放：已落盘的关闭快照结算原代次，不伪造未知活动', () => {
  const activity = emptyActivity(1)
  applyActivityEvent(activity, snapshot(1, ['pty-1']))
  markActivityUnknown(activity)
  activity.generation = 2
  const replay = normalizeSessionEvent({ type: 'liebian/terminals', seq: 2, time: Date.now(),
    data: { generation: 1, terminals: [] } }, 'session-1', 2)!
  applyActivityEvent(activity, replay)
  markActivityUnknown(activity)
  assert.equal(activity.jobs['terminal:1:pty-1']?.status, 'completed')
})
