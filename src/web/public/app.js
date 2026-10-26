/* Web UI for the liebian runtime. Plain ES module, no build step. */

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const STATUS_TEXT = { active: '进行中', completed: '已完成', stopped: '已停止' }
const STATUS_CHIP = { active: 'teal', completed: 'green', stopped: 'red' }
const RUN_TEXT = {
  starting: '启动中',
  running: '执行中',
  idle: '空闲',
  waiting: '等待中',
  retrying: '重试中',
  exited: '已退出',
  finished: '已结束',
}
const RUN_CHIP = {
  starting: 'blue',
  running: 'teal',
  idle: 'blue',
  waiting: 'blue',
  retrying: 'red',
  exited: 'gray',
  finished: 'gray',
}
const KIND_TEXT = { hint: '提示', request: '请求', reply: '回复', handoff: '交接', notice: '通知' }
const MESSAGE_STATUS_TEXT = {
  pending: '待投递',
  delivered: '已投递',
  read: '已读',
  'recipient-exited': '接收者已退出',
}
const COMMAND_STATUS_TEXT = {
  saved: '已保存，等待投递',
  enqueued: '已入 harness 队列',
  'entered-context': '已进入模型上下文',
  'recipient-exited': '收件 work 已退出',
}
const COMMAND_STATUS_CHIP = {
  saved: 'amber',
  enqueued: 'blue',
  'entered-context': 'green',
  'recipient-exited': 'gray',
}
const OPINION_TEXT = { agree: '同意', disagree: '反对', unsure: '不确定' }
const OPINION_CHIP = { agree: 'green', disagree: 'red', unsure: 'amber' }
const ROUND_STATUS_TEXT = { open: '开放中', completed: '已通过', invalidated: '已失效' }
const ROUND_STATUS_CHIP = { open: 'teal', completed: 'green', invalidated: 'gray' }
const FILE_GROUP_TEXT = {
  doc: '任务文档',
  audit: '审计日志',
  consensus: '完成共识',
  evidence: '证据文件',
  log: '运行日志',
  config: '配置',
}

const state = {
  tasksRoot: '',
  tasks: [],
  dashboardStatus: 'all',
  currentId: null,
  detail: null,
  tab: 'overview',
  stream: null,
  streamId: null,
  lastRevision: null,
  detailLoading: false,
  detailPending: false,
  refreshTimer: null,
  file: null,
  fileLoading: false,
  openingFile: false,
  pendingPanelRender: false,
  // The command composer is re-rendered on every state refresh; keep the draft
  // here so a background refresh can never silently clear typed input.
  commandDraft: '',
  // A failed submission keeps its request id so a retry of the same text is
  // idempotent even if the first response was lost after the runtime commit.
  pendingCommand: null,
  pendingContinue: null,
  filters: {
    findings: { q: '', type: '', author: '', history: false },
    messages: { q: '', kind: '', status: '', system: false },
    showExited: false,
  },
}

// Hooks are inert in the browser and can be enabled by the local VM tests.
const conversationHooks = globalThis.__nexoraConversationHooks ?? {}
const conversationTestHooks = {
  fetch: null,
  setInterval: null,
  clearInterval: null,
  setPolling: null,
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])

function toast(message, type = 'info') {
  const root = $('#toast-root')
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = String(message)
  root.append(el)
  setTimeout(() => el.remove(), 4800)
}

function setConn(kind, text) {
  const conn = $('#conn')
  conn.className = `conn ${kind}`
  $('#conn-text').textContent = text
}

function fmtTime(value) {
  if (typeof value !== 'string' || value.length === 0) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}

function relTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 45) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`
  return fmtTime(value)
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function chip(text, kind = 'gray') {
  return `<span class="chip ${kind}">${esc(text)}</span>`
}

function array(value) {
  return Array.isArray(value) ? value : []
}

async function api(path, options = {}) {
  const method = options.method ?? 'GET'
  const headers = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') headers['x-liebian-web'] = '1'
  const response = await (conversationTestHooks.fetch ?? fetch)(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    // Empty or non-JSON response.
  }
  if (!response.ok || payload === null || payload.ok !== true) {
    if (response.status === 401) setConn('bad', '需要重新登录')
    const error = new Error(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`)
    error.code = payload?.error?.code
    throw error
  }
  return payload
}

// ---------------------------------------------------------------------------
// Task list
// ---------------------------------------------------------------------------

async function loadSession() {
  const session = await api('/api/session')
  state.tasksRoot = session.tasksRoot ?? ''
  const root = $('#tasks-root')
  root.textContent = state.tasksRoot
  root.title = state.tasksRoot
}

async function loadTasks() {
  const payload = await api('/api/tasks')
  state.tasks = Array.isArray(payload.tasks) ? payload.tasks : []
  renderTaskList()
  renderDashboard()
}

function renderDashboard() {
  const tasks = state.tasks
  $('#sidebar-count').textContent = tasks.length
  const metrics = [
    ['全部任务', tasks.length, '工作空间中的探索', '▦'],
    ['进行中', tasks.filter((t) => t.status === 'active').length, '正在推进的目标', '↗'],
    ['已完成', tasks.filter((t) => t.status === 'completed').length, '已达成完成共识', '✓'],
    ['共享发现', tasks.reduce((n, t) => n + (t.findingCount ?? 0), 0), '探索中积累的成果', '◈'],
  ]
  $('#dashboard-metrics').innerHTML = metrics.map(([label, value, hint, icon], i) => `<div class="dashboard-metric"><div class="metric-top">${label}<span class="metric-icon metric-${i}" aria-hidden="true">${icon}</span></div><strong>${value}</strong><small>${hint}</small></div>`).join('')
  const query = $('#dashboard-search').value.trim().toLowerCase()
  const filtered = tasks.filter((t) => (state.dashboardStatus === 'all' || t.status === state.dashboardStatus) && `${t.taskId} ${t.startPreview ?? ''} ${t.endPreview ?? ''}`.toLowerCase().includes(query))
  $('#directory-count').textContent = filtered.length
  $('#dashboard-tasks').innerHTML = filtered.length ? `<div class="directory-table"><div class="directory-table-head"><span>任务 / 目标</span><span>状态</span><span>发现</span><span>最近更新</span><span></span></div>${filtered.map((t) => `<button type="button" class="directory-row" data-action="select-task" data-id="${esc(t.taskId)}"><span class="directory-task"><span class="task-symbol" aria-hidden="true">◇</span><span><strong>${esc(t.startPreview || '未命名任务')}</strong><small>${esc(t.taskId)}</small></span></span><span>${chip(STATUS_TEXT[t.status] ?? t.status, STATUS_CHIP[t.status] ?? 'gray')}</span><span class="directory-findings">${t.findingCount ?? 0}<small>条发现</small></span><span class="directory-time">${esc(relTime(t.updatedAt))}</span><span class="row-arrow" aria-hidden="true">↗</span></button>`).join('')}</div>` : `<div class="directory-empty"><span aria-hidden="true">◇</span><h3>${tasks.length ? '没有匹配的任务' : '下一个突破，从这里开始'}</h3><p>${tasks.length ? '试试其他关键词，或切换任务状态。' : '创建第一个任务，定义目标，让执行者开始探索。'}</p>${tasks.length ? '' : '<button class="btn primary" type="button" data-dashboard-create>＋ 创建第一个任务</button>'}</div>`
}

function showDashboard() {
  closeConversationModal()
  closeStream()
  state.currentId = null
  state.detail = null
  $('#dashboard').hidden = false
  $('#task-view').hidden = true
  $('#empty-state').hidden = true
  $('#delete-task').hidden = true
  $('#workspace-home').classList.add('active')
  $('#breadcrumb').textContent = '概览'
  history.replaceState(null, '', location.pathname + location.search)
  renderTaskList()
  renderDashboard()
  setConn('ok', '已连接工作空间')
}

function renderTaskList() {
  const query = ($('#task-search').value ?? '').trim().toLowerCase()
  const tasks = state.tasks.filter((task) => {
    if (query.length === 0) return true
    return (
      task.taskId.toLowerCase().includes(query) ||
      (task.startPreview ?? '').toLowerCase().includes(query) ||
      (task.endPreview ?? '').toLowerCase().includes(query)
    )
  })
  const list = $('#task-list')
  const scrollTop = list.scrollTop
  if (state.tasks.length === 0) {
    list.innerHTML = `<div class="side-hint">还没有任务。点击“新建任务”开始。</div>`
    return
  }
  if (tasks.length === 0) {
    list.innerHTML = `<div class="side-hint">没有匹配“${esc(query)}”的任务。</div>`
    return
  }
  list.innerHTML = tasks
    .map((task) => {
      const active = task.taskId === state.currentId
      return `<button class="task-item ${active ? 'active' : ''}" type="button" data-action="select-task" data-id="${esc(
        task.taskId,
      )}" title="${esc(task.taskId)}">
        <div class="task-top">
          <span class="task-id">${esc(task.taskId)}</span>
          <span class="status-dot ${esc(task.status)}" title="${esc(STATUS_TEXT[task.status] ?? task.status)}"></span>
        </div>
        <div class="task-meta">
          <span>${esc(STATUS_TEXT[task.status] ?? task.status)}</span>
          <span class="sep">·</span>
          <span>${task.activeWorkCount} work</span>
          ${
            task.runCount > 1
              ? `<span class="sep">·</span><span>第 ${task.runCount} 轮</span>`
              : ''
          }
          <span class="sep">·</span>
          <span>${task.findingCount} 发现</span>
          <span class="sep">·</span>
          <span>${esc(relTime(task.updatedAt))}</span>
        </div>
        <div class="task-preview">${esc(task.startPreview || '（无起始信息）')}</div>
      </button>`
    })
    .join('')
  list.scrollTop = scrollTop
}

// ---------------------------------------------------------------------------
// Task selection and live detail
// ---------------------------------------------------------------------------

async function selectTask(taskId, options = {}) {
  if (typeof taskId !== 'string' || taskId.length === 0) return
  $('#dashboard').hidden = true
  $('#delete-task').hidden = false
  $('#workspace-home').classList.remove('active')
  $('#breadcrumb').textContent = '任务详情'
  const changed = state.currentId !== taskId
  if (changed) closeConversationModal()
  state.currentId = taskId
  state.file = null
  if (changed) {
    state.detail = null
    state.pendingCommand = null
    state.commandDraft = ''
    state.pendingContinue = null
    state.filters.findings = { q: '', type: '', author: '', history: false }
    state.filters.messages = { q: '', kind: '', status: '', system: false }
    state.filters.showExited = false
  }
  if (options.updateHash !== false) {
    const target = `#${encodeURIComponent(taskId)}`
    if (location.hash !== target) history.replaceState(null, '', target)
  }
  if (changed) window.scrollTo({ top: 0 })
  $('#empty-state').hidden = true
  $('#task-view').hidden = false
  $('#task-title').textContent = taskId
  $('#task-sub').innerHTML = `<span class="muted">正在加载…</span>`
  renderTaskList()
  connectStream(taskId)
  try {
    await loadDetail(taskId, { force: true })
  } catch (error) {
    toast(error.message, 'err')
  }
}

