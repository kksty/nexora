import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeTaskPaths } from '../src/core/paths.ts'
import { renderHarnessPatch } from '../src/harness/patch.ts'
import { OPENAI_COMPATIBLE_ROUTE, type ModelPolicy } from '../src/util/model-limits.ts'

const DSH_BIN = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const OPENAI_POLICY: ModelPolicy & { provider?: string; modelId?: string; baseUrl?: string } = {
  modelApiProtocol: 'openai-compatible',
  modelContextWindow: 32_768,
  modelAutoCompactRatio: 0.75,
  modelSafetyMarginTokens: 2048,
  modelThinkingAdapter: 'vllm',
  modelMaxTokens: 4096,
  modelThinking: 'high',
  provider: OPENAI_COMPATIBLE_ROUTE,
  modelId: 'qwen3-32b',
  baseUrl: 'http://127.0.0.1:8000/v1',
}

/**
 * Ask the real loader to compose the profile with this patch.
 *
 * A generated patch can be syntactically valid YAML and still be dropped: a
 * top-level entry only overrides a plugin the profile already mounted, so
 * `- id: <new plugin>` is reported as "entry not found" and the capability
 * silently never loads. Asserting on the rendered text cannot catch that, so
 * this runs `dsh --dump-config`, which is the loader itself.
 */
async function dumpConfig(patchFile: string, homeDir: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [DSH_BIN, '--profile', 'sdk', '--patch', patchFile, '--dump-config'],
      { cwd: REPO_ROOT, env: { ...process.env, DSH_HOME: homeDir }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`dsh --dump-config timed out\n${stderr}`))
    }, 120_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`dsh --dump-config exited ${String(code)}\n${stderr}`))
      else resolve({ stdout, stderr })
    })
  })
}

