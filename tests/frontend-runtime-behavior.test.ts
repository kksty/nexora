import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

type Invocation = {
  method: string
  path: string
  signal?: AbortSignal
}

function createAppHarness(): {
  app: Record<string, any>
  document: Record<string, any>
} {
  const ids = new Map<string, any>()
  const modalRoot = {
    innerHTML: '',
    querySelector(selector: string) {
      if (!this.innerHTML.includes('chat-modal')) return null
      if (selector === '.chat-modal') {
        return idMap.get('chat-list')?.closest?.('.chat-modal') ?? { isConnected: true }
      }
      if (selector === '[data-chat-close]' || selector === '[data-chat-refresh]') {
        return {
          textContent: '刷新',
          disabled: false,
          addEventListener() {},
        }
      }
      if (selector === '.modal-backdrop') {
        return {
          addEventListener() {},
        }
      }
      return null
    },
  }
  const listeners = new Map<string, Set<(event?: any) => void>>()
  const idMap = ids
  const createList = () => {
    const list: any = {
      innerHTML: '',
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      closest: () => ({ className: 'chat-modal' }),
    }
    return list
  }
  const document = {
    visibilityState: 'visible',
    activeElement: null,
    _listeners: listeners,
    querySelector(selector: string) {
      if (selector === '#modal-root') return modalRoot
      if (selector === '#toast-root') {
        return { append() {} }
      }
      return ids.get(selector.slice(1)) ?? null
    },
    querySelectorAll() {
      return []
    },
    getElementById(id: string) {
      return ids.get(id) ?? null
    },
    createElement() {
      return { className: '', textContent: '', remove() {}, addEventListener() {} }
    },
    addEventListener(type: string, listener: (event?: any) => void) {
      const bucket = listeners.get(type) ?? new Set()
      bucket.add(listener)
      listeners.set(type, bucket)
    },
    removeEventListener(type: string, listener: (event?: any) => void) {
      listeners.get(type)?.delete(listener)
    },
  }
  for (const id of [
    'dashboard',
    'task-view',
    'empty-state',
    'delete-task',
    'workspace-home',
    'breadcrumb',
    'task-search',
    'task-list',
    'sidebar-count',
    'dashboard-metrics',
    'directory-count',
    'dashboard-tasks',
    'dashboard-search',
    'status-filters',
    'panels',
    'tabs',
    'new-task',
    'empty-new-task',
    'dashboard-new-task',
    'conn',
    'conn-text',
  ]) {
    ids.set(id, {
      hidden: false,
      classList: { add() {}, remove() {}, toggle() {} },
      style: {},
      textContent: '',
      innerHTML: '',
      value: '',
      scrollTop: 0,
      addEventListener() {},
    })
  }
  ids.set('toast-root', { append() {} })
  ids.set('modal-root', modalRoot)

  const sandbox = {
    document,
    window: {
      scrollY: 0,
      scrollTo() {},
      addEventListener() {},
    },
    location: { hash: '#T-1', pathname: '/', search: '' },
    history: { replaceState() {} },
    EventSource: undefined,
    AbortController,
    HTMLTextAreaElement: class {},
    requestAnimationFrame: (callback: () => void) => callback(),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    console,
    __nexoraConversationHooks: { exposeTest: true },
  }
  const source = readFileSyncForTest('src/web/public/app.js')
  runInNewContext(source, sandbox)
  const app = (sandbox as any).__nexoraConversationTest
  return { app, document }
}

function readFileSyncForTest(path: string): string {
  return readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), path), 'utf8')
}