function closeStream() {
  if (state.stream !== null) {
    state.stream.close()
    state.stream = null
    state.streamId = null
  }
}

function connectStream(taskId) {
  closeStream()
  if (typeof EventSource === 'undefined') return
  setConn('warn', '实时连接中…')
  const source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`)
  state.stream = source
  state.streamId = taskId
  source.addEventListener('open', () => setConn('ok', '实时'))
  source.addEventListener('ready', (event) => {
    setConn('ok', '实时')
    try {
      state.lastRevision = JSON.parse(event.data).revision ?? null
    } catch {
      state.lastRevision = null
    }
  })
  source.addEventListener('change', () => {
    setConn('ok', '实时')
    scheduleDetailRefresh(160)
  })
  source.onerror = () => {
    if (state.streamId === taskId) setConn('bad', '实时连接中断，自动重试…')
  }
}

function scheduleDetailRefresh(delay = 200) {
  if (state.refreshTimer !== null) clearTimeout(state.refreshTimer)
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null
    void loadDetail(state.currentId, { preserveScroll: true })
  }, delay)
}

async function loadDetail(taskId, options = {}) {
  if (taskId === null) return
  if (state.detailLoading) {
    state.detailPending = true
    return
  }
  state.detailLoading = true
  try {
    const payload = await api(`/api/tasks/${encodeURIComponent(taskId)}`)
    if (state.currentId !== taskId) return
    state.detail = payload.detail
    renderDetail({ preserveScroll: options.preserveScroll === true })
  } catch (error) {
    toast(error.message, 'err')
  } finally {
    state.detailLoading = false
    if (state.detailPending) {
      state.detailPending = false
      scheduleDetailRefresh(80)
    }
  }
}

function isEditingInPanel() {
  const active = document.activeElement
  return (
    active !== null &&
    (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT') &&
    active.closest('#panels') !== null
  )
}

function renderDetail(options = {}) {
  const detail = state.detail
  if (detail === null || detail.summary.taskId !== state.currentId) return
  const summary = detail.summary
  const runtime = detail.runtime

  $('#task-title').textContent = summary.taskId
  const online = runtime.online || runtime.containerRunning === true
  const runtimeLabel = runtime.online ? '运行时在线' : runtime.containerRunning ? 'Docker 容器运行中' : '运行时未运行'
  $('#task-sub').innerHTML = [
    chip(STATUS_TEXT[summary.status] ?? summary.status, STATUS_CHIP[summary.status] ?? 'gray'),
    `<span>v${summary.targetVersion}</span>`,
    `<span>更新于 ${esc(relTime(summary.updatedAt))}</span>`,
    `<span class="${online ? 'online' : 'offline'}">${runtimeLabel}</span>`,
  ].join('')

  const actions = []
  actions.push(`<button class="btn" type="button" data-action="refresh">刷新</button>`)
  if (summary.status === 'active') {
    if (summary.activeWorkCount === 0) {
      actions.push(`<button class="btn primary" type="button" data-action="recover">恢复工作</button>`)
    }
    if (!online) {
      actions.push(`<button class="btn primary" type="button" data-action="run">启动运行时</button>`)
    }
    actions.push(`<button class="btn danger" type="button" data-action="stop">停止任务</button>`)
    actions.push(`<button class="btn" type="button" data-action="edit-end">修改终点</button>`)
    actions.push(`<button class="btn ghost" type="button" data-action="edit-start">修改起始</button>`)
  } else {
    actions.push(`<button class="btn primary" type="button" data-action="resume">继续</button>`)
    actions.push(`<button class="btn" type="button" data-action="continue">继续并发送指令</button>`)
    if (summary.status === 'completed') {
      actions.push(
        `<button class="btn" type="button" data-action="open-file" data-path="runtime/consensus/consensus.md">查看完成共识</button>`,
      )
    }
  }
  $('#task-actions').innerHTML = actions.join('')

  $('#count-works').textContent = summary.activeWorkCount > 0 ? summary.activeWorkCount : ''
  $('#count-findings').textContent = summary.findingCount > 0 ? summary.findingCount : ''
  $('#count-messages').textContent = summary.messageCount > 0 ? summary.messageCount : ''
  $('#count-commands').textContent = summary.commandCount > 0 ? summary.commandCount : ''
  $('#count-rounds').textContent = summary.roundCount > 0 ? summary.roundCount : ''

  const scrollY = window.scrollY
  if (isEditingInPanel()) {
    state.pendingPanelRender = true
    return
  }
  renderActivePanel()
  if (options.preserveScroll === true) {
    requestAnimationFrame(() => window.scrollTo({ top: scrollY }))
  }
}

function setTab(tab) {
  if (!['overview', 'works', 'findings', 'messages', 'commands', 'rounds', 'files'].includes(tab)) return
  state.tab = tab
  for (const button of $$('#tabs .tab')) {
    button.classList.toggle('active', button.dataset.tab === tab)
  }
  for (const panel of $$('#panels .panel')) {
    panel.hidden = panel.dataset.panel !== tab
  }
  if (state.detail !== null) {
    if (tab === 'files' && state.file === null && state.detail.files.length > 0) {
      void openFile(state.detail.files[0].path)
      return
    }
    renderActivePanel()
  }
}

function renderActivePanel() {
  const detail = state.detail
  if (detail === null) return
  const panel = $(`#panels .panel[data-panel="${state.tab}"]`)
  if (panel === null) return
  // Re-rendering replaces the whole subtree. That drops the sticky file list's
  // own scroll offset and can pull the page back to the top mid-read, which is
  // why a live task (every `change` event re-renders) felt like it "jumped".
  const pageY = window.scrollY
  const fileList = panel.querySelector('.file-list')
  const fileListTop = fileList === null ? null : fileList.scrollTop
  const preview = panel.querySelector('#file-view .md-body, #file-view pre, #file-view .journal-list')
  const previewTop = preview === null ? null : preview.scrollTop
  switch (state.tab) {
    case 'overview':
      panel.innerHTML = renderOverview(detail)
      break
    case 'works':
      panel.innerHTML = renderWorksPanel(detail)
      break
    case 'findings':
      panel.innerHTML = renderFindingsPanel(detail)
      break
    case 'messages':
      panel.innerHTML = renderMessagesPanel(detail)
      break
    case 'commands':
      panel.innerHTML = renderCommandsPanel(detail)
      break
    case 'rounds':
      panel.innerHTML = renderRoundsPanel(detail)
      break
    case 'files':
      panel.innerHTML = renderFilesPanel(detail)
      break
  }
  if (fileListTop !== null) {
    const nextList = panel.querySelector('.file-list')
    if (nextList !== null) nextList.scrollTop = fileListTop
  }
  if (previewTop !== null) {
    const nextPreview = panel.querySelector('#file-view .md-body, #file-view pre, #file-view .journal-list')
    if (nextPreview !== null) nextPreview.scrollTop = previewTop
  }
  if (window.scrollY !== pageY) window.scrollTo(0, pageY)
}

/**
 * Replace just the preview pane, leaving the file list (and the page scroll)
 * untouched. Opening a file must not rebuild the panel around it.
 */
