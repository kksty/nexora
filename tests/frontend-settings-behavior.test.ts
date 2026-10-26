import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

type FakeElement = {
  id?: string
  value: string
  textContent: string
  innerHTML: string
  hidden: boolean
  disabled: boolean
  checked: boolean
  dataset: Record<string, string>
  children: FakeElement[]
  listeners: Record<string, (...args: any[]) => any>
  classList: { toggle: (name: string, value?: boolean) => void }
  addEventListener: (name: string, fn: (...args: any[]) => any) => void
  append: (...items: FakeElement[]) => void
  replaceChildren: (...items: FakeElement[]) => void
  querySelector: (selector: string) => FakeElement | null
  querySelectorAll: (selector?: string) => FakeElement[]
}

function makeElement(id = ''): FakeElement {
  const element = {
    id,
    value: '',
    textContent: id,
    innerHTML: '',
    hidden: true,
    disabled: false,
    checked: false,
    dataset: {},
    children: [] as FakeElement[],
    listeners: {} as Record<string, (...args: any[]) => any>,
    classList: { toggle() {} },
    addEventListener(name: string, fn: (...args: any[]) => any) { this.listeners[name] = fn },
    append(...items: FakeElement[]) { this.children.push(...items) },
    replaceChildren(...items: FakeElement[]) { this.children = [...items] },
    querySelector() { return null },
    querySelectorAll() { return [] },
  }
  return element
}

function createHarness() {
  const elements = new Map<string, FakeElement>()
  let modalHtml = ''
  const presets = [32_000, 64_000, 128_000].map((value) => {
    const item = makeElement('[data-context-preset]')
    item.dataset.contextPreset = String(value)
    return item
  })
  const ids = [
    'settings-api-key', 'settings-provider', 'settings-model', 'settings-base-url',
    'settings-model-options', 'settings-model-concurrency', 'settings-model-max-tokens',
    'settings-model-api-protocol', 'settings-model-context-window',
    'settings-model-auto-compact-ratio', 'settings-model-safety-margin-tokens',
    'settings-model-thinking', 'settings-model-thinking-adapter', 'settings-clear-key',
  ]
  for (const id of ids) elements.set(id, makeElement(id))
  for (const selector of ['[data-close]', '[data-error]', '[data-load-models]', '[data-model-list]', '[data-test-model]', '[data-test-result]', '[data-save]', '[data-reset]', '[data-budget-preview]']) {
    elements.set(selector, makeElement(selector))
  }
  elements.get('settings-provider')!.value = 'deepseek-official'
  elements.get('settings-model')!.value = 'deepseek-chat'
  elements.get('settings-base-url')!.value = 'https://api.deepseek.com'
  elements.get('settings-model-concurrency')!.value = '4'
  elements.get('settings-model-max-tokens')!.value = '32000'
  elements.get('settings-model-api-protocol')!.value = 'deepseek'
  elements.get('settings-model-context-window')!.value = '0'
  elements.get('settings-model-auto-compact-ratio')!.value = '75'
  elements.get('settings-model-safety-margin-tokens')!.value = '2048'
  elements.get('settings-model-thinking')!.value = 'high'
  elements.get('settings-model-thinking-adapter')!.value = 'auto'
  const modal = makeElement('modal')
  modal.querySelector = (selector) => elements.get(selector.startsWith('#') ? selector.slice(1) : selector) ?? elements.get(selector) ?? null
  modal.querySelectorAll = (selector) => selector === '[data-context-preset]' ? presets : selector === '[data-close]' ? [elements.get('[data-close]')!] : []
  elements.set('modal', modal)
  const modalRoot = makeElement('modal-root')
  Object.defineProperty(modalRoot, 'innerHTML', {
    get: () => modalHtml,
    set: (value: string) => { modalHtml = value },
  })
  modalRoot.querySelector = (selector) => selector === '.modal' && modalHtml.length > 0
    ? modal
    : selector === '.modal-backdrop' && modalHtml.length > 0
      ? makeElement('modal-backdrop')
      : null
  const document = {
    querySelector: (selector: string) => selector === '#modal-root' ? modalRoot : null,
    createElement: () => makeElement('created'),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true },
  }
  const sandbox = { document, AbortController, Event: class { type: string; constructor(type: string) { this.type = type } }, setTimeout, clearTimeout, console, __nexoraAdminHooks: { exposeTest: true } }
  runInNewContext(readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'src/web/public/admin.js'), 'utf8'), sandbox)
  const api = (sandbox as any).__nexoraAdminTest
  return { elements, presets, modalRoot, api }
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'deepseek-official', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com',
    modelConcurrency: 4, modelMaxTokens: 32_000, modelThinking: 'high', apiKeySet: true, savedOverride: true,
    ...overrides,
  }
}

