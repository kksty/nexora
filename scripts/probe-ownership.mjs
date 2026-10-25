import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { makeTaskPaths } from '../src/core/paths.ts'
import { acquireTaskOwnership, releaseTaskOwnership } from '../src/core/ownership.ts'

const [mode, root] = process.argv.slice(2)
if (!['hold', 'try'].includes(mode) || !root) throw new Error('usage: probe-ownership.mjs hold|try <scratch root>')
const paths = makeTaskPaths(resolve(root), 'T-lock-probe')
await mkdir(paths.runtimeDir, { recursive: true })
await writeFile(paths.stateFile, '{}', { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error })
try {
  const lease = await acquireTaskOwnership(paths, 'cli')
  console.log('ACQUIRED')
  if (mode === 'try') await releaseTaskOwnership(paths, lease)
  else setInterval(() => {}, 1000) // intentionally no heartbeat: kernel lock must stay held
} catch (error) {
  if (!['TASK_BUSY', 'LOCK_DOMAIN_MISMATCH'].includes(error.code)) throw error
  console.log(error.code)
}