function refreshFileView() {
  const view = document.getElementById('file-view')
  if (view === null) return false
  view.innerHTML = fileViewHtml()
  for (const button of document.querySelectorAll('.file-btn')) {
    button.classList.toggle('active', button.dataset.path === state.file?.path)
  }
  return true
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function renderOverview(detail) {
  const summary = detail.summary
  const runtime = detail.runtime
  const stateData = detail.state
  const currentRound = array(stateData.rounds).find((round) => round.id === stateData.currentRoundId) ?? null
  const blockers = runtime.blockers
  const startVersion = array(stateData.startHistory).at(-1)?.version ?? 1
  const endVersion = stateData.targetVersion

  const blockerHtml =
    summary.status !== 'active'
      ? `<div class="empty-hint">任务已${summary.status === 'completed' ? '完成' : '停止'}，运行时不再参与完成判定。点击顶部“继续”即可在同一任务中开启新一轮，无需填写指令。</div>`
      : summary.activeWorkCount === 0
        ? `<div class="empty-hint">当前没有参与 work；空集合不会判定完成。点击“恢复工作”创建承接执行者，或继续等待原 work 恢复。</div>`
        : blockers === null
          ? runtime.containerRunning === true
            ? `<div class="empty-hint">Docker 任务容器在运行，但管理 API 暂未响应；这里显示最近保存的状态。</div>`
            : `<div class="empty-hint">运行时未在运行，启动后可查看实时阻塞项；离线状态仍可直接修改信息或启动任务。</div>`
          : blockers.length === 0
            ? `<ul class="note-list ok"><li>没有阻塞项：当前满足完成提交条件。</li></ul>`
            : `<ul class="note-list">${blockers.map((blocker) => `<li>${esc(blocker)}</li>`).join('')}</ul>`

  const consensusBody =
    currentRound !== null
      ? roundBlock(currentRound, true)
      : stateData.completion !== null
        ? completionBlock(stateData.completion)
        : summary.status === 'stopped'
          ? `<div class="empty-hint">任务已停止，没有形成完成共识。停止不是完成。</div>`
          : summary.status === 'active' && summary.activeWorkCount === 0
            ? `<div class="empty-hint">本轮没有参与 work，不会形成完成共识；先恢复工作，由承接执行者重新判断。</div>`
            : `<div class="empty-hint">当前没有开放的共识轮次。全体参与的 work 需要先发起并同意终点。</div>`

  const daemonTail = (detail.logs?.daemon ?? '').trim()
  const runTail = (detail.logs?.run ?? '').trim()
  const logTail = daemonTail.length > 0 ? daemonTail : runTail
  const logLabel = daemonTail.length > 0 ? '查看 daemon 日志末尾' : '查看启动输出末尾'
  const runtimeBody = `
    <div class="round-facts">
      <span>状态 <b>${runtime.online ? '在线' : runtime.containerRunning ? '容器运行中' : '离线'}</b></span>
      ${runtime.pid === null ? '' : `<span>PID <b>${runtime.pid}</b></span>`}
      ${runtime.startedAt === null ? '' : `<span>启动于 <b>${esc(fmtTime(runtime.startedAt))}</b></span>`}
      ${summary.interruptedAt === undefined ? '' : `<span>上次中断 <b>${esc(fmtTime(summary.interruptedAt))}</b></span>`}
    </div>
    ${runtime.error === null ? '' : `<p class="round-reason" style="color:var(--amber)">读取实时状态失败：${esc(runtime.error)}</p>`}
    ${
      logTail.length === 0
        ? `<div class="empty-hint">还没有 daemon 日志。</div>`
        : `<details class="history"><summary>${logLabel}</summary><pre class="logbox">${esc(logTail)}</pre></details>`
    }
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn small ghost" type="button" data-action="open-file" data-path="runtime/logs/daemon.log">打开完整日志</button>
      <button class="btn small ghost" type="button" data-action="open-file" data-path="runtime/logs/run.out.log">启动输出</button>
      <button class="btn small ghost" type="button" data-action="open-file" data-path="runtime/journal.jsonl">打开审计日志</button>
    </div>`

  return `
    <div class="status-bar ${summary.status}">
      <span class="status-dot ${summary.status}"></span>
      <strong>${esc(STATUS_TEXT[summary.status] ?? summary.status)}</strong>
      <span title="${esc(fmtTime(summary.updatedAt))}">${esc(relTime(summary.updatedAt))}更新</span>
      <span class="grow"></span>
      <span class="${runtime.online || runtime.containerRunning ? 'online' : 'offline'}">${runtime.online ? '运行时在线' : runtime.containerRunning ? 'Docker 容器运行中' : '运行时未运行'}</span>
      <span>创建于 ${esc(fmtTime(summary.createdAt))}</span>
    </div>
    ${summary.statusReason === undefined ? '' : `<p class="round-reason" style="margin:-6px 0 16px">${esc(summary.statusReason)}</p>`}

    <div class="kpis">
      ${kpi('运行轮次', esc(summary.runId), `累计 ${summary.runCount} 轮`)}
      ${kpi('参与 work', `${summary.activeWorkCount}<small> / ${summary.workCount}</small>`, '活跃 / 累计')}
      ${kpi('共享发现', String(summary.findingCount), '追加式记录')}
      ${kpi('消息', String(summary.messageCount), '全程信箱')}
      ${kpi('用户命令', String(summary.commandCount ?? 0), '任务级人工输入')}
      ${kpi('共识轮次', String(summary.roundCount), currentRound === null ? '当前无开放轮次' : `当前 ${currentRound.id}`)}
      ${kpi('目标版本', `v${summary.targetVersion}`, '终点信息')}
      ${kpi('共享状态版本', String(summary.sharedStateVersion), '任何变更都会递增')}
    </div>

    <div class="grid-2">
      ${infoCard('end', '终点信息', stateData.endInformation, array(stateData.endHistory), endVersion, summary.status === 'active')}
      ${infoCard('start', '起始信息', stateData.startInformation, array(stateData.startHistory), startVersion, summary.status === 'active')}
    </div>

    ${reportCard(detail)}
    ${runsCard(detail)}

    <div class="grid-2">
      <article class="card">
        <div class="card-head"><h3>终点共识</h3><span class="sub">${
          summary.completionRoundId !== null
            ? esc(summary.completionRoundId)
            : summary.status === 'stopped'
              ? '任务已停止'
              : '尚未完成'
        }</span></div>
        ${consensusBody}
        <div style="margin-top:12px">
          <div class="card-head" style="margin-bottom:8px"><h3>阻塞项</h3><span class="sub">由运行时判定</span></div>
          ${blockerHtml}
        </div>
      </article>
      <article class="card">
        <div class="card-head"><h3>运行环境</h3><span class="sub">${runtime.url === null ? '本机离线' : esc(runtime.url)}</span></div>
        ${runtimeBody}
      </article>
    </div>
  `
}

function kpi(label, value, hint) {
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="hint">${esc(hint)}</div></div>`
}

function infoCard(kind, title, text, history, currentVersion, editable) {
  const ordered = history.slice().sort((left, right) => right.version - left.version)
  const historyHtml =
    ordered.length > 1
      ? `<details class="history"><summary>历史版本（${ordered.length}）</summary>${ordered
          .map(
            (version) =>
              `<div class="version-block"><div class="vh">v${version.version} · ${esc(fmtTime(version.at))}${
                version.version === currentVersion ? ' · 当前' : ''
              }</div><div class="vt">${esc(version.text)}</div></div>`,
          )
          .join('')}</details>`
      : ''
  const action = kind === 'end' ? 'edit-end' : 'edit-start'
  return `<article class="card">
    <div class="card-head">
      <h3>${esc(title)}</h3>
      <div style="display:flex;align-items:center;gap:7px">
        ${chip(`v${currentVersion}`, 'gray')}
        ${editable ? `<button class="btn small" type="button" data-action="${action}">修改</button>` : ''}
      </div>
    </div>
    <div class="prose">${esc(text)}</div>
    ${historyHtml}
  </article>`
}

function reportCard(detail) {
  const reports = Object.values(detail.state.reports ?? {}).sort((left, right) => left.key.localeCompare(right.key))
  if (reports.length === 0) {
    return `<article class="card">
      <div class="card-head"><h3>当前报告</h3><span class="sub">未发布</span></div>
      <div class="empty-hint">本任务还没有发布报告。执行者用 report_publish 建立固定入口；没有报告要求的任务不因此阻塞。</div>
    </article>`
  }
  const entryStateText = {
    synced: '入口与已登记版本一致',
    pending: '入口尚未补齐（阻塞完成）',
    drift: '入口被直接修改（阻塞完成，需确认发布或恢复）',
  }
  const rows = reports
    .map(
      (report) => `<div class="round-facts">
        <span>${chip(report.key, 'blue')} <b>r${report.revision}</b></span>
        <span>入口 <b>${esc(report.path)}</b></span>
        <span>发布者 <b>${esc(report.publishedByWorkId)}</b></span>
        <span title="${esc(fmtTime(report.publishedAt))}">${esc(relTime(report.publishedAt))}</span>
        <span>${esc(entryStateText[report.entryState] ?? report.entryState)}</span>
        <span class="spacer"></span>
        <button class="btn small ghost" type="button" data-action="open-file" data-path="${esc(report.path)}">打开报告</button>
      </div>`,
    )
    .join('')
  return `<article class="card">
    <div class="card-head"><h3>当前报告</h3><span class="sub">唯一固定入口</span></div>
    ${rows}
  </article>`
}

function runsCard(detail) {
  const runs = array(detail.state.runs)
  if (runs.length <= 1 && detail.summary.status === 'active') return ''
  const rows = runs
    .slice()
    .reverse()
    .map((run) => {
      const current = run.id === detail.state.currentRunId
      const ending =
        run.status === 'completed'
          ? `完成${run.completion === null ? '' : ` · ${run.completion.roundId}`}`
          : run.status === 'stopped'
            ? `停止${run.stopReason === undefined ? '' : ` · ${esc(run.stopReason)}`}`
            : '进行中'
      const cleanup =
        run.cleanup === 'done'
          ? '已清理'
          : run.cleanup === 'pending'
            ? '待清理'
            : '—'
      return `<div class="round-facts">
        <span>${chip(run.id, current ? 'teal' : 'gray')}${current ? ' 当前' : ''}</span>
        <span>${esc(STATUS_TEXT[run.status] ?? run.status)}</span>
        <span>${esc(ending)}</span>
        <span>目标 <b>v${run.targetVersion}</b></span>
        <span>work <b>${esc(array(run.workIds).join(', ') || '（无）')}</b></span>
        <span>清理 <b>${cleanup}</b></span>
      </div>`
    })
    .join('')
  return `<article class="card">
    <div class="card-head"><h3>运行轮次</h3><span class="sub">共 ${runs.length} 轮；新一轮不复用旧轮次表态</span></div>
    ${rows}
    <div class="empty-hint" style="margin-top:8px">继续任务会在同一任务 ID 下创建新的运行轮次；发现、证据、当前报告和仍有效的用户命令跨轮次保留。</div>
  </article>`
}

function completionBlock(completion) {  return `<div class="completion-card">
    <h3>✓ 完成共识 ${esc(completion.roundId)}</h3>
    <div class="round-facts">
      <span>完成于 <b>${esc(fmtTime(completion.completedAt))}</b></span>
      ${completion.runId === undefined ? '' : `<span>轮次 <b>${esc(completion.runId)}</b></span>`}
      <span>目标版本 <b>v${completion.targetVersion}</b></span>
      <span>共享状态版本 <b>${completion.sharedStateVersion}</b></span>
      <span>参与 <b>${array(completion.participants).length}</b></span>
    </div>
    <button class="btn small" type="button" data-action="open-file" data-path="runtime/consensus/consensus.md">打开 consensus.md</button>
  </div>`
}

// ---------------------------------------------------------------------------
// Works
// ---------------------------------------------------------------------------

function workStatusChip(status) {
  const label = RUN_TEXT[status] ?? status
  const kind = RUN_CHIP[status] ?? 'gray'
  return `<span class="chip ${kind} ${status === 'running' ? 'running' : ''}">${esc(label)}</span>`
}

function renderWorksPanel(detail) {
  const works = Object.values(detail.state.works)
  const active = works.filter((work) => work.runtimeStatus !== 'exited' && work.runtimeStatus !== 'finished')
  const exited = works.filter((work) => work.runtimeStatus === 'exited' || work.runtimeStatus === 'finished')
  return `
    <div class="section-head">
      <div><h3>执行者</h3><span class="sub">活跃 ${active.length} · 历史 ${exited.length} · 由运行时维护状态</span></div>
      <label class="check"><input type="checkbox" id="show-exited" ${state.filters.showExited ? 'checked' : ''}> 显示已退出</label>
    </div>
    <div id="works-list">${worksListHtml(active, exited)}</div>`
}

function worksListHtml(active, exited) {
  const works = state.filters.showExited ? [...active, ...exited] : active
  if (works.length === 0) {
    return `<div class="empty-hint">${
      exited.length === 0 ? '还没有执行者。启动任务后运行时会在首轮创建一个。' : '没有活跃的执行者；勾选“显示已退出”查看历史。'
    }</div>`
  }
  works.sort((left, right) => left.id.localeCompare(right.id))
  return `<div class="work-grid">${works.map(workCard).join('')}</div>`
}

function workCard(work) {
  const direction = (work.direction ?? '').trim()
  const selfStatus = (work.selfStatus ?? '').trim()
  const lastError = work.lastError
  const parent =
    work.parentWorkId === null || work.parentWorkId === undefined
      ? '根执行者'
      : `来自 ${esc(work.parentWorkId)}`
  const spawn =
    (work.spawnReason ?? '').trim().length > 0 || (work.startPrompt ?? '').trim().length > 0
      ? `<details class="history"><summary>裂变理由与起始提示</summary>
          ${(work.spawnReason ?? '').trim().length > 0 ? `<div class="version-block"><div class="vh">裂变理由</div><div class="vt">${esc(work.spawnReason)}</div></div>` : ''}
          ${(work.startPrompt ?? '').trim().length > 0 ? `<div class="version-block"><div class="vh">起始提示</div><div class="vt">${esc(work.startPrompt)}</div></div>` : ''}
        </details>`
      : ''
  return `<article class="work-card ${esc(work.runtimeStatus)}">
    <div class="work-top">
      <span class="work-id">${esc(work.id)}</span>
      ${workStatusChip(work.runtimeStatus)}
      <span class="spacer"></span>
      <span class="chip gray">${parent}</span>
    </div>
    <div class="work-direction">${esc(direction.length > 0 ? direction : '（尚未填写当前工作方向）')}</div>
    <div class="work-self">${esc(selfStatus.length > 0 ? selfStatus : '（尚未填写自述状态）')}</div>
    ${lastError === undefined ? '' : `<div class="work-error">最近失败：${esc(lastError.message)}\n时间：${esc(fmtTime(lastError.at))} · 尝试 ${esc(lastError.attempts)} 次${lastError.nextRetryAt === undefined ? '' : ` · 下次重试 ${esc(fmtTime(lastError.nextRetryAt))}`}</div>`}
    <div class="work-meta">
      <span>会话 <b>${esc(work.sessionId)}</b></span>
      <span>创建 <b>${esc(fmtTime(work.createdAt))}</b></span>
      <span>更新 <b>${esc(fmtTime(work.updatedAt))}</b></span>
      ${work.exitAt === undefined ? '' : `<span>退出 <b>${esc(fmtTime(work.exitAt))}</b></span>`}
      ${work.exitReason === undefined ? '' : `<span>原因 <b>${esc(work.exitReason)}</b></span>`}
      ${work.recoveredFresh === true ? '<span>已用新会话恢复</span>' : ''}
    </div>
    ${spawn}
    <div class="work-actions">
      <button class="btn small ghost" type="button" data-action="open-conversation" data-work="${esc(work.id)}">查看对话</button>
    </div>
  </article>`
}

// ---------------------------------------------------------------------------
// Executor conversation
// ---------------------------------------------------------------------------

let conversationTimer = null
let conversationSignature = ''
let conversationController = null
let conversationView = null
let conversationSession = 0
let conversationKeydown = null

function removeConversationKeydown() {
  if (conversationKeydown !== null) document.removeEventListener('keydown', conversationKeydown)
  conversationKeydown = null
}

function stopConversationRefresh() {
  if (conversationTimer !== null) (conversationTestHooks.clearInterval ?? clearInterval)(conversationTimer)
  conversationTimer = null
  if (conversationController !== null) conversationController.abort()
  conversationController = null
  removeConversationKeydown()
  conversationSignature = ''
  conversationView = null
  conversationSession += 1
}

function conversationRequestIsCurrent(view, session, taskId, workId) {
  return (
    view !== null &&
    conversationView === view &&
    view.session === session &&
    view.taskId === taskId &&
    view.workId === workId &&
    view.modal !== null &&
    view.modal.isConnected !== false &&
    state.currentId === taskId
  )
}

function conversationSignatureFor(conversation) {
  return `${conversation.workId}:${conversation.sessionId}:${conversation.entries.length}:${conversation.entries.at(-1)?.seq ?? 0}:${conversation.truncated}`
}

function conversationEntryHtml(entry) {
  const time = `<span class="chat-time">${esc(fmtTime(entry.at))}</span>`
  if (entry.role === 'status') {
    const status = entry.status ?? {}
    const text = status.kind === 'retry' ? `重试：${status.code ?? ''} ${status.message ?? ''}` : status.kind === 'error' ? `失败：${status.code ?? ''} ${status.message ?? ''}` : status.message ?? ''
    return `<div class="chat-status ${esc(status.kind ?? '')}">${time}${esc(text)}</div>`
  }
  if (entry.role === 'tool') {
    const tool = entry.tool ?? {}
    if (tool.kind === 'call') {
      return `<details class="chat-tool call">
        <summary><span class="chat-tag">调用</span><code>${esc(tool.name ?? '')}</code>${time}</summary>
        <pre>${esc(tool.arguments ?? '')}</pre>
      </details>`
    }
    const body = entry.text ?? ''
    const first = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
    return `<details class="chat-tool result">
      <summary><span class="chat-tag">结果</span><span class="chat-preview">${esc(first.slice(0, 120))}</span>${tool.truncated ? '<span class="chat-tag warn">已截断</span>' : ''}${time}</summary>
      <pre>${esc(body)}</pre>
    </details>`
  }
  const roleLabel = entry.role === 'user' ? '输入' : '模型'
  const thinking =
    typeof entry.thinking === 'string' && entry.thinking.trim().length > 0
      ? `<details class="chat-thinking"><summary>思考过程 · ${entry.thinking.length} 字符</summary><div class="chat-thinking-body">${esc(entry.thinking)}</div></details>`
      : ''
  const usage =
    entry.usage !== undefined && (entry.usage.inputTokens !== undefined || entry.usage.outputTokens !== undefined)
      ? `<span class="chat-usage">${entry.usage.inputTokens ?? '?'} in / ${entry.usage.outputTokens ?? '?'} out</span>`
      : ''
  return `<div class="chat-row ${esc(entry.role)}">
    <div class="chat-head"><span class="chat-tag">${roleLabel}</span>${time}${usage}</div>
    ${thinking}
    <div class="chat-body md-body">${markdownHtml(entry.text ?? '')}</div>
  </div>`
}

function renderConversation(conversation, options = {}) {
  const list = document.getElementById('chat-list')
  if (list === null) return
  // Polling every few seconds must not rebuild an unchanged transcript: it
  // would collapse the <details> the reader just opened and reset scroll.
  const signature = conversationSignatureFor(conversation)
  if (signature === conversationSignature && options.force !== true) return
  conversationSignature = signature
  const nearBottom = options.forceBottom === true || list.scrollHeight - list.scrollTop - list.clientHeight < 80
  const previousScrollTop = list.scrollTop
  list.innerHTML = conversation.entries.length === 0
    ? '<div class="empty-hint">这个执行者还没有产生对话。任务运行时启动后，第一条消息会出现在这里。</div>'
    : conversation.entries.map(conversationEntryHtml).join('')
  const meta = document.getElementById('chat-meta')
  if (meta !== null) {
    meta.textContent = `${conversation.entries.length} 条记录${conversation.truncated ? '（已截断，仅显示最近部分）' : ''} · 会话 ${conversation.sessionId}`
  }
  if (nearBottom) list.scrollTop = list.scrollHeight
  else list.scrollTop = previousScrollTop
}

async function loadConversation(workId, options = {}) {
  const taskId = state.currentId
  if (taskId === null) return
  const view = options.view ?? conversationView
  const session = options.session ?? view?.session
  if (
    view === null ||
    view === undefined ||
    !conversationRequestIsCurrent(view, session, taskId, workId)
  ) {
    return
  }
  if (conversationController !== null) conversationController.abort()
  const controller = new AbortController()
  conversationController = controller
  try {
    const payload = await api(
      `/api/tasks/${encodeURIComponent(taskId)}/conversation?work=${encodeURIComponent(workId)}`,
      { signal: controller.signal },
    )
    if (!conversationRequestIsCurrent(view, session, taskId, workId)) return
    const errorEl = document.getElementById('chat-error')
    if (errorEl !== null) {
      errorEl.hidden = true
      errorEl.textContent = ''
    }
    renderConversation(payload.conversation, options)
  } catch (error) {
    if (
      controller.signal.aborted ||
      error?.name === 'AbortError' ||
      !conversationRequestIsCurrent(view, session, taskId, workId)
    ) {
      return
    }
    const list = document.getElementById('chat-list')
    if (list === null) return
    const message = error.message || String(error)
    if (conversationSignature.length === 0) {
      list.innerHTML = `<div class="empty-hint">${esc(message)}</div>`
    } else {
      const errorEl = document.getElementById('chat-error')
      if (errorEl !== null) {
        errorEl.textContent = `刷新失败：${message}`
        errorEl.hidden = false
      }
    }
  } finally {
    if (conversationController === controller) conversationController = null
  }
}

function openConversation(workId) {
  if (state.currentId === null) return
  closeConversationModal()
  const root = $('#modal-root')
  const currentTask = state.currentId
  conversationHooks.onOpen?.({ workId, taskId: currentTask })
  root.innerHTML = `<div class="modal-backdrop">
    <div class="modal chat-modal" role="dialog" aria-modal="true" aria-label="${esc(workId)} 的对话">
      <div class="modal-head">
        <h3>${esc(workId)} 的对话</h3>
        <span class="chat-meta" id="chat-meta"></span>
        <span class="spacer"></span>
        <button class="btn small ghost" type="button" data-chat-refresh>刷新</button>
        <button class="modal-close" type="button" data-chat-close aria-label="关闭">×</button>
      </div>
      <div class="chat-error" id="chat-error" role="alert" hidden></div>
      <div class="chat-list" id="chat-list"><div class="empty-hint">加载中…</div></div>
    </div>
  </div>`
  const view = {
    session: conversationSession,
    taskId: currentTask,
    workId,
    modal: root.querySelector('.chat-modal'),
    polling: false,
  }
  conversationView = view
  conversationKeydown = (event) => {
    if (event.key === 'Escape') closeConversationModal()
  }
  document.addEventListener('keydown', conversationKeydown)
  root.querySelector('[data-chat-close]').addEventListener('click', closeConversationModal)
  root.querySelector('.modal-backdrop').addEventListener('mousedown', (event) => {
    if (event.target === root.querySelector('.modal-backdrop')) closeConversationModal()
  })
  root.querySelector('[data-chat-refresh]').addEventListener('click', () => {
    void loadConversation(workId, { forceBottom: false, force: true, view, session: view.session })
  })
  void loadConversation(workId, { forceBottom: true, view, session: view.session })
  const startPolling = () => {
    if (!conversationRequestIsCurrent(view, view.session, view.taskId, workId)) return
    if (conversationTimer !== null) clearInterval(conversationTimer)
    view.polling = true
    conversationHooks.onPollStart?.()
    conversationTimer = (conversationTestHooks.setInterval ?? setInterval)(() => {
      if (
        document.visibilityState !== 'visible' ||
        !conversationRequestIsCurrent(view, view.session, view.taskId, workId)
      ) {
        closeConversationModal()
        return
      }
      void loadConversation(workId, { view, session: view.session })
    }, 3000)
  }
  view.pause = () => {
    if (!view.polling) return
    view.polling = false
    pauseConversationRefresh()
  }
  view.resume = () => {
    if (!conversationRequestIsCurrent(view, view.session, view.taskId, workId)) return
    void loadConversation(workId, { view, session: view.session })
    startPolling()
  }
  startPolling()
}

function pauseConversationRefresh() {
  if (conversationView !== null) conversationView.polling = false
  if (conversationTimer !== null) (conversationTestHooks.clearInterval ?? clearInterval)(conversationTimer)
  conversationTimer = null
  if (conversationController !== null) conversationController.abort()
  conversationController = null
  conversationHooks.onPollPause?.()
}

function resumeConversationRefresh() {
  const view = conversationView
  if (
    view === null ||
    !conversationRequestIsCurrent(view, view.session, view.taskId, view.workId)
  ) {
    return
  }
  if (view.polling === true) return
  if (typeof view.resume === 'function') {
    view.resume()
    return
  }
  void loadConversation(view.workId, { view, session: view.session })
  conversationTimer = (conversationTestHooks.setInterval ?? setInterval)(() => {
    if (
      document.visibilityState !== 'visible'
    ) {
      pauseConversationRefresh()
      return
    }
    void loadConversation(view.workId, { view, session: view.session })
  }, 3000)
}

function closeConversationModal() {
  const root = $('#modal-root')
  const view = conversationView
  const ownsModal =
    view !== null
      ? view.modal !== null && view.modal.isConnected !== false
      : root !== null && root.querySelector('.chat-modal') !== null
  stopConversationRefresh()
  if (ownsModal && root !== null) {
    root.innerHTML = ''
    conversationHooks.onClose?.()
  }
}

if (conversationHooks.exposeTest === true) {
  globalThis.__nexoraConversationTest = {
    hooks: conversationTestHooks,
    state,
    closeConversationModal,
    loadConversation,
    openConversation,
    pauseConversationRefresh,
    renderConversation,
    resumeConversationRefresh,
  }
}

document.addEventListener('nexora:modal-before-replace', () => {
  if (conversationView !== null) closeConversationModal()
})

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function findingTypes(findings) {
  return [...new Set(findings.map((finding) => (finding.type ?? '').trim()).filter((type) => type.length > 0))].sort()
}

function findingAuthors(findings) {
  return [...new Set(findings.map((finding) => finding.authorWorkId))].sort()
}

/** Findings not superseded by another record (the default current view). */
function currentFindingsView(findings) {
  const superseded = new Set()
  for (const finding of findings) {
    for (const target of array(finding.supersedes)) superseded.add(target)
  }
  return findings.filter((finding) => !superseded.has(finding.id))
}

function findingView(findings) {
  return state.filters.findings.history ? findings : currentFindingsView(findings)
}

function renderFindingsPanel(detail) {
  const findings = array(detail.state.findings)
  const current = currentFindingsView(findings)
  const types = findingTypes(findings)
  const authors = findingAuthors(findings)
  return `
    <div class="toolbar">
      <input class="input" id="finding-q" type="search" placeholder="搜索发现正文、ID、引用…" value="${esc(state.filters.findings.q)}">
      <select class="select" id="finding-type">
        <option value="">全部类型</option>
        ${types.map((type) => `<option value="${esc(type)}" ${state.filters.findings.type === type ? 'selected' : ''}>${esc(type)}</option>`).join('')}
      </select>
      <select class="select" id="finding-author">
        <option value="">全部作者</option>
        ${authors.map((author) => `<option value="${esc(author)}" ${state.filters.findings.author === author ? 'selected' : ''}>${esc(author)}</option>`).join('')}
      </select>
      <label class="check" style="align-self:center"><input type="checkbox" id="finding-history" ${state.filters.findings.history ? 'checked' : ''}> 显示历史（${findings.length - current.length}）</label>
      <span class="sub" id="finding-count" style="align-self:center;color:var(--faint);font-size:11.5px">${filteredFindings(detail).length} / ${findingView(findings).length} 条</span>
    </div>
    <p class="sub" style="margin:-4px 0 10px">默认只显示当前有效发现（${current.length} 条）；完整追加日志共 ${findings.length} 条。</p>
    <div class="finding-list" id="finding-list">${findingsListHtml(detail)}</div>`
}

function filteredFindings(detail) {
  const filters = state.filters.findings
  const query = filters.q.trim().toLowerCase()
  return findingView(array(detail.state.findings))
    .slice()
    .reverse()
    .filter((finding) => {
      if (filters.type.length > 0 && (finding.type ?? '').trim() !== filters.type) return false
      if (filters.author.length > 0 && finding.authorWorkId !== filters.author) return false
      if (query.length === 0) return true
      const haystack = [
        finding.id,
        finding.authorWorkId,
        finding.type ?? '',
        finding.text,
        ...array(finding.refs),
        ...array(finding.evidence),
        ...array(finding.supersedes),
        ...array(finding.relatedWork),
      ]
        .join('\n')
        .toLowerCase()
      return haystack.includes(query)
    })
}

function findingsListHtml(detail) {
  const findings = array(detail.state.findings)
  const view = findingView(findings)
  const selected = filteredFindings(detail)
  if (findings.length === 0) return `<div class="empty-hint">还没有共享发现。执行者通过 MCP 追加后这里会实时出现。</div>`
  if (view.length === 0) {
    return `<div class="empty-hint">当前没有有效发现；勾选“显示历史”查看已被替代的记录。</div>`
  }
  if (selected.length === 0) return `<div class="empty-hint">没有符合筛选条件的发现。</div>`
  const corrections = new Map()
  for (const finding of findings) {
    for (const target of array(finding.supersedes)) {
      const list = corrections.get(target) ?? []
      list.push(finding.id)
      corrections.set(target, list)
    }
  }
  return selected
    .map((finding) => {
      const correctedBy = corrections.get(finding.id) ?? []
      const evidence = array(finding.evidence)
      return `<article class="finding" id="finding-${esc(finding.id)}">
        <div class="finding-head">
          <span class="finding-id">${esc(finding.id)}</span>
          <span class="finding-author">${esc(finding.authorWorkId)}</span>
          ${(finding.type ?? '').trim().length > 0 ? chip(finding.type.trim(), 'blue') : ''}
          ${correctedBy.length > 0 ? chip(`已被 ${correctedBy.join(', ')} 更正`, 'amber') : ''}
          <span class="spacer"></span>
          <span class="finding-time" title="${esc(fmtTime(finding.createdAt))}">${esc(relTime(finding.createdAt))}</span>
        </div>
        <div class="finding-body">${esc(finding.text)}</div>
        ${
          array(finding.relatedWork).length > 0 || array(finding.refs).length > 0 || array(finding.supersedes).length > 0
            ? `<div class="finding-foot">
                ${array(finding.relatedWork).map((work) => `<button class="ref-link" type="button" data-action="filter-work" data-id="${esc(work)}">work ${esc(work)}</button>`).join('')}
                ${array(finding.refs).map((ref) => `<span class="ref-link">${esc(ref)}</span>`).join('')}
                ${array(finding.supersedes).map((ref) => `<button class="ref-link" type="button" data-action="jump-finding" data-id="${esc(ref)}">更正 ${esc(ref)}</button>`).join('')}
              </div>`
            : ''
        }
        ${
          evidence.length > 0
            ? `<div class="finding-foot">${evidence
                .map((path) => `<button class="ref-link" type="button" data-action="open-file" data-path="${esc(path)}">证据 ${esc(path)}</button>`)
                .join('')}</div>`
            : ''
        }
      </article>`
    })
    .join('')
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function renderMessagesPanel(detail) {
  const messages = array(detail.state.messages)
  const kinds = [...new Set(messages.map((message) => message.kind))].sort()
  return `
    <div class="toolbar">
      <input class="input" id="message-q" type="search" placeholder="搜索正文、ID、work…" value="${esc(state.filters.messages.q)}">
      <select class="select" id="message-kind">
        <option value="">全部类型</option>
        ${kinds.map((kind) => `<option value="${esc(kind)}" ${state.filters.messages.kind === kind ? 'selected' : ''}>${esc(KIND_TEXT[kind] ?? kind)}</option>`).join('')}
      </select>
      <select class="select" id="message-status">
        <option value="">全部状态</option>
        ${['pending', 'delivered', 'read', 'recipient-exited']
          .map(
            (status) =>
              `<option value="${esc(status)}" ${state.filters.messages.status === status ? 'selected' : ''}>${esc(MESSAGE_STATUS_TEXT[status] ?? status)}</option>`,
          )
          .join('')}
      </select>
      <label class="check" style="align-self:center"><input type="checkbox" id="message-system" ${state.filters.messages.system ? 'checked' : ''}> 运行时通知</label>
      <span class="sub" id="message-count" style="align-self:center;color:var(--faint);font-size:11.5px">${filteredMessages(detail).length} / ${messages.length} 条</span>
    </div>
    <div class="message-list" id="message-list">${messagesListHtml(detail)}</div>`
}

function filteredMessages(detail) {
  const filters = state.filters.messages
  const query = filters.q.trim().toLowerCase()
  return array(detail.state.messages)
    .slice()
    .reverse()
    .filter((message) => {
      if (!filters.system && message.system) return false
      if (filters.kind.length > 0 && message.kind !== filters.kind) return false
      if (filters.status.length > 0 && message.status !== filters.status) return false
      if (query.length === 0) return true
      return [message.id, message.fromWorkId, message.toWorkId, message.kind, message.status, message.body, ...array(message.refs)]
        .join('\n')
        .toLowerCase()
        .includes(query)
    })
}

function messagesListHtml(detail) {
  const messages = array(detail.state.messages)
  const selected = filteredMessages(detail)
  if (messages.length === 0) return `<div class="empty-hint">还没有消息。</div>`
  if (selected.length === 0) return `<div class="empty-hint">没有符合筛选条件的消息。</div>`
  return selected
    .map((message) => {
      const from = message.system ? '运行时' : message.fromWorkId
      return `<article class="message ${message.system ? 'system' : ''}">
        <div class="message-head">
          <span class="message-id">${esc(message.id)}</span>
          <span class="message-flow">${esc(from)} <span style="color:var(--faint)">→</span> ${esc(message.toWorkId)}</span>
          ${chip(KIND_TEXT[message.kind] ?? message.kind, 'purple')}
          ${chip(MESSAGE_STATUS_TEXT[message.status] ?? message.status, message.status === 'pending' ? 'amber' : 'gray')}
          ${message.system ? chip('系统', 'blue') : ''}
          <span class="spacer"></span>
          <span class="message-time" title="${esc(fmtTime(message.createdAt))}">${esc(relTime(message.createdAt))}</span>
        </div>
        <div class="message-body">${esc(message.body)}</div>
        ${
          array(message.refs).length > 0
            ? `<div class="message-foot">${array(message.refs).map((ref) => `<span class="ref-link">${esc(ref)}</span>`).join('')}</div>`
            : ''
        }
        ${
          message.deliveredAt === undefined && message.readAt === undefined && message.note === undefined
            ? ''
            : `<div class="message-foot">
                ${message.deliveredAt === undefined ? '' : `<span>投递 ${esc(fmtTime(message.deliveredAt))}</span>`}
                ${message.readAt === undefined ? '' : `<span>读取 ${esc(fmtTime(message.readAt))}</span>`}
                ${message.note === undefined ? '' : `<span style="color:var(--amber)">${esc(message.note)}</span>`}
              </div>`
        }
      </article>`
    })
    .join('')
}

// ---------------------------------------------------------------------------
// Human commands
// ---------------------------------------------------------------------------

function renderCommandsPanel(detail) {
  const summary = detail.summary
  const commands = array(detail.state.commands).slice().reverse()
  const composer =
    summary.status === 'active'
      ? `<article class="card command-composer">
          <div class="card-head"><h3>发送命令</h3><span class="sub">任务级广播 · 不改变终点版本</span></div>
          <div class="field">
            <textarea id="command-text" placeholder="例如：先暂停当前扫描，优先验证登录入口的注入点。">${esc(state.commandDraft)}</textarea>
            <span class="hint">命令会作为新的用户输入送达当前 ${summary.activeWorkCount} 个 work；提交即让旧完成意见失效。逐 work 状态只表示投递进展，入队不等于要求已完成。</span>
          </div>
          <div class="command-actions"><button class="btn primary" type="button" data-action="send-command">发送命令</button></div>
        </article>`
      : `<div class="empty-hint">任务已${summary.status === 'completed' ? '完成' : '停止'}，不能再用普通命令继续。请点击顶部“继续”直接开启新一轮，或“继续并发送指令”附带一条任务级指令；发现、证据、报告和仍有效的命令会保留，旧轮次表态不参与新轮次。</div>`
  return `${composer}
    <div class="section-head"><div><h3>命令与投递状态</h3><span class="sub">${commands.length} 条 · 最新在前</span></div></div>
    <div class="command-list">${commandsListHtml(detail)}</div>`
}

function commandsListHtml(detail) {
  const commands = array(detail.state.commands).slice().reverse()
  if (commands.length === 0) return `<div class="empty-hint">还没有人工命令。命令与 peer 消息分开保存；投递状态由运行时记录。</div>`
  return commands
    .map((command) => {
      const deliveries = Object.values(command.deliveries ?? {})
      const source = command.source === 'web' ? 'Web UI' : command.source === 'cli' ? 'CLI' : 'API'
      const deliveryHtml =
        deliveries.length === 0
          ? '<span class="sub">保存时没有参与 work；新 work 加入时会收到。</span>'
          : deliveries
              .map((delivery) => {
                const status = delivery.status ?? 'saved'
                return `<div class="delivery-row">
                  <span class="work-id">${esc(delivery.workId)}</span>
                  ${chip(COMMAND_STATUS_TEXT[status] ?? status, COMMAND_STATUS_CHIP[status] ?? 'gray')}
                  ${delivery.attempts > 0 ? `<span class="delivery-meta">尝试 ${esc(delivery.attempts)}</span>` : ''}
                  ${delivery.enqueuedAt ? `<span class="delivery-meta">入队 ${esc(fmtTime(delivery.enqueuedAt))}</span>` : ''}
                  ${delivery.enteredContextAt ? `<span class="delivery-meta">进入上下文 ${esc(fmtTime(delivery.enteredContextAt))}</span>` : ''}
                  ${delivery.note ? `<span class="delivery-meta warn">${esc(delivery.note)}</span>` : ''}
                </div>`
              })
              .join('')
      return `<article class="card command-card">
        <div class="command-head">
          <span class="command-id">${esc(command.id)}</span>
          ${chip(source, 'purple')}
          <span class="spacer"></span>
          <span class="finding-time" title="${esc(fmtTime(command.createdAt))}">${esc(relTime(command.createdAt))}</span>
        </div>
        <div class="command-body">${esc(command.text)}</div>
        <div class="delivery-list">${deliveryHtml}</div>
      </article>`
    })
    .join('')
}

async function sendCommand() {
  const area = $('#command-text')
  if (area === null) return
  const text = area.value.trim()
  if (text.length === 0) {
    toast('命令内容不能为空', 'err')
    area.focus()
    return
  }
  const pending = state.pendingCommand
  const requestId =
    pending !== null && pending.text === text
      ? pending.requestId
      : typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
  state.pendingCommand = { text, requestId }
  state.commandDraft = text
  const button = $('[data-action="send-command"]')
  if (button !== null) button.disabled = true
  try {
    const payload = await api(`/api/tasks/${encodeURIComponent(state.currentId)}/command`, {
      method: 'POST',
      body: { text, requestId },
    })
    const resultText = String(payload.result?.text ?? '命令已保存')
    toast(resultText.split('\n')[0], 'ok')
    state.pendingCommand = null
    state.commandDraft = ''
    area.value = ''
    await loadDetail(state.currentId, { preserveScroll: true })
    await loadTasks()
  } catch (error) {
    // Keep the draft and its request id: retrying the same text is deduplicated.
    toast(error.message, 'err')
  } finally {
    if (button !== null) button.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Consensus rounds
// ---------------------------------------------------------------------------

function roundBlock(round, compact = false) {
  const participants = array(round.participants)
  const opinions = participants
    .map((workId) => {
      const opinion = round.opinions?.[workId]
      return `<div class="opinion">
        <span class="who">${esc(workId)}</span>
        ${chip(opinion === undefined ? '未表态' : OPINION_TEXT[opinion.opinion] ?? opinion.opinion, opinion === undefined ? 'gray' : OPINION_CHIP[opinion.opinion] ?? 'gray')}
        <span class="why">${esc(opinion?.reason ?? '')}</span>
      </div>`
    })
    .join('')
  return `<article class="round ${esc(round.status)}">
    <div class="round-head">
      <span class="round-id">${esc(round.id)}</span>
      ${chip(ROUND_STATUS_TEXT[round.status] ?? round.status, ROUND_STATUS_CHIP[round.status] ?? 'gray')}
      <span class="sub" style="font-size:11px;color:var(--faint)">由 ${esc(round.createdByWorkId)} 发起</span>
      <span class="spacer"></span>
      <span class="finding-time" title="${esc(fmtTime(round.createdAt))}">${esc(relTime(round.createdAt))}</span>
    </div>
    ${compact ? '' : `<p class="round-reason">${esc(round.reason)}</p>`}
    <div class="round-facts">
      <span>目标 <b>v${round.targetVersion}</b></span>
      <span>共享状态 <b>v${round.sharedStateVersion}</b></span>
      <span>参与 <b>${participants.length}</b></span>
      ${round.completedAt === undefined ? '' : `<span>通过于 <b>${esc(fmtTime(round.completedAt))}</b></span>`}
    </div>
    ${opinions.length === 0 ? '<div class="empty-hint">该轮次没有参与 work。</div>' : `<div>${opinions}</div>`}
    ${round.invalidatedReason === undefined ? '' : `<p class="round-reason" style="color:var(--amber);margin-top:8px">失效原因：${esc(round.invalidatedReason)} · ${esc(fmtTime(round.invalidatedAt))}</p>`}
  </article>`
}

function renderRoundsPanel(detail) {
  const stateData = detail.state
  const rounds = array(stateData.rounds).slice().reverse()
  const current = rounds.find((round) => round.id === stateData.currentRoundId) ?? null
  const history = rounds.filter((round) => round.id !== stateData.currentRoundId)
  const completion = stateData.completion
  return `
    ${completion === null ? '' : completionBlock(completion)}
    ${
      current === null
        ? `<div class="empty-hint" style="margin-bottom:12px">当前没有开放的共识轮次。</div>`
        : `<div class="section-head"><div><h3>当前轮次</h3><span class="sub">任一共享状态变化都会使本轮失效并自动重开</span></div></div>
           <div class="round-list" style="margin-bottom:16px">${roundBlock(current)}</div>`
    }
    <div class="section-head"><div><h3>${current === null ? '全部轮次' : '历史轮次'}</h3><span class="sub">${history.length} 轮，最新在前</span></div></div>
    <div class="round-list">${
      history.length === 0
        ? `<div class="empty-hint">${current === null ? '还没有共识轮次。执行者通过 completion_propose 发起。' : '还没有其他共识轮次。'}</div>`
        : history.map((round) => roundBlock(round)).join('')
    }</div>`
}

// ---------------------------------------------------------------------------
// Files and logs
// ---------------------------------------------------------------------------

function renderFilesPanel(detail) {
  const files = array(detail.files)
  const groups = ['doc', 'audit', 'consensus', 'evidence', 'log', 'config']
  const list = groups
    .map((group) => {
      const entries = files.filter((file) => file.group === group)
      if (entries.length === 0) return ''
      return `<div class="file-group"><h4>${esc(FILE_GROUP_TEXT[group] ?? group)}</h4>${entries
        .map(
          (file) => `<button class="file-btn ${state.file?.path === file.path ? 'active' : ''}" type="button" data-action="open-file" data-path="${esc(file.path)}" title="${esc(file.path)}">
            <span class="p">${esc(file.path)}</span><span class="s">${formatBytes(file.size)}</span>
          </button>`,
        )
        .join('')}</div>`
    })
    .join('')
  return `<div class="files-layout">
    <div class="file-list">${list.length === 0 ? '<div class="side-hint">没有可显示的文件。</div>' : list}</div>
    <div class="file-view" id="file-view">${fileViewHtml()}</div>
  </div>`
}

/**
 * Minimal Markdown renderer for task documents (task.md / findings.md /
 * report.md ...). Everything is HTML-escaped first, so the only tags in the
 * output are the ones this function emits. Covers the subset the runtime and
 * the executors actually write: headings, lists, tables, fenced code, quotes,
 * rules and inline emphasis/links.
 */
function markdownHtml(source) {
  const lines = String(source ?? '').split(/\r?\n/)
  const out = []
  let index = 0
  let paragraph = []
  let lists = [] // [{ tag, indent }]

  const inline = (text) => {
    let s = esc(text)
    s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
    )
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>')
    return s
  }
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
    paragraph = []
  }
  const closeLists = (toIndent) => {
    while (lists.length > 0 && lists[lists.length - 1].indent >= toIndent) {
      out.push(`</li></${lists.pop().tag}>`)
    }
  }
  const closeAllLists = () => closeLists(-1)

  const splitRow = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(trimmed)
    if (fence !== null) {
      flushParagraph()
      closeAllLists()
      const body = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      const lang = fence[1].length > 0 ? ` data-lang="${esc(fence[1])}"` : ''
      out.push(`<pre class="md-code"${lang}><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }

    // Blank line
    if (trimmed.length === 0) {
      flushParagraph()
      closeAllLists()
      index += 1
      continue
    }

    // Horizontal rule
    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      flushParagraph()
      closeAllLists()
      out.push('<hr>')
      index += 1
      continue
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flushParagraph()
      closeAllLists()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2].replace(/\s+#+$/, ''))}</h${level}>`)
      index += 1
      continue
    }

    // Table: header row followed by a separator row (`| --- | :--: |`).
    const separator = index + 1 < lines.length ? lines[index + 1].trim() : ''
    if (trimmed.startsWith('|') && /^[\s:|-]+$/.test(separator) && separator.includes('-')) {
      flushParagraph()
      closeAllLists()
      const header = splitRow(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      const head = header.map((cell) => `<th>${inline(cell)}</th>`).join('')
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
        .join('')
      out.push(`<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`)
      continue
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      flushParagraph()
      closeAllLists()
      const quoted = []
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quoted.push(lines[index].trim().replace(/^>\s?/, ''))
        index += 1
      }
      out.push(`<blockquote>${quoted.map(inline).join('<br>')}</blockquote>`)
      continue
    }

    // List item (nested by indentation)
    const item = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (item !== null) {
      flushParagraph()
      const indent = item[1].replace(/\t/g, '  ').length
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul'
      while (lists.length > 0 && lists[lists.length - 1].indent > indent) {
        out.push(`</li></${lists.pop().tag}>`)
      }
      const top = lists[lists.length - 1]
      if (top === undefined || top.indent < indent) {
        lists.push({ tag, indent })
        out.push(`<${tag}><li>${inline(item[3])}`)
      } else {
        out.push(`</li><li>${inline(item[3])}`)
      }
      index += 1
      continue
    }

    // Paragraph text
    closeAllLists()
    paragraph.push(trimmed)
    index += 1
  }

  flushParagraph()
  closeAllLists()
  return out.join('\n')
}

