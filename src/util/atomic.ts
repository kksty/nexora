/**
 * File primitives used by the runtime's serialized write path.
 *
 * All runtime state is committed with write-to-temp + rename so a crash never
 * leaves a half-written JSON document. Shared Markdown append logs use
 * `appendFileDurable`, which fsyncs before returning: an agent that received a
 * finding ID can rely on the record surviving a process crash.
 */

import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Create a directory tree if it does not exist yet. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** Atomically replace a UTF-8 text file. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await ensureDir(dirname(file))
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await replaceFileWithRetry(temporary, file)
    // Persist the directory entry on platforms that support directory fsync.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Never unlink the committed destination, even when Windows refuses rename. */
export async function replaceFileWithRetry(
  temporary: string,
  file: string,
  replace: typeof rename = rename,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await replace(temporary, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EPERM', 'EEXIST', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 6) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt))
    }
  }
}

/** Append text to a file and fsync the result before resolving. */
export async function appendFileDurable(file: string, data: string): Promise<void> {
  await ensureDir(dirname(file))
  const handle = await open(file, 'a')
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Read a UTF-8 file, returning null when it does not exist. */
export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r')
    try {
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
