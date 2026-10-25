import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { replaceFileWithRetry, writeFileAtomic } from '../src/util/atomic.ts'

test('原子替换：Windows 暂时拒绝时旧文件始终存在，重试成功', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'liebian-atomic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'state.json'), next = join(root, 'next.json')
  await writeFile(file, 'old'); await writeFile(next, 'new')
  let attempts = 0
  await replaceFileWithRetry(next, file, async (from, to) => {
    assert.equal(await readFile(file, 'utf8'), 'old')
    if (++attempts < 3) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
    await rename(from, to)
  })
  assert.equal(attempts, 3)
  assert.equal(await readFile(file, 'utf8'), 'new')
})

test('原子替换：持续失败保留旧状态，不制造缺失窗口', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'liebian-atomic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'state.json'), next = join(root, 'next.json')
  await writeFile(file, 'committed'); await writeFile(next, 'pending')
  await assert.rejects(replaceFileWithRetry(next, file, async () => {
    assert.equal(await readFile(file, 'utf8'), 'committed')
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  }))
  assert.equal(await readFile(file, 'utf8'), 'committed')
})

test('原子写入：失败清理临时文件，成功留下完整 JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'liebian-atomic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFileAtomic(join(root, 'state.json'), '{"ok":true}')
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')), { ok: true })
  // A directory cannot be replaced by a regular file on either supported OS.
  await assert.rejects(writeFileAtomic(root, 'no'))
  assert.deepEqual(await readdir(root), ['state.json'])
})