function fileViewHtml() {
  const file = state.file
  if (file === null) {
    return `<div class="empty-hint" style="margin:16px">从左侧选择一个文件。</div>`
  }
  const journal = file.path.endsWith('journal.jsonl')
  const markdown = /\.(md|markdown)$/i.test(file.path)
  return `<div class="file-view-head">
      <span class="p">${esc(file.path)}</span>
      ${chip(formatBytes(file.size), 'gray')}
      ${file.truncated ? chip('已截断', 'amber') : ''}
      <span class="spacer"></span>
      <button class="btn small ghost" type="button" data-action="copy-file">复制</button>
    </div>
    ${journal ? journalHtml(file.text) : markdown ? `<div class="md-body">${markdownHtml(file.text)}</div>` : `<pre>${esc(file.text)}</pre>`}`
}

function journalHtml(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-800)
    .reverse()
  if (lines.length === 0) return `<div class="empty-hint">审计日志为空。</div>`
  return `<div class="journal-list">${lines
    .map((line) => {
      try {
        const parsed = JSON.parse(line)
        const event = parsed.event ?? '?'
        const at = parsed.at ?? ''
        const rest = { ...parsed }
        delete rest.at
        delete rest.event
        return `<details class="journal-row"><summary><span class="ev">${esc(event)}</span><span class="at">${esc(fmtTime(at))}</span></summary><pre>${esc(
          JSON.stringify(rest, null, 2),
        )}</pre></details>`
      } catch {
        return `<pre>${esc(line)}</pre>`
      }
    })
    .join('')}</div>`
}

