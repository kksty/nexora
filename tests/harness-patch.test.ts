import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeTaskPaths } from '../src/core/paths.ts'
import { renderHarnessPatch } from '../src/harness/patch.ts'

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
    assert.match(render(), /- id: llm-deepseek\n  config:\n    maxTokens: 32000\n/)

    process.env.LIEBIAN_MODEL_MAX_TOKENS = '4096'
    assert.match(render(), /- id: llm-deepseek\n  config:\n    maxTokens: 4096\n/)

    // A malformed value must not leak into the patch.
    process.env.LIEBIAN_MODEL_MAX_TOKENS = 'abc'
    assert.match(render(), /- id: llm-deepseek\n  config:\n    maxTokens: 32000\n/)
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
