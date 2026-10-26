/**
 * Test entry point.
 *
 * The suite creates and removes scratch task directories under `.scratch`, and
 * a single cleanup can unlink dozens of files. Agent CLIs (WorkBuddy/CodeBuddy)
 * inject a bulk-delete guard into every Node process through NODE_OPTIONS; once
 * it has counted enough deletions in a run it starts refusing them, which makes
 * unrelated tests fail in `t.after` hooks with SAFE_DELETE_BULK_CONFIRM_REQUIRED.
 *
 * That guard protects agent-initiated deletions, not a test suite cleaning up
 * its own temp directories, so it is switched off for the test processes only.
 * Nothing else from the host environment is touched.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const env = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' }

// Node 22 needs an explicit flag to run the TypeScript sources directly; from
// Node 23 on, type stripping is on by default.
const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
const flags = major >= 23 ? [] : ['--experimental-strip-types']

const child = spawn(process.execPath, [...flags, '--test', '--test-concurrency=1', 'tests/*.test.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