async function openFile(path, options = {}) {
  if (state.currentId === null || typeof path !== 'string' || path.length === 0) return
  if (state.openingFile && options.force !== true) return
  const requestedTask = state.currentId
  state.openingFile = true
  state.fileLoading = true
  try {
    const payload = await api(
      `/api/tasks/${encodeURIComponent(requestedTask)}/file?path=${encodeURIComponent(path)}`,
    )
    if (state.currentId !== requestedTask) return
    state.file = payload.file
    if (state.tab !== 'files') {
      setTab('files')
    } else if (!refreshFileView() && state.detail !== null) {
      // Panel not on screen yet (or replaced since): fall back to a full render.
      renderActivePanel()
    }
  } catch (error) {
    toast(error.message, 'err')
  } finally {
    state.fileLoading = false
    state.openingFile = false
  }
}

async function copyCurrentFile() {
  if (state.file === null) return
  try {
    await navigator.clipboard.writeText(state.file.text)
    toast('文件内容已复制', 'ok')
  } catch {
    const area = document.createElement('textarea')
    area.value = state.file.text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    toast('文件内容已复制', 'ok')
  }
}

// ---------------------------------------------------------------------------
// Modals and actions
// ---------------------------------------------------------------------------

function openModal({ title, bodyHtml, confirmText = '确定', confirmClass = 'primary', onConfirm }) {
  closeConversationModal()
  const root = $('#modal-root')
  root.innerHTML = `<div class="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" type="button" data-modal-close aria-label="关闭">×</button></div>
      <div class="modal-body">${bodyHtml}<div class="modal-error" data-modal-error></div></div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-modal-close>取消</button>
        <button class="btn ${confirmClass}" type="button" data-modal-confirm>${esc(confirmText)}</button>
      </div>
    </div>
  </div>`
  const backdrop = root.firstElementChild
  const modal = backdrop.querySelector('.modal')
  const errorEl = modal.querySelector('[data-modal-error]')
  const confirmBtn = modal.querySelector('[data-modal-confirm]')
  const close = () => {
    document.removeEventListener('keydown', onKey)
    root.innerHTML = ''
  }
  const onKey = (event) => {
    if (event.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close()
  })
  for (const button of modal.querySelectorAll('[data-modal-close]')) button.addEventListener('click', close)
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true
    errorEl.textContent = ''
    try {
      const keepOpen = await onConfirm(modal)
      if (keepOpen !== false) close()
    } catch (error) {
      errorEl.textContent = error.message ?? String(error)
    } finally {
      confirmBtn.disabled = false
    }
  })
  const first = modal.querySelector('textarea, input')
  if (first !== null) first.focus()
  return { close, modal }
}

