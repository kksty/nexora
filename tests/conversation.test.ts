import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeTaskPaths } from '../src/core/paths.ts'
import { readWorkConversation } from '../src/web/conversation.ts'

async function scaffold(t: test.TestContext): Promise<ReturnType<typeof makeTaskPaths>> {
  const base = fileURLToPath(new URL('../.scratch', import.meta.url))
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'liebian-conv-'))
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined))
  const paths = makeTaskPaths(root, 'T-20261026-120000-abcd')
  await mkdir(paths.runtimeDir, { recursive: true })
  await writeFile(
    paths.stateFile,
    JSON.stringify({ schemaVersion: 5, works: { 'W-0001': { id: 'W-0001', sessionId: 'sess-1' } } }),
    'utf8',
  )
  return paths
}

async function writeSession(paths: ReturnType<typeof makeTaskPaths>, events: unknown[]): Promise<void> {
  const dir = join(paths.sessionsDir, '--tasks-T-20261026-120000-abcd--', 'sess-1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
}

const t0 = 1_790_000_000_000

test('会话读取：把协议事件整理成聊天条目', async (t) => {
  const paths = await scaffold(t)
  await writeSession(paths, [
    { type: 'session', version: 4, id: 'sess-1' },
    { type: 'user/message', seq: 1, time: t0, data: { content: [{ type: 'text', text: '先读共享状态' }] } },
    {
      type: 'assistant/message',
      seq: 2,
      time: t0 + 1000,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先看看任务定义。' },
            { type: 'text', text: '我准备读取任务定义。' },
            { type: 'tool-call', id: 'call-1', name: 'mcp__liebian__shared_read', arguments: '{}' },
          ],
        },
        usage: { inputTokens: 120, outputTokens: 30 },
      },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: t0 + 1500,
      data: {
        toolCallId: 'call-1',
        message: { role: 'tool', content: [{ type: 'text', text: '# 任务定义\n\n- 状态：active' }] },
      },
    },
    { type: 'llm/retry', seq: 4, time: t0 + 2000, data: { retry: 2, failure: { code: 'EMPTY_RESPONSE' } } },
    { type: 'turn/end', seq: 5, time: t0 + 3000, data: { turn: 1, reason: { kind: 'error', error: { code: 'MALFORMED_RESPONSE', message: '流中断' } } } },
    // Raw provider streams must not duplicate the settled message.
    { type: 'assistant/attempt', seq: 6, time: t0 + 3500, data: { stream: [{ chunk: { type: 'finish' } }] } },
  ])

  const result = await readWorkConversation(paths, 'W-0001')
  assert.equal(result.sessionId, 'sess-1')
  assert.equal(result.entries.length, 6)
  assert.deepEqual(
    result.entries.map((entry) => entry.role),
    ['user', 'assistant', 'tool', 'tool', 'status', 'status'],
  )

  const [user, assistant, call, toolResult, retry, end] = result.entries
  assert.equal(user?.text, '先读共享状态')
  assert.equal(assistant?.text, '我准备读取任务定义。')
  assert.equal(assistant?.thinking, '先看看任务定义。')
  assert.equal(assistant?.usage?.outputTokens, 30)
  assert.equal(call?.tool?.kind, 'call')
  assert.equal(call?.tool?.name, 'mcp__liebian__shared_read')
  assert.match(toolResult?.text ?? '', /任务定义/)
  assert.equal(retry?.status?.code, 'EMPTY_RESPONSE')
  assert.equal(end?.status?.kind, 'error')
  assert.equal(end?.status?.code, 'MALFORMED_RESPONSE')
})

test('会话读取：未知执行者报 WORK_NOT_FOUND，超长内容被截断', async (t) => {
  const paths = await scaffold(t)
  await writeSession(paths, [
    { type: 'user/message', seq: 1, time: t0, data: { content: [{ type: 'text', text: 'x'.repeat(30_000) }] } },
  ])

  const result = await readWorkConversation(paths, 'W-0001')
  assert.equal(result.truncated, true)
  assert.equal((result.entries[0]?.text.length ?? 0) <= 20_000, true)

  await assert.rejects(() => readWorkConversation(paths, 'W-9999'), /找不到执行者/)
})

test('会话读取：会话文件缺失时返回空列表而不是报错', async (t) => {
  const paths = await scaffold(t)
  const result = await readWorkConversation(paths, 'W-0001')
  assert.deepEqual(result.entries, [])
  assert.equal(result.truncated, false)
})

test('会话读取：截断原因、尾部分页和损坏日志都可见', async (t) => {
  const paths = await scaffold(t)
  await writeSession(paths, [
    { type: 'user/message', seq: 1, time: t0, data: { content: [{ type: 'text', text: '最早一条' }] } },
  ])
  const file = join(paths.sessionsDir, '--tasks-T-20261026-120000-abcd--', 'sess-1', 'session.v4.jsonl')
  await writeFile(
    file,
    `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(9 * 1024 * 1024) }] } })}\n` +
      `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '最后一条' }] } })}\n`,
    'utf8',
  )

  const result = await readWorkConversation(paths, 'W-0001')
  assert.equal(result.entries.at(-1)?.text, '最后一条')
  assert.equal(result.truncated, true)
  assert.ok(result.truncationReasons?.includes('size'))
  assert.equal(result.pagination.mode, 'tail')
  assert.ok(result.pagination.omittedBytes > 0)
  assert.ok(result.pagination.readBytes <= 8 * 1024 * 1024)

  await writeFile(
    file,
    `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '保留' }] } })}\n{bad json}\n` +
      `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } })}\n`,
    'utf8',
  )
  const corrupt = await readWorkConversation(paths, 'W-0001')
  assert.equal(corrupt.entries.length, 2)
  assert.ok(corrupt.truncationReasons?.includes('corrupt'))

  await writeFile(
    file,
    `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '已完整' }] } })}\n` +
      JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '写入中' }] } }).slice(0, -3),
    'utf8',
  )
  const partial = await readWorkConversation(paths, 'W-0001')
  assert.deepEqual(partial.entries.map((entry) => entry.text), ['已完整'])
  assert.ok(partial.truncationReasons?.includes('partial'))
  assert.equal(partial.truncationReasons?.includes('corrupt'), false)
})

test('会话读取：task 目录之外不能借会话 ID 读取文件', async (t) => {
  const paths = await scaffold(t)
  await writeFile(
    paths.stateFile,
    JSON.stringify({ works: { 'W-0001': { id: 'W-0001', sessionId: '../../outside' } } }),
    'utf8',
  )
  await assert.rejects(
    () => readWorkConversation(paths, 'W-0001'),
    (error: unknown) => (error as { code?: string }).code === 'STATE_CORRUPT',
  )
})

test('会话读取：同名会话出现在多个任务目录时拒绝猜测', async (t) => {
  const paths = await scaffold(t)
  await writeSession(paths, [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '第一份' }] } },
  ])
  const other = join(paths.sessionsDir, '--other-task--', 'sess-1')
  await mkdir(other, { recursive: true })
  await writeFile(
    join(other, 'session.v4.jsonl'),
    `${JSON.stringify({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '另一份' }] } })}\n`,
    'utf8',
  )
  await assert.rejects(
    () => readWorkConversation(paths, 'W-0001'),
    (error: unknown) => (error as { code?: string }).code === 'STATE_CORRUPT',
  )
})