test('会话弹窗关闭后，迟到响应不能写回已移除的 DOM', async () => {
  const { app, document } = createAppHarness()
  const modalRoot = document.querySelector('#modal-root')
  const chatList = {
    innerHTML: '<div>initial</div>',
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    closest() {
      return null
    },
  }
  const chatMeta = { textContent: '' }
  const chatError = { textContent: '', hidden: true }
  document.getElementById = (id: string) => {
    if (id === 'chat-list') return chatList
    if (id === 'chat-meta') return chatMeta
    if (id === 'chat-error') return chatError
    return null
  }
  modalRoot.querySelector = (selector: string) => {
    if (selector === '.chat-modal') return { className: 'chat-modal' }
    if (selector === '[data-chat-close]' || selector === '[data-chat-refresh]') {
      return { textContent: '刷新', disabled: false, addEventListener() {} }
    }
    if (selector === '.modal-backdrop') return { addEventListener() {} }
    return null
  }
  let modalHtml = ''
  Object.defineProperty(modalRoot, 'innerHTML', {
    get: () => modalHtml,
    set: (value: string) => {
      modalHtml = value
    },
  })
  modalRoot.innerHTML = '<div class="modal chat-modal"></div>'
  let resolveRequest: ((value: any) => void) | undefined
  const fetchCalls: Invocation[] = []
  app.hooks.fetch = (path: string, options: { method: string; signal?: AbortSignal }) => {
    fetchCalls.push({ path, method: options.method, signal: options.signal })
    return new Promise((resolve) => {
      resolveRequest = resolve
    })
  }
  try {
    app.state.currentId = 'T-1'
    app.openConversation('W-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(fetchCalls.length, 1)
    const request = fetchCalls[0]
    app.closeConversationModal()
    assert.equal(request?.signal?.aborted, true)
    resolveRequest?.({
      ok: true,
      json: async () => ({
        ok: true,
        conversation: {
          workId: 'W-1',
          sessionId: 'sess-1',
          truncated: false,
          entries: [{ seq: 1, role: 'user', text: 'late', at: '2026-10-26T10:00:00Z' }],
        },
      }),
    })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(chatList.innerHTML, '<div>initial</div>')
    assert.equal(modalRoot.innerHTML, '')
  } finally {
    app.hooks.fetch = null
  }
})

test('会话轮询不会把读者从上方位置拉到底部', () => {
  const { app, document } = createAppHarness()
  const chatList = {
    innerHTML: '',
    scrollTop: 120,
    scrollHeight: 1200,
    clientHeight: 400,
  }
  document.getElementById = (id: string) => {
    if (id === 'chat-list') return chatList
    if (id === 'chat-meta') return { textContent: '' }
    return null
  }
  app.renderConversation(
    {
      workId: 'W-1',
      sessionId: 'sess-1',
      truncated: false,
      entries: [{ seq: 1, role: 'user', text: 'hello', at: '2026-10-26T10:00:00Z' }],
    },
    { force: true },
  )
  assert.equal(chatList.scrollTop, 120)
})

test('页面隐藏时暂停轮询，恢复可见时只发起一次刷新并重启轮询', async () => {
  let fetchCount = 0
  const sandboxCalls = {
    intervals: 0,
    cleared: 0,
    scheduled: 0,
  }
  const previousSetInterval = globalThis.setInterval
  const previousClearInterval = globalThis.clearInterval
  try {
    const { app } = createAppHarness()
    app.hooks.setInterval = () => {
      sandboxCalls.scheduled += 1
      return sandboxCalls.scheduled
    }
    app.hooks.clearInterval = () => {
      sandboxCalls.cleared += 1
    }
    app.state.currentId = 'T-1'
    app.hooks.fetch = async () => {
      fetchCount += 1
      return {
        ok: true,
        json: async () => ({
          ok: true,
          conversation: { workId: 'W-1', sessionId: 'sess-1', truncated: false, entries: [] },
        }),
      }
    }
    app.openConversation('W-1')
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    app.pauseConversationRefresh()
    app.resumeConversationRefresh()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    assert.equal(fetchCount, 2)
    assert.equal(sandboxCalls.cleared, 1)
    assert.equal(sandboxCalls.scheduled, 2)
  } finally {
    ;(globalThis as any).setInterval = previousSetInterval
    ;(globalThis as any).clearInterval = previousClearInterval
  }
})

test('其他弹窗替换会话弹窗时，旧监听和轮询都会停止', async () => {
  const { app, document } = createAppHarness()
  const existingListeners = document._listeners as Map<string, Set<(event?: any) => void>>
  const listeners = new Map<string, Set<(event?: any) => void>>(existingListeners)
  document.addEventListener = (type: string, listener: (event?: any) => void) => {
    const bucket = listeners.get(type) ?? new Set()
    bucket.add(listener)
    listeners.set(type, bucket)
  }
  document.removeEventListener = (type: string, listener: (event?: any) => void) => {
    listeners.get(type)?.delete(listener)
  }
  let abortCount = 0
  let resolveRequest: ((value: any) => void) | undefined
  let requestSignal: AbortSignal | undefined
  app.hooks.fetch = (path: string, options: { signal?: AbortSignal }) => {
    if (path.includes('/conversation?')) {
      requestSignal = options.signal
      requestSignal?.addEventListener('abort', () => {
        abortCount += 1
      })
      return new Promise((resolve) => {
        resolveRequest = resolve
      })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, tasks: [] }),
    })
  }
  app.hooks.setInterval = () => 1
  app.hooks.clearInterval = () => {}
  app.state.currentId = 'T-1'
  app.openConversation('W-1')
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.equal(listeners.get('keydown')?.size, 1)

  const modalRoot = document.querySelector('#modal-root')
  // Configuration modal dispatches this event before replacing modal-root.
  for (const listener of listeners.get('nexora:modal-before-replace') ?? []) listener()
  modalRoot.innerHTML = '<div class="modal-backdrop"></div>'
  assert.equal(requestSignal?.aborted, true)
  assert.equal(abortCount, 1)
  assert.equal(listeners.get('keydown')?.size, 0)

  for (const listener of listeners.get('keydown') ?? []) listener({ key: 'Escape' })
  assert.equal(modalRoot.innerHTML, '<div class="modal-backdrop"></div>')
  resolveRequest?.({
    ok: true,
    json: async () => ({
      ok: true,
      conversation: { workId: 'W-1', sessionId: 'sess-1', truncated: false, entries: [] },
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  app.hooks.fetch = null
})