function openNewTaskModal() {
  openModal({
    title: '新建任务',
    confirmText: '创建任务',
    bodyHtml: `
      <div class="field"><span>起始信息 <span class="hint">执行者最初的已知条件</span></span>
        <textarea id="new-start" placeholder="例如：目标站点为 …，已知入口 …，没有凭据。"></textarea></div>
      <div class="field"><span>终点信息 <span class="hint">全体参与 work 需要判断是否达成</span></span>
        <textarea id="new-end" placeholder="例如：取得管理员权限，并把可复现证据写入任务目录。"></textarea></div>
      <div class="field-row">
        <label class="field"><span>任务 ID（可选）</span><input id="new-id" placeholder="留空自动生成，如 T-20261021-193000-abcd"></label>
        <div class="field"><span>启动</span><label class="radio-line"><input type="checkbox" id="new-auto-start" checked> 创建后立即启动运行时</label>
          <span class="hint">启动会调用真实模型并消耗 API 额度。</span></div>
      </div>
      <div class="modal-note">执行者拥有 danger-full-access 本地工具权限，请确认运行环境已隔离。</div>`,
    onConfirm: async (modal) => {
      const start = modal.querySelector('#new-start').value.trim()
      const end = modal.querySelector('#new-end').value.trim()
      const id = modal.querySelector('#new-id').value.trim()
      const autoStart = modal.querySelector('#new-auto-start').checked
      if (start.length === 0 || end.length === 0) throw new Error('起始信息和终点信息都不能为空')
      const payload = await api('/api/tasks', {
        method: 'POST',
        body: { start, end, ...(id.length > 0 ? { id } : {}), autoStart },
      })
      toast(`任务 ${payload.taskId} 已创建`, 'ok')
      if (payload.startError !== undefined) toast(`已创建，但启动失败：${payload.startError}`, 'err')
      else if (payload.pid !== undefined) toast(`运行时已就绪（pid ${payload.pid}）`, 'ok')
      await loadTasks()
      await selectTask(payload.taskId, { updateHash: true })
    },
  })
}

