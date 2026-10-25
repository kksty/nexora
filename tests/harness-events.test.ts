import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { normalizeSessionEvent, normalizeSessionStatus } from '../src/harness/events.ts'
import { findSessionLog, readSessionActivityFile } from '../src/harness/sdk-driver.ts'

const SESSION = 'liebian-T-test-W-0001'

/**
 * Shapes below mirror real `session.v4.jsonl` records produced by
 * @deepseek-ai/dsh 0.2.1-rc.2; they are trimmed of bulky payloads only.
 */
test('harness 事件：tool/call 与 tool/result 归一化', () => {
  const call = normalizeSessionEvent(
    {
      type: 'tool/call',
      seq: 12,
      time: 1792597448373,
      data: { turn: 1, step: 1, callId: 'call_00_abc', name: 'bash', arguments: '{"command":"id"}' },
    },
    SESSION,
    7,
  )
  assert.ok(call && call.kind === 'tool-call')
  assert.equal(call.callId, 'call_00_abc')
  assert.equal(call.name, 'bash')
  assert.equal(call.arguments, '{"command":"id"}')
  assert.equal(call.generation, 7)
  assert.equal(call.seq, 12)

  const result = normalizeSessionEvent(
    {
      type: 'tool/result',
      seq: 16,
      time: 1792597448380,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'call_00_abc' },
          toolCallId: 'call_00_abc',
          content: [{ type: 'text', text: 'uid=0(root)' }],
        },
      },
    },
    SESSION,
    7,
  )
  assert.ok(result && result.kind === 'tool-result')
  assert.equal(result.callId, 'call_00_abc')
  assert.equal(result.isError, false)
})

test('harness 事件：job/registered 与 job/settled 保留任务身份和创建调用', () => {
  const registered = normalizeSessionEvent(
    {
      type: 'job/registered',
      seq: 22,
      time: 1792597450451,
      data: {
        jobId: 'bash-eeb40be4caa54520',
        owner: SESSION,
        kind: 'bash',
        label: 'pwd; ls -la',
        startedAt: 1792597450451,
        toolCall: { callId: 'call_00_root', rootCallId: 'call_00_root' },
      },
    },
    SESSION,
    3,
  )
  assert.ok(registered && registered.kind === 'job-registered')
  assert.equal(registered.jobId, 'bash-eeb40be4caa54520')
  assert.equal(registered.toolCallId, 'call_00_root')
  assert.equal(registered.ownerSessionId, SESSION)

  const settled = normalizeSessionEvent(
    {
      type: 'job/settled',
      seq: 23,
      time: 1792597450484,
      data: {
        jobId: 'bash-eeb40be4caa54520',
        owner: SESSION,
        kind: 'bash',
        label: 'pwd; ls -la',
        startedAt: 1792597450451,
        toolCall: { callId: 'call_00_root', rootCallId: 'call_00_root' },
        finishedAt: 1792597450483,
        status: 'completed',
        cause: 'producer',
        producerReported: true,
        detail: 'exit code: 0',
      },
    },
    SESSION,
    3,
  )
  assert.ok(settled && settled.kind === 'job-settled')
  assert.equal(settled.status, 'completed')
  assert.equal(settled.cause, 'producer')
  assert.equal(settled.detail, 'exit code: 0')
  assert.equal(settled.finishedAt, new Date(1792597450483).toISOString())
})

test('harness 事件：user/message 保留来源、正文和消息 id', () => {
  const notice = normalizeSessionEvent(
    {
      type: 'user/message',
      seq: 30,
      time: 1792597451000,
      data: {
        role: 'user',
        id: 'notice-message-id',
        source: { kind: 'tool-jobs', form: 'notice', summary: 'bash sleep finished' },
        content: [{ type: 'text', text: 'background job bash-1 finished. Read its output with job_output.' }],
      },
    },
    SESSION,
    4,
  )
  assert.ok(notice && notice.kind === 'user-message')
  assert.equal(notice.messageId, 'notice-message-id')
  assert.equal(notice.sourceKind, 'tool-jobs')
  assert.equal(notice.form, 'notice')
  assert.match(notice.text ?? '', /bash-1/)
})

test('持久会话日志：按游标读取恢复事件并跳过损坏行', async (t) => {
  const scratch = fileURLToPath(new URL('../.scratch', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'liebian-events-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionId = 'liebian-T-test-W-0001'
  const dir = join(root, 'task', 'runtime', 'sessions', '--tmp--', sessionId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl')
  const lines = [
    { type: 'session', version: 4, id: sessionId },
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
    { type: 'tool/result', seq: 2, time: 2, data: { turn: 1, step: 1, message: { toolCallId: 'c1' } } },
    '{not json}',
    {
      type: 'job/registered',
      seq: 3,
      time: 3,
      data: { jobId: 'bash-1', owner: sessionId, kind: 'bash', label: 'id', startedAt: 3 },
    },
    {
      type: 'job/settled',
      seq: 4,
      time: 4,
      data: {
        jobId: 'bash-1',
        owner: sessionId,
        kind: 'bash',
        label: 'id',
        startedAt: 3,
        finishedAt: 4,
        status: 'completed',
        cause: 'producer',
        producerReported: true,
      },
    },
  ]
  await writeFile(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`)
  assert.equal(await findSessionLog(join(root, 'task'), sessionId), file)
  const replay = await readSessionActivityFile(file, sessionId, 9, 1)
  assert.deepEqual(
    replay.map((event) => (event.kind === 'status' ? event.kind : `${event.kind}:${event.seq}`)),
    ['tool-result:2', 'job-registered:3', 'job-settled:4'],
  )
  assert.ok(replay.every((event) => event.generation === 9))
})

test('harness 事件：turn/end、session.status 与无关事件', () => {
  const end = normalizeSessionEvent(
    {
      type: 'turn/end',
      seq: 135,
      time: 1792599000000,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
    SESSION,
    1,
  )
  assert.ok(end && end.kind === 'turn-end')
  assert.equal(end.turn, 1)
  assert.equal(end.detail, 'completed')

  const status = normalizeSessionStatus(SESSION, 9, 'running', 1792599000000)
  assert.ok(status && status.kind === 'status')
  assert.equal(status.status, 'running')
  assert.equal(normalizeSessionStatus(SESSION, 9, 'unknown'), null)

  assert.equal(normalizeSessionEvent({ type: 'assistant/message', seq: 5, time: 1, data: {} }, SESSION, 1), null)
  assert.equal(normalizeSessionEvent({ type: 'tool/call', seq: 5, time: 1, data: {} }, SESSION, 1), null)
})
