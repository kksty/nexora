/** Kernel-backed lock. Never remove this database file while the task exists. */
import { DatabaseSync } from 'node:sqlite'
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { AppError } from './errors.ts'

function assertLockDomain(file: string): void {
  const domain = file + '.domain'
  const expected = `liebian-lock-v1:${process.platform}\n`
  try {
    const actual = readFileSync(domain, 'utf8')
    if (actual !== expected) throw new AppError('LOCK_DOMAIN_MISMATCH',
      '任务锁属于另一个操作系统锁域；Docker Desktop 任务请通过 Web 或 docker exec 中的 CLI 修改，不能由 Windows 宿主直接离线写入。')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = domain + '.' + randomUUID()
  try {
    writeFileSync(temporary, expected, { flag: 'wx' })
    try { linkSync(temporary, domain) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally { rmSync(temporary, { force: true }) }
  assertLockDomain(file)
}

export function tryFileLock(file: string): (() => void) | null {
  assertLockDomain(file)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(file)
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    const held = db
    let closed = false
    return () => {
      if (closed) return
      closed = true
      held.close()
    }
  } catch (error) {
    db?.close()
    const code = (error as { errcode?: number }).errcode
    if (code !== undefined && ((code & 255) === 5 || (code & 255) === 6)) return null
    throw error
  }
}