function openInfoModal(kind) {
  const detail = state.detail
  if (detail === null) return
  const isEnd = kind === 'end'
  const current = isEnd ? detail.state.endInformation : detail.state.startInformation
  openModal({
    title: isEnd ? '修改终点信息' : '修改起始信息',
    confirmText: '保存',
    bodyHtml: `<div class="field"><span>${isEnd ? '终点信息' : '起始信息'} <span class="hint">运行中修改会使当前共识轮次失效并重新征询</span></span>
        <textarea id="info-text" style="min-height:220px">${esc(current)}</textarea></div>
      <div class="modal-note">当前${isEnd ? '目标' : '起始'}版本：v${isEnd ? detail.state.targetVersion : array(detail.state.startHistory).at(-1)?.version ?? 1}</div>`,
    onConfirm: async (modal) => {
      const text = modal.querySelector('#info-text').value
      if (text.trim().length === 0) throw new Error('内容不能为空')
      const payload = await api(`/api/tasks/${encodeURIComponent(state.currentId)}/${isEnd ? 'end-info' : 'start-info'}`, {
        method: 'POST',
        body: { text },
      })
      toast(payload.result.text, 'ok')
      await loadDetail(state.currentId, { preserveScroll: true })
      await loadTasks()
    },
  })
}

function openStopModal() {
  openModal({
    title: '停止任务',
    confirmText: '停止任务',
    confirmClass: 'danger',
    bodyHtml: `<div class="modal-note">停止会把任务记录为 <b>stopped</b>，而不是 completed。运行中的执行者会被停止；之后可以再次启动恢复会话，但停止本身不代表终点已达成。</div>
      <div class="field"><span>停止原因</span><input id="stop-reason" value="Web UI 手动停止"></div>`,
    onConfirm: async (modal) => {
      const reason = modal.querySelector('#stop-reason').value.trim() || 'Web UI 手动停止'
      const payload = await api(`/api/tasks/${encodeURIComponent(state.currentId)}/stop`, {
        method: 'POST',
        body: { reason },
      })
      toast(payload.result.text, 'ok')
      await loadDetail(state.currentId, { preserveScroll: true })
      await loadTasks()
    },
  })
}

async function runTask() {
  const payload = await api(`/api/tasks/${encodeURIComponent(state.currentId)}/run`, { method: 'POST' })
  toast(`运行时已就绪（pid ${payload.pid}），可查看执行者状态`, 'ok')
  setTimeout(() => {
    void loadDetail(state.currentId, { preserveScroll: true })
    void loadTasks()
  }, 1200)
}