test('harness patch 固定使用 bash 并精简模型工具面', () => {
  const paths = makeTaskPaths(fileURLToPath(new URL('../.scratch', import.meta.url)), 'T-20261021-120000-abcd')
  const yaml = renderHarnessPatch({
    paths,
    mcpEntry: '/app/src/mcp/main.ts',
    nodeExecutable: '/usr/local/bin/node',
  })

  // Bash is forced on. The patch does not mention PowerShell at all: the
  // Linux executors never mount it, and the image has no pwsh binary.
  assert.match(yaml, /- id: bash-sandbox\n  disabled: false/)
  assert.match(yaml, /- id: tool-bash\n  disabled: false/)
  assert.doesNotMatch(yaml, /pwsh|PowerShell/i)

  // The generic tool surface stays small and CLI-first.
  assert.match(yaml, /- id: tool-fs\n  config:\n    read: true\n    write: true\n    edit: true\n    readImage: false/)
  for (const id of ['tool-web', 'tool-todo', 'tool-working-directory']) {
    assert.match(yaml, new RegExp(`- id: ${id}\\n  disabled: true`))
  }
  assert.doesNotMatch(yaml, /tool-present/)

  // Runtime-owned capabilities remain available, and no hidden delegation path
  // can create an executor outside the shared work table.
  assert.match(yaml, /- id: mcp-liebian/)
  // Every model stream is gated by the task-wide semaphore plugin.
  assert.match(yaml, /- id: llm-concurrency/)
  assert.match(yaml, /llm-concurrency\.ts"/)
  // Human commands are handed to the live agent through the harness steering
  // boundary by a thin plugin, not by a second admission path.
  assert.match(yaml, /- id: command-steer/)
  assert.match(yaml, /command-steer\.ts"/)
  for (const name of ['dsh-terminal', 'dsh-terminal-bash', 'dsh-tool-terminal']) {
    assert.ok(yaml.includes(`@deepseek-ai/${name}`))
  }
  assert.match(yaml, /terminal-activity\.ts"/)
  for (const id of ['tool-skill', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-goal']) {
    assert.match(yaml, new RegExp(`- id: ${id}\\n  disabled: true`))
  }

  assert.match(yaml, /mode: danger-full-access/)
  assert.match(yaml, /LIEBIAN_DAEMON_URL/)
  assert.match(yaml, /LIEBIAN_DAEMON_TOKEN/)
})

test('harness patch 限制单次响应输出上限，避免网关静默返回空回复', () => {
  const paths = makeTaskPaths(fileURLToPath(new URL('../.scratch', import.meta.url)), 'T-20261021-120000-abcd')
  const render = (): string =>
    renderHarnessPatch({ paths, mcpEntry: '/app/src/mcp/main.ts', nodeExecutable: '/usr/local/bin/node' })

  const previous = process.env.LIEBIAN_MODEL_MAX_TOKENS
  try {
    delete process.env.LIEBIAN_MODEL_MAX_TOKENS
    assert.match(render(), /- id: llm-deepseek\n  config:\n    maxTokens: 6144\n/)

    process.env.LIEBIAN_MODEL_MAX_TOKENS = '4096'
    assert.match(render(), /- id: llm-deepseek\n  config:\n    maxTokens: 4096\n/)

    // A malformed value must not leak into the patch.
    process.env.LIEBIAN_MODEL_MAX_TOKENS = 'abc'
    assert.match(render(), /- id: llm-deepseek\n  config:\n    maxTokens: 6144\n/)
  } finally {
    if (previous === undefined) delete process.env.LIEBIAN_MODEL_MAX_TOKENS
    else process.env.LIEBIAN_MODEL_MAX_TOKENS = previous
  }
})

test('harness patch 把思考强度映射为 thinking 与 reasoningEffort', () => {
  const paths = makeTaskPaths(fileURLToPath(new URL('../.scratch', import.meta.url)), 'T-20261021-120000-abcd')
  const render = (): string =>
    renderHarnessPatch({ paths, mcpEntry: '/app/src/mcp/main.ts', nodeExecutable: '/usr/local/bin/node' })

  const previous = process.env.LIEBIAN_MODEL_THINKING
  try {
    delete process.env.LIEBIAN_MODEL_THINKING
    assert.match(render(), /thinking: enabled\n    reasoningEffort: high/)

    process.env.LIEBIAN_MODEL_THINKING = 'off'
    assert.match(render(), /thinking: disabled\n    reasoningEffort: off/)

    process.env.LIEBIAN_MODEL_THINKING = 'low'
    assert.match(render(), /thinking: enabled\n    reasoningEffort: low/)

    process.env.LIEBIAN_MODEL_THINKING = 'max'
    assert.match(render(), /thinking: enabled\n    reasoningEffort: max/)

    // Unsupported values fall back to the default instead of breaking the patch.
    process.env.LIEBIAN_MODEL_THINKING = 'turbo'
    assert.match(render(), /thinking: enabled\n    reasoningEffort: high/)
  } finally {
    if (previous === undefined) delete process.env.LIEBIAN_MODEL_THINKING
    else process.env.LIEBIAN_MODEL_THINKING = previous
  }
})

test('兼容模式：真实 loader 会加载自建适配器，而不是静默丢弃', async (t) => {
  const paths = makeTaskPaths(fileURLToPath(new URL('../.scratch', import.meta.url)), 'T-20261026-120000-abcd')
  const dir = await mkdtemp(join(REPO_ROOT, '.scratch', 'patch-loader-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const patchFile = join(dir, 'harness.patch.yml')
  await writeFile(patchFile, renderHarnessPatch({
    paths,
    mcpEntry: join(dir, 'mcp.ts'),
    nodeExecutable: process.execPath,
    model: OPENAI_POLICY,
  }))

  const { stdout, stderr } = await dumpConfig(patchFile, join(dir, 'dsh-home'))

  // The loader reports an override targeting a non-existent entry on stderr and
  // then drops it. This is exactly the failure the insert: placement avoids.
  assert.equal(stderr.includes('not found'), false, `loader 丢弃了条目：${stderr}`)

  // The adapter must be present as a mounted plugin, not merely as text.
  assert.match(stdout, new RegExp(`- id: ${OPENAI_COMPATIBLE_ROUTE}\\n  name: file://.*openai-compatible\\.ts`))
  // And the native Messages adapter must be disabled so only one route is left.
  assert.match(stdout, /- id: llm-deepseek\n  name: [^\n]+\n  disabled: true/)

  // Compaction follows the same route and budget.
  assert.match(stdout, new RegExp(`provider: ${OPENAI_COMPATIBLE_ROUTE}\\n\\s+model: qwen3-32b`))
})

test('DeepSeek 模式不引入自建适配器，且原 Messages 适配器正常配置', async (t) => {
  const paths = makeTaskPaths(fileURLToPath(new URL('../.scratch', import.meta.url)), 'T-20261026-120000-abcd')
  const dir = await mkdtemp(join(REPO_ROOT, '.scratch', 'patch-loader-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const patchFile = join(dir, 'harness.patch.yml')
  await writeFile(patchFile, renderHarnessPatch({
    paths,
    mcpEntry: join(dir, 'mcp.ts'),
    nodeExecutable: process.execPath,
    model: {
      modelApiProtocol: 'deepseek',
      modelContextWindow: 0,
      modelAutoCompactRatio: 0.75,
      modelSafetyMarginTokens: 2048,
      modelThinkingAdapter: 'auto',
      modelMaxTokens: 6144,
      modelThinking: 'high',
      provider: 'deepseek-official',
      modelId: 'deepseek-flash',
      baseUrl: '',
    },
  }))

  const { stdout, stderr } = await dumpConfig(patchFile, join(dir, 'dsh-home'))
  assert.equal(stderr.includes('not found'), false, `loader 丢弃了条目：${stderr}`)
  assert.equal(stdout.includes(OPENAI_COMPATIBLE_ROUTE), false)
  assert.match(stdout, /- id: llm-deepseek\n  name: [^\n]+\n  config:\n    maxTokens: 6144\n/)
})