test('设置弹窗收集协议、上下文和压缩预算字段', async () => {
  const h = createHarness()
  let submitted: any
  h.api.hooks.fetch = (_path: string, options: any) => {
    submitted = JSON.parse(options.body)
    return { ok: true, json: async () => ({ ok: true, settings: { apiKeySet: true } }) }
  }
  h.api.openSettingsModal(settings())
  assert.equal(h.elements.get('settings-model-api-protocol')!.value, 'deepseek')
  h.elements.get('settings-model-api-protocol')!.value = 'openai-compatible'
  h.elements.get('settings-model')!.value = 'qwen3.8-27b'
  h.elements.get('settings-model-context-window')!.value = '64000'
  h.elements.get('settings-model-auto-compact-ratio')!.value = '80'
  h.elements.get('settings-model-safety-margin-tokens')!.value = '4096'
  h.elements.get('settings-model-thinking-adapter')!.value = 'vllm'
  h.elements.get('settings-model-max-tokens')!.value = '8192'
  h.elements.get('[data-save]')!.listeners.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual({
    model: submitted.model, modelApiProtocol: submitted.modelApiProtocol,
    modelContextWindow: submitted.modelContextWindow, modelAutoCompactRatio: submitted.modelAutoCompactRatio,
    modelSafetyMarginTokens: submitted.modelSafetyMarginTokens, modelThinkingAdapter: submitted.modelThinkingAdapter,
    modelMaxTokens: submitted.modelMaxTokens,
  }, { model: 'qwen3.8-27b', modelApiProtocol: 'openai-compatible', modelContextWindow: 64000, modelAutoCompactRatio: 0.8, modelSafetyMarginTokens: 4096, modelThinkingAdapter: 'vllm', modelMaxTokens: 8192 })
})

test('输出预算加安全余量达到窗口时拒绝保存', async () => {
  const h = createHarness()
  let calls = 0
  h.api.hooks.fetch = () => { calls += 1; throw new Error('should not call') }
  h.api.openSettingsModal(settings())
  h.elements.get('settings-model-context-window')!.value = '32000'
  h.elements.get('settings-model-max-tokens')!.value = '30000'
  h.elements.get('settings-model-safety-margin-tokens')!.value = '2048'
  h.elements.get('[data-save]')!.listeners.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls, 0)
  assert.match(h.elements.get('[data-error]')!.textContent, /输入与输出共用总量|上下文窗口/)
})

test('模型列表提示只有模型 ID，不能当作上下文容量检测', async () => {
  const h = createHarness()
  h.api.hooks.fetch = () => ({ ok: true, json: async () => ({ ok: true, result: { success: true, models: ['qwen3.8-27b'], message: '获取到 1 个模型' } }) })
  h.api.openSettingsModal(settings({ model: '' }))
  h.elements.get('settings-model-api-protocol')!.value = 'openai-compatible'
  h.elements.get('settings-model-thinking-adapter')!.value = 'none'
  h.elements.get('[data-load-models]')!.listeners.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const modelList = h.elements.get('[data-model-list]')!
  assert.equal(modelList.hidden, false)
  assert.equal(modelList.children.some((item) => item.textContent.includes('模型列表通常只返回 ID')), true)
})

test('切换协议会取消迟到的模型列表结果', async () => {
  const h = createHarness()
  let resolveFetch: ((value: any) => void) | undefined
  h.api.hooks.fetch = (_path: string, options: any) => new Promise((resolve) => { resolveFetch = resolve; void options })
  h.api.openSettingsModal(settings())
  const pending = h.elements.get('[data-load-models]')!.listeners.click()
  h.elements.get('settings-model-api-protocol')!.value = 'openai-compatible'
  h.elements.get('settings-model-api-protocol')!.listeners.input()
  resolveFetch?.({ ok: true, json: async () => ({ ok: true, result: { success: true, models: ['late'], message: 'late' } }) })
  await pending
  assert.equal(h.elements.get('[data-model-list]')!.hidden, true)
})