function newRequestId(prefix) {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function openContinueModal() {
  const detail = state.detail
  if (detail === null) return
  const summary = detail.summary
  const ended = summary.status === 'completed' ? '已完成' : '已停止'
  openModal({
    title: '继续并发送指令',
    confirmText: '开启新一轮',
    bodyHtml: `<div class="modal-note">任务${ended}。继续会在同一个任务 ID 下开启新的运行轮次：保留发现、证据、当前报告和仍有效的用户要求；上一轮的终态、完成记录和表态不会被修改，也不参与新轮次的完成判定。这条文本会作为任务级命令交给本轮执行者。只想让任务自己接着跑、不需要附加指令时，直接点顶部的“继续”。</div>
      <div class="field"><span>新的指令 <span class="hint">必填</span></span>
        <textarea id="continue-text" style="min-height:180px" placeholder="例如：基于现有报告补充利用链验证，并给出可复现证据。"></textarea></div>
      <div class="modal-note">当前 ${esc(summary.runId ?? '')}（累计 ${summary.runCount ?? 1} 轮），目标版本 v${summary.targetVersion}；继续本身不修改终点版本。</div>`,
    onConfirm: async (modal) => {
      const text = modal.querySelector('#continue-text').value.trim()
      if (text.length === 0) throw new Error('继续指令不能为空')
      const pending = state.pendingContinue
      const requestId =
        pending !== null && pending.text === text ? pending.requestId : newRequestId('continue')
      state.pendingContinue = { text, requestId }
      const payload = await api(`/api/tasks/${encodeURIComponent(state.currentId)}/continue`, {
        method: 'POST',
        body: { text, requestId },
      })
      const result = payload.result ?? {}
      toast(String(result.text ?? '已开启新一轮').split('\n')[0], 'ok')
      if (result.startError !== undefined) toast(`新一轮已提交，但启动失败：${result.startError}`, 'err')
      state.pendingContinue = null
      await loadDetail(state.currentId, { preserveScroll: true })
      await loadTasks()
    },
  })
}

async function recoverTask() {
  const payload = await api(`/api/tasks/${encodeURIComponent(state.currentId)}/recover`, {
    method: 'POST',
    body: { requestId: newRequestId('recover') },
  })
  const result = payload.result ?? {}
  toast(String(result.text ?? '恢复请求已提交').split('\n')[0], 'ok')
  if (result.startError !== undefined) toast(`承接 work 已创建，但启动失败：${result.startError}`, 'err')
  await loadDetail(state.currentId, { preserveScroll: true })
  await loadTasks()
}

/** Restart a stopped task without inventing a command for the executor. */
async function resumeTask() {
  const payload = await api(`/api/tasks/${encodeURIComponent(state.currentId)}/resume`, {
    method: 'POST',
    body: { requestId: newRequestId('resume') },
  })
  const result = payload.result ?? {}
  toast(String(result.text ?? '任务已重启').split('\n')[0], 'ok')
  if (result.startError !== undefined) toast(`新一轮已提交，但启动失败：${result.startError}`, 'err')
  await loadDetail(state.currentId, { preserveScroll: true })
  await loadTasks()
}

async function jumpToFinding(id) {
  state.filters.findings = { q: '', type: '', author: '', history: true }
  setTab('findings')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const target = document.getElementById(`finding-${id}`)
  if (target === null) {
    toast(`当前视图找不到 ${id}`, 'err')
    return
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target.style.outline = '2px solid var(--accent)'
  setTimeout(() => {
    target.style.outline = ''
  }, 1600)
}

function filterByWork(workId) {
  state.filters.findings = { q: workId, type: '', author: '', history: false }
  setTab('findings')
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]')
  if (target === null) return
  const action = target.dataset.action
  if (action === 'select-task') {
    void selectTask(target.dataset.id)
    return
  }
  if (state.currentId === null && !['new-task', 'refresh'].includes(action)) return
  try {
    switch (action) {
      case 'new-task':
        openNewTaskModal()
        break
      case 'refresh':
        void refreshAll()
        break
      case 'run':
        void runTask().catch((error) => toast(error.message, 'err'))
        break
      case 'continue':
        openContinueModal()
        break
      case 'resume':
        void resumeTask().catch((error) => toast(error.message, 'err'))
        break
      case 'recover':
        void recoverTask().catch((error) => toast(error.message, 'err'))
        break
      case 'stop':
        openStopModal()
        break
      case 'edit-end':
        openInfoModal('end')
        break
      case 'edit-start':
        openInfoModal('start')
        break
      case 'send-command':
        void sendCommand()
        break
      case 'open-file':
        void openFile(target.dataset.path)
        break
      case 'open-conversation':
        openConversation(target.dataset.work)
        break
      case 'copy-file':
        void copyCurrentFile()
        break
      case 'jump-finding':
        void jumpToFinding(target.dataset.id)
        break
      case 'filter-work':
        filterByWork(target.dataset.id)
        break
    }
  } catch (error) {
    toast(error.message, 'err')
  }
})

$('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]')
  if (button !== null) setTab(button.dataset.tab)
})

$('#task-search').addEventListener('input', renderTaskList)
$('#new-task').addEventListener('click', openNewTaskModal)
$('#empty-new-task').addEventListener('click', openNewTaskModal)
$('#dashboard-new-task').addEventListener('click', openNewTaskModal)
$('#workspace-home').addEventListener('click', showDashboard)
$('#dashboard-search').addEventListener('input', renderDashboard)
$('#dashboard-tasks').addEventListener('click', (event) => {
  if (event.target.closest('[data-dashboard-create]')) openNewTaskModal()
})
$('#status-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-status]')
  if (!button) return
  state.dashboardStatus = button.dataset.status
  for (const item of $$('#status-filters button')) {
    item.classList.toggle('active', item === button)
    item.setAttribute('aria-pressed', String(item === button))
  }
  renderDashboard()
})

$('#panels').addEventListener('input', (event) => {
  if (state.detail === null) return
  const target = event.target
  if (target.id === 'finding-q') {
    state.filters.findings.q = target.value
    renderFindingListOnly()
  } else if (target.id === 'message-q') {
    state.filters.messages.q = target.value
    renderMessageListOnly()
  }
})

$('#panels').addEventListener('change', (event) => {
  if (state.detail === null) return
  const target = event.target
  if (target.id === 'finding-type') {
    state.filters.findings.type = target.value
    renderFindingListOnly()
  } else if (target.id === 'finding-author') {
    state.filters.findings.author = target.value
    renderFindingListOnly()
  } else if (target.id === 'finding-history') {
    state.filters.findings.history = target.checked
    renderFindingListOnly()
  } else if (target.id === 'message-kind') {
    state.filters.messages.kind = target.value
    renderMessageListOnly()
  } else if (target.id === 'message-status') {
    state.filters.messages.status = target.value
    renderMessageListOnly()
  } else if (target.id === 'message-system') {
    state.filters.messages.system = target.checked
    renderMessageListOnly()
  } else if (target.id === 'show-exited') {
    state.filters.showExited = target.checked
    const works = Object.values(state.detail.state.works)
    const active = works.filter((work) => work.runtimeStatus !== 'exited' && work.runtimeStatus !== 'finished')
    const exited = works.filter((work) => work.runtimeStatus === 'exited' || work.runtimeStatus === 'finished')
    const list = $('#works-list')
    if (list !== null) list.innerHTML = worksListHtml(active, exited)
  }
})

function renderFindingListOnly() {
  const detail = state.detail
  if (detail === null || state.tab !== 'findings') return
  const list = $('#finding-list')
  const count = $('#finding-count')
  if (list !== null) list.innerHTML = findingsListHtml(detail)
  if (count !== null) count.textContent = `${filteredFindings(detail).length} / ${findingView(array(detail.state.findings)).length} 条`
}

function renderMessageListOnly() {
  const detail = state.detail
  if (detail === null || state.tab !== 'messages') return
  const list = $('#message-list')
  const count = $('#message-count')
  if (list !== null) list.innerHTML = messagesListHtml(detail)
  if (count !== null) count.textContent = `${filteredMessages(detail).length} / ${array(detail.state.messages).length} 条`
}

// Keep the command composer draft across panel re-renders.
document.addEventListener('input', (event) => {
  const target = event.target
  if (target instanceof HTMLTextAreaElement && target.id === 'command-text') {
    state.commandDraft = target.value
  }
})

// Re-render deferred panels once the user leaves a filter field.
document.addEventListener(
  'focusout',
  () => {
    if (!state.pendingPanelRender) return
    setTimeout(() => {
      if (!state.pendingPanelRender || isEditingInPanel()) return
      state.pendingPanelRender = false
      renderActivePanel()
    }, 0)
  },
  true,
)

// Keep the top-level task list fresh even when no detail stream is open.
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  void loadTasks().catch(() => undefined)
}, 8_000)

setInterval(() => {
  if (document.visibilityState !== 'visible' || state.currentId === null) return
  if (state.stream !== null && state.stream.readyState === EventSource.OPEN) return
  void loadDetail(state.currentId, { preserveScroll: true })
}, 5_000)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    pauseConversationRefresh()
    return
  }
  resumeConversationRefresh()
  void loadTasks().catch(() => undefined)
  if (state.currentId !== null) void loadDetail(state.currentId, { preserveScroll: true })
})

window.addEventListener('hashchange', () => {
  const taskId = decodeURIComponent(location.hash.slice(1))
  if (taskId.length === 0) { showDashboard(); return }
  if (taskId.length > 0 && taskId !== state.currentId) void selectTask(taskId, { updateHash: false })
})

async function refreshAll() {
  try {
    await loadTasks()
    if (state.currentId !== null) await loadDetail(state.currentId, { preserveScroll: true })
    toast('已刷新', 'ok')
  } catch (error) {
    toast(error.message, 'err')
  }
}

async function init() {
  try {
    await loadSession()
    await loadTasks()
    const fromHash = decodeURIComponent(location.hash.slice(1))
    const initial =
      fromHash.length > 0 && state.tasks.some((task) => task.taskId === fromHash)
        ? fromHash
        : undefined
    if (initial !== undefined) {
      await selectTask(initial, { updateHash: true })
    } else {
      setConn('ok', '已连接')
    }
  } catch (error) {
    setConn('bad', '连接失败')
    $('#dashboard-tasks').innerHTML = '<div class="directory-empty"><h3>暂时无法加载工作空间</h3><p>请检查服务连接，然后点击刷新重试。</p></div>'
    toast(`加载失败：${error.message}`, 'err')
  }
}

void init()
