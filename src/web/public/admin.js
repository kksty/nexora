/* Web UI administration helpers: API settings and task deletion. */
const $ = (selector) => document.querySelector(selector)
const adminHooks = globalThis.__nexoraAdminHooks ?? {}
const adminTestHooks = { fetch: null }
const API_PROTOCOLS = [
  ['deepseek', 'DeepSeek API'],
  ['openai-compatible', 'OpenAI-compatible'],
]
const THINKING_ADAPTERS = [
  ['auto', '自动（由服务端能力判断）'],
  ['dashscope', '阿里云 DashScope'],
  ['vllm', '本地 vLLM'],
  ['none', '不发送思考参数'],
]
const CONTEXT_PRESETS = [32_000, 64_000, 128_000]
const UNKNOWN_CONTEXT_WINDOW = 32_768

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}

function toast(message, type) {
  const root = $('#toast-root')
  if (root === null) return
  const el = document.createElement('div')
  el.className = 'toast ' + (type || 'info')
  el.textContent = String(message)
  root.append(el)
  setTimeout(() => el.remove(), 4800)
}

async function api(path, options) {
  const settings = options || {}
  const method = settings.method || 'GET'
  const headers = { accept: 'application/json' }
  if (settings.body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') headers['x-liebian-web'] = '1'
  const response = await (adminTestHooks.fetch ?? fetch)(path, {
    method,
    headers,
    body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    // empty/non-JSON
  }
  if (!response.ok || payload === null || payload.ok !== true) {
    throw new Error(payload && payload.error ? payload.error.message : '请求失败（HTTP ' + response.status + '）')
  }
  return payload
}

function sourceLabel(source) {
  return ({
    saved: '已保存',
    environment: '环境变量',
    default: '默认值',
    none: '未配置',
    fallback: '假设回退',
  })[source] || ''
}

function sourceHint(source, text) {
  const label = sourceLabel(source)
  if (label.length === 0) return ''
  return '<span class="hint" data-source="' + esc(source) + '">' + esc(label) + (text ? '：' + esc(text) : '') + '</span>'
}

function selectOptions(options, selected) {
  return options
    .map(([value, label]) => '<option value="' + esc(value) + '"' + (selected === value ? ' selected' : '') + '>' + esc(label) + '</option>')
    .join('')
}

function effectiveHint(known, fallback) {
  if (known === true) return '<span class="hint">effective</span>'
  if (fallback === true) return '<span class="hint">fallback / unknown</span>'
  return ''
}

function legacyNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function optionalBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function legacyChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/** Return normalized budget values, or null when the modal inputs are invalid. */
function readBudgetInputs(modal) {
  const modelMaxTokens = Number(modal.querySelector('#settings-model-max-tokens').value)
  const rawContextWindow = modal.querySelector('#settings-model-context-window').value
  const modelContextWindow = rawContextWindow === '' ? 0 : Number(rawContextWindow)
  const ratioPercent = Number(modal.querySelector('#settings-model-auto-compact-ratio').value)
  const modelSafetyMarginTokens = Number(modal.querySelector('#settings-model-safety-margin-tokens').value)
  if (!Number.isInteger(modelMaxTokens) || modelMaxTokens < 1) return null
  if (!Number.isInteger(modelContextWindow) || modelContextWindow < 0) return null
  if (!Number.isFinite(ratioPercent) || ratioPercent < 50 || ratioPercent > 90) return null
  if (!Number.isInteger(modelSafetyMarginTokens) || modelSafetyMarginTokens < 0) return null
  return {
    modelMaxTokens,
    modelContextWindow,
    modelAutoCompactRatio: ratioPercent / 100,
    modelSafetyMarginTokens,
    ratioPercent,
  }
}

function budgetView(budget, options) {
  const modelApiProtocol = options?.modelApiProtocol || 'deepseek'
  const contextKnown = budget.modelContextWindow > 0
  const effectiveContextWindow = contextKnown ? budget.modelContextWindow : UNKNOWN_CONTEXT_WINDOW
  const fixed = budget.modelMaxTokens + budget.modelSafetyMarginTokens
  if (fixed >= effectiveContextWindow) {
    const fallbackNote = contextKnown
      ? ''
      : '上下文窗口未知，仅将 32,768 tokens 作为假设回退；这不代表服务端实际支持至少 32K。Ollama 等服务可能更低，请确认服务端窗口。'
    const legacyDeepSeekWarning =
      !contextKnown && modelApiProtocol === 'deepseek'
        ? '\n旧版 DeepSeek 配置兼容：当前输出与安全余量超过回退值，保存不会被静默改写；请确认服务端窗口后调整。'
        : ''
    const error =
      !contextKnown && modelApiProtocol !== 'deepseek'
        ? 'OpenAI-compatible 在上下文未知时无法使用当前输出预算和安全余量。请减小输出预算或填写已确认的上下文。'
        : ''
    return {
      safeInput: 0,
      compactAt: 0,
      text:
        (fallbackNote.length > 0 ? fallbackNote : '') +
        '输出预算与安全余量已达到或超过有效上下文窗口，无法保留安全的输入空间。' +
        legacyDeepSeekWarning,
      error:
        error.length > 0
          ? error
          : contextKnown
            ? '单次输出预算加安全余量必须小于已知上下文窗口（输入与输出共用总量）'
            : '',
    }
  }
  const safeInput = effectiveContextWindow - fixed
  const compactAt = Math.floor(effectiveContextWindow * budget.modelAutoCompactRatio)
  const contextLabel = contextKnown
    ? '已知窗口 ' + budget.modelContextWindow.toLocaleString('zh-CN') + ' tokens'
    : '窗口未知 · 假设回退 ' +
      UNKNOWN_CONTEXT_WINDOW.toLocaleString('zh-CN') +
      ' tokens（非模型能力声明；服务端窗口可能更低，请确认）'
  return {
    safeInput,
    compactAt,
    text:
      contextLabel +
      ' · 安全输入预算 ' +
      safeInput.toLocaleString('zh-CN') +
      ' tokens（C－O－M） · 压缩触发参考 ' +
      compactAt.toLocaleString('zh-CN') +
      ' tokens（C×' +
      Math.round(budget.modelAutoCompactRatio * 100) +
      '%）；以服务实际压缩语义为准。',
    error: '',
  }
}

function updateBudgetPreview(modal, errorEl) {
  const preview = modal.querySelector('[data-budget-preview]')
  if (preview === null) return
  const budget = readBudgetInputs(modal)
  if (budget === null) {
    preview.className = 'budget-preview err'
    preview.textContent = '请输入有效的输出预算、上下文窗口、压缩百分比和安全余量。'
    return
  }
  const view = budgetView(budget, {
    modelApiProtocol: modal.querySelector('#settings-model-api-protocol').value,
  })
  preview.className = 'budget-preview' + (view.error.length > 0 ? ' err' : '')
  preview.textContent = view.text
  if (errorEl !== undefined && errorEl.textContent === view.error) errorEl.textContent = ''
}

function openSettingsModal(settings) {
  const root = $('#modal-root')
  let modal = null
  const context = {
    closed: false,
    controller: null,
    controllerOwner: null,
    modelGeneration: 0,
    testGeneration: 0,
    modelPending: false,
    testPending: false,
    savePending: false,
    resetPending: false,
  }
  const isCurrent = () => !context.closed && modal !== null && root.querySelector('.modal') === modal
  const closeModal = () => {
    if (context.closed) return
    context.closed = true
    context.controller?.abort()
    context.controller = null
    context.controllerOwner = null
    context.modelGeneration += 1
    document.removeEventListener('keydown', onKey)
    if (modal !== null && root.querySelector('.modal') === modal) root.innerHTML = ''
  }
  const onKey = (event) => {
    if (event.key === 'Escape') closeModal()
  }
  document.dispatchEvent(new Event('nexora:modal-before-replace'))
  document.addEventListener('keydown', onKey)
  const sources = settings.sources || {}
  const keyHint = settings.apiKeySet
    ? '已配置，来源：' + sourceLabel(settings.apiKeySource)
    : '未配置；自建服务无鉴权时可留空'
  const keyPlaceholder = settings.apiKeySet ? '已配置，留空保持' : '可留空（云端服务通常需要 Key）'
  const basePlaceholder = settings.baseUrl || 'https://api.example.com/v1'
  const overrideNote = settings.savedOverride
    ? '当前使用已保存的配置，它会覆盖环境变量。'
    : '当前配置来自环境变量；保存后将以这里的设置为准。'
  // New fields are optional on the read side so an older backend or saved
  // configuration can still open the modal and retain its existing choices.
  const modelApiProtocol = legacyChoice(settings.modelApiProtocol, ['deepseek', 'openai-compatible'], 'deepseek')
  const modelContextWindow = legacyNumber(settings.modelContextWindow, 0)
  const rawAutoCompactRatio = legacyNumber(settings.modelAutoCompactRatio, 0.75)
  const modelAutoCompactRatio = rawAutoCompactRatio >= 0.5 && rawAutoCompactRatio <= 0.9 ? rawAutoCompactRatio : 0.75
  const modelSafetyMarginTokens = legacyNumber(settings.modelSafetyMarginTokens, 2048)
  const modelThinkingAdapter = legacyChoice(settings.modelThinkingAdapter, ['auto', 'dashscope', 'vllm', 'none'], 'auto')
  const contextWindowKnown = optionalBoolean(settings.contextWindowKnown, modelContextWindow > 0)
  const contextWindowFallback = optionalBoolean(settings.contextWindowFallback, !contextWindowKnown)
  const contextWindowSource = settings.contextWindowSource || (modelContextWindow > 0 ? sources.modelContextWindow : 'fallback')
  const contextWindowHint = contextWindowKnown
    ? ''
    : contextWindowFallback
      ? '未知，预算暂按保守的 32,768 tokens 回退'
      : '未知，无法计算可靠预算'
  root.innerHTML =
    '<div class="modal-backdrop">' +
    '<div class="modal" role="dialog" aria-modal="true" aria-label="API 配置">' +
    '<div class="modal-head"><h3>API 配置</h3><button class="modal-close" type="button" data-close aria-label="关闭">×</button></div>' +
    '<div class="modal-body">' +
    '<div class="modal-note" data-override-note>' + esc(overrideNote) + '</div>' +
    '<div class="field"><span>API Key <span class="hint">' + esc(keyHint) + '</span></span>' +
    '<input id="settings-api-key" type="password" autocomplete="new-password" placeholder="' + esc(keyPlaceholder) + '">' +
    '<small class="field-help">DeepSeek API 必须有 Key；OpenAI-compatible 自建服务无鉴权时可留空。旧 DEEPSEEK_API_KEY 只用于官方端点。</small></div>' +
    '<div class="field-row">' +
    '<label class="field"><span>Provider ' + sourceHint(sources.provider) + '</span><input id="settings-provider" value="' + esc(settings.provider) + '" placeholder="deepseek-official"></label>' +
    '<label class="field"><span>模型 ID ' + sourceHint(sources.model) + '</span><input id="settings-model" list="settings-model-options" autocomplete="off" value="' + esc(settings.model) + '" placeholder="输入服务实际提供的任意 model id"><small class="field-help">名称只用于请求；不会根据名称猜测上下文窗口。</small></label>' +
    '</div>' +
    '<datalist id="settings-model-options"></datalist>' +
    '<label class="field"><span>API 协议 ' + sourceHint(sources.modelApiProtocol || 'default') + effectiveHint(optionalBoolean(settings.modelApiProtocolKnown, true), optionalBoolean(settings.modelApiProtocolFallback, false)) + '</span>' +
    '<select id="settings-model-api-protocol">' + selectOptions(API_PROTOCOLS, modelApiProtocol) + '</select>' +
    '<small class="field-help">自建服务优先选 OpenAI-compatible；可无 API Key。切换协议不会生成或改写 Base URL。</small></label>' +
    '<div class="test-row"><button class="btn small ghost" type="button" data-load-models>获取模型列表</button>' +
    '<span class="test-hint">从当前协议和 Base URL 读取；列表接口不可用时仍可直接填写模型 ID。</span></div>' +
    '<div class="model-list" data-model-list hidden></div>' +
    '<div class="modal-note">模型列表通常只返回 ID，不返回上下文容量；请按服务配置手动填写窗口。</div>' +
    '<label class="field"><span>Base URL（可选）' + sourceHint(sources.baseUrl) + '</span><input id="settings-base-url" value="' + esc(settings.baseUrl) + '" placeholder="' + esc(basePlaceholder) + '"><small class="field-help">模型列表不一定返回上下文容量，请以服务配置为准。</small></label>' +
    '<label class="field"><span>模型请求并发数 <span class="hint">整个任务合计；自建服务建议从 1–2 开始，默认 2</span></span>' +
    '<input id="settings-model-concurrency" type="number" min="1" step="1" value="' + esc(String(settings.modelConcurrency)) + '">' +
    '<small class="field-help">自建服务先低并发试运行；已有配置不会被自动改写。</small></label>' +
    '<label class="field"><span>单次响应输出预算 ' + sourceHint(sources.modelMaxTokens) + '<span class="hint">默认 6144；不会被窗口预设自动改写</span></span>' +
    '<input id="settings-model-max-tokens" type="number" min="1" step="1" value="' + esc(String(settings.modelMaxTokens)) + '"></label>' +
    '<div class="field"><span>上下文窗口 ' + sourceHint(contextWindowSource) + effectiveHint(contextWindowKnown, contextWindowFallback) + '<span class="hint">输入与输出共用总量；' + esc(contextWindowHint) + '</span></span>' +
    '<div class="input-with-presets"><input id="settings-model-context-window" type="number" min="0" step="1" value="' + esc(String(modelContextWindow)) + '" inputmode="numeric">' +
    CONTEXT_PRESETS.map((tokens) => '<button class="btn small ghost" type="button" data-context-preset="' + tokens + '">' + tokens / 1000 + 'K</button>').join('') +
    '</div><small class="field-help">留空或 0 表示未知，保存时仍发送 0。Web 设置只控制客户端预算，不会修改 vLLM --max-model-len 或 Ollama num_ctx。建议先 32K、输出 4K/8K、并发 1–2；确认服务上限与显存后再考虑 64K/128K。</small></div>' +
    '<div class="field-row">' +
    '<label class="field"><span>自动压缩阈值 ' + sourceHint(sources.modelAutoCompactRatio) + effectiveHint(optionalBoolean(settings.modelAutoCompactRatioKnown, true), optionalBoolean(settings.modelAutoCompactRatioFallback, false)) + '</span><div class="input-with-suffix"><input id="settings-model-auto-compact-ratio" type="number" min="50" max="90" step="1" value="' + esc(String(Math.round(modelAutoCompactRatio * 100))) + '" inputmode="decimal"><span>%</span></div><small class="field-help">上下文窗口的 50%–90%，默认 75%。</small></label>' +
    '<label class="field"><span>安全余量 ' + sourceHint(sources.modelSafetyMarginTokens) + effectiveHint(optionalBoolean(settings.modelSafetyMarginTokensKnown, true), optionalBoolean(settings.modelSafetyMarginTokensFallback, false)) + '</span><input id="settings-model-safety-margin-tokens" type="number" min="0" step="1" value="' + esc(String(modelSafetyMarginTokens)) + '" inputmode="numeric"><small class="field-help">tokens，默认 2048；与输出预算共同从窗口扣除。</small></label>' +
    '</div>' +
    '<div class="budget-preview" data-budget-preview aria-live="polite"></div>' +
    '<div class="field-row">' +
    '<label class="field"><span>思考强度 ' + sourceHint(sources.modelThinking) + '<span class="hint">并非所有模型都支持</span></span>' +
    '<select id="settings-model-thinking">' +
    [['off', '关'], ['low', '低'], ['high', '高（默认）'], ['max', '最高']]
      .map(([value, label]) => '<option value="' + value + '"' + (settings.modelThinking === value ? ' selected' : '') + '>' + label + '</option>')
      .join('') +
    '</select></label>' +
    '<label class="field"><span>思考参数适配 ' + sourceHint(sources.modelThinkingAdapter || 'default') + effectiveHint(optionalBoolean(settings.modelThinkingAdapterKnown, true), optionalBoolean(settings.modelThinkingAdapterFallback, false)) + '</span><select id="settings-model-thinking-adapter">' +
    selectOptions(THINKING_ADAPTERS, modelThinkingAdapter) +
    '</select><small class="field-help">DashScope 与 vLLM 使用不同的厂商字段；auto 未识别、generic 与 none 均不发送厂商思考字段。Ollama 请用 none/auto，由服务端默认决定。</small></label>' +
    '</div>' +
    '<label class="radio-line"><input type="checkbox" id="settings-clear-key" ' + (settings.apiKeySet ? '' : 'disabled') + '> 清除 API Key（保存后不再使用任何 Key，包括环境变量里的）</label>' +
    '<div class="test-row"><button class="btn small ghost" type="button" data-test-model>检测模型</button>' +
    '<span class="test-hint">用当前填写的内容发一次最小请求，不保存配置。</span></div>' +
    '<div class="modal-test" data-test-result hidden></div>' +
    '<div class="modal-error" data-error></div>' +
    '<div class="modal-note">保存后用于之后启动的任务；设置对新启动运行时生效，已在运行的运行时不会被改写。自动压缩只在服务端能力已知时可靠；未提供能力时以 0 保留未知。API Key 不会回显。' +
    (settings.savedOverride ? ' <button class="btn small ghost" type="button" data-reset>回退到环境变量</button>' : '') +
    '</div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn ghost" type="button" data-close>取消</button>' +
    '<button class="btn primary" type="button" data-save>保存</button></div>' +
    '</div></div>'
  modal = root.querySelector('.modal')
  const errorEl = modal.querySelector('[data-error]')
  for (const button of modal.querySelectorAll('[data-close]')) button.addEventListener('click', closeModal)
  root.querySelector('.modal-backdrop').addEventListener('mousedown', (event) => {
    if (event.target === root.querySelector('.modal-backdrop')) closeModal()
  })
  const resetButton = modal.querySelector('[data-reset]')
  if (resetButton !== null) {
    resetButton.addEventListener('click', async () => {
      if (context.resetPending || context.savePending) return
      context.resetPending = true
      resetButton.disabled = true
      errorEl.textContent = ''
      try {
        await api('/api/settings', { method: 'DELETE' })
        if (!isCurrent()) return
        toast('已回退到环境变量配置', 'ok')
        closeModal()
      } catch (error) {
        if (!isCurrent()) return
        errorEl.textContent = error.message || String(error)
      } finally {
        context.resetPending = false
        resetButton.disabled = false
      }
    })
  }
  const budgetFields = [
    modal.querySelector('#settings-model-max-tokens'),
    modal.querySelector('#settings-model-context-window'),
    modal.querySelector('#settings-model-auto-compact-ratio'),
    modal.querySelector('#settings-model-safety-margin-tokens'),
  ]
  const updatePreview = () => updateBudgetPreview(modal, errorEl)
  for (const field of budgetFields) field.addEventListener('input', updatePreview)
  for (const preset of modal.querySelectorAll('[data-context-preset]')) {
    preset.addEventListener('click', () => {
      const contextInput = modal.querySelector('#settings-model-context-window')
      contextInput.value = preset.dataset.contextPreset
      updatePreview()
    })
  }
  updatePreview()
  modal.querySelector('[data-save]').addEventListener('click', async () => {
    const save = modal.querySelector('[data-save]')
    if (context.savePending || context.resetPending) return
    context.savePending = true
    save.disabled = true
    errorEl.textContent = ''
    try {
      const clearApiKey = modal.querySelector('#settings-clear-key').checked
      const apiKey = modal.querySelector('#settings-api-key').value.trim()
      const modelConcurrency = Number(modal.querySelector('#settings-model-concurrency').value)
      if (!Number.isInteger(modelConcurrency) || modelConcurrency < 1) {
        throw new Error('模型请求并发数必须是正整数')
      }
      const budget = readBudgetInputs(modal)
      if (budget === null) throw new Error('输出预算、上下文窗口或压缩参数无效')
      const modelApiProtocol = modal.querySelector('#settings-model-api-protocol').value
      const budgetSummary = budgetView(budget, { modelApiProtocol })
      if (budgetSummary.error.length > 0) throw new Error(budgetSummary.error)
      const rawProvider = modal.querySelector('#settings-provider').value.trim()
      const rawBaseUrl = modal.querySelector('#settings-base-url').value.trim()
      const provider =
        modelApiProtocol === 'openai-compatible' && rawProvider === 'deepseek-official' && rawBaseUrl.length === 0
          ? 'openai-compatible'
          : rawProvider
      const body = {
        provider,
        model: modal.querySelector('#settings-model').value.trim(),
        baseUrl: rawBaseUrl,
        modelConcurrency,
        modelMaxTokens: budget.modelMaxTokens,
        modelThinking: modal.querySelector('#settings-model-thinking').value,
        modelApiProtocol,
        modelContextWindow: budget.modelContextWindow,
        modelAutoCompactRatio: budget.modelAutoCompactRatio,
        modelSafetyMarginTokens: budget.modelSafetyMarginTokens,
        modelThinkingAdapter: modal.querySelector('#settings-model-thinking-adapter').value,
        clearApiKey,
      }
      if (apiKey.length > 0 && !clearApiKey) body.apiKey = apiKey
      const payload = await api('/api/settings', { method: 'POST', body })
      if (!isCurrent()) return
      toast(payload.settings.apiKeySet ? 'API 配置已保存（Key 已配置）' : 'API 配置已保存', 'ok')
      closeModal()
    } catch (error) {
      if (!isCurrent()) return
      errorEl.textContent = error.message || String(error)
    } finally {
      context.savePending = false
      save.disabled = false
    }
  })

  const modelButton = modal.querySelector('[data-load-models]')
  const modelList = modal.querySelector('[data-model-list]')
  const modelInput = modal.querySelector('#settings-model')
  const datalist = modal.querySelector('#settings-model-options')
  const testButton = modal.querySelector('[data-test-model]')
  const testResult = modal.querySelector('[data-test-result]')

  function resetModelResults() {
    context.modelGeneration += 1
    if (context.controllerOwner === 'models') context.controller?.abort()
    if (context.modelPending) {
      context.controller = null
      context.controllerOwner = null
    }
    context.modelPending = false
    modelButton.disabled = false
    modelButton.textContent = '获取模型列表'
    modelList.hidden = true
    modelList.replaceChildren()
    datalist.replaceChildren()
  }

  function resetTestResults() {
    context.testGeneration += 1
    if (context.controllerOwner === 'test') context.controller?.abort()
    if (context.testPending) {
      context.controller = null
      context.controllerOwner = null
    }
    context.testPending = false
    testButton.disabled = false
    testButton.textContent = '检测模型'
    testResult.hidden = true
    testResult.textContent = ''
  }

  for (const input of [
    modal.querySelector('#settings-provider'),
    modal.querySelector('#settings-base-url'),
    modal.querySelector('#settings-api-key'),
    modal.querySelector('#settings-model-api-protocol'),
    modal.querySelector('#settings-model-thinking-adapter'),
  ]) {
    input.addEventListener('input', () => {
      if (!modelList.hidden || context.modelPending) resetModelResults()
      if (context.testPending || !testResult.hidden) resetTestResults()
      if (input.id === 'settings-model-api-protocol') updatePreview()
    })
  }
  for (const input of [
    modal.querySelector('#settings-model'),
    modal.querySelector('#settings-model-thinking'),
  ]) {
    input.addEventListener('input', () => {
      if (context.testPending || !testResult.hidden) resetTestResults()
    })
  }

  // Picking from the native datalist dropdown must update the chip highlight too.
  modelInput.addEventListener('input', () => {
    if (modelList.hidden) return
    for (const chip of modelList.querySelectorAll('.model-chip')) {
      chip.classList.toggle('active', chip.dataset.model === modelInput.value.trim())
    }
  })
  // Assigned below; a successful connectivity probe reuses it so the detected
  // models become selectable without a second click.
  let loadModels = null

  testButton.addEventListener('click', async () => {
    if (context.testPending || context.modelPending || context.savePending || context.resetPending) return
    context.testPending = true
    const generation = ++context.testGeneration
    testButton.disabled = true
    const label = testButton.textContent
    testButton.textContent = '检测中…'
    testResult.hidden = true
    testResult.textContent = ''
    try {
      const protocol = modal.querySelector('#settings-model-api-protocol').value
      const rawProvider = modal.querySelector('#settings-provider').value.trim()
      const rawBaseUrl = modal.querySelector('#settings-base-url').value.trim()
      const body = {
        provider:
          protocol === 'openai-compatible' && rawProvider === 'deepseek-official' && rawBaseUrl.length === 0
            ? 'openai-compatible'
            : rawProvider,
        model: modal.querySelector('#settings-model').value.trim(),
        baseUrl: rawBaseUrl,
        modelApiProtocol: protocol,
        modelThinkingAdapter: modal.querySelector('#settings-model-thinking-adapter').value,
      }
      const apiKey = modal.querySelector('#settings-api-key').value.trim()
      // A blank field means "use the saved key", matching the save semantics.
      if (apiKey.length > 0) body.apiKey = apiKey
      const controller = new AbortController()
      context.controller = controller
      context.controllerOwner = 'test'
      const payload = await api('/api/settings/test', { method: 'POST', body, signal: controller.signal })
      if (!isCurrent() || generation !== context.testGeneration || controller.signal.aborted) return
      const result = payload.result
      testResult.hidden = false
      testResult.className = 'modal-test ' + (result.success ? 'ok' : 'err')
      testResult.textContent = result.message
      if (result.success) {
        toast('模型检测通过', 'ok')
        // Surface the models the same endpoint exposes so they can be picked.
        if (modelList.hidden && loadModels !== null) await loadModels({ quiet: true })
      }
    } catch (error) {
      if (!isCurrent() || generation !== context.testGeneration || error?.name === 'AbortError') return
      testResult.hidden = false
      testResult.className = 'modal-test err'
      testResult.textContent = error.message || String(error)
    } finally {
      if (generation === context.testGeneration) {
        context.testPending = false
        if (context.controllerOwner === 'test') {
          context.controller = null
          context.controllerOwner = null
        }
        testButton.disabled = false
        testButton.textContent = label
      }
    }
  })

  loadModels = async (options) => {
    if (context.modelPending || context.savePending || context.resetPending) return
    context.modelPending = true
    const generation = ++context.modelGeneration
    const quiet = options !== undefined && options.quiet === true
    modelButton.disabled = true
    const label = modelButton.textContent
    if (!quiet) modelButton.textContent = '获取中…'
    modelList.hidden = true
    modelList.replaceChildren()
    try {
      const protocol = modal.querySelector('#settings-model-api-protocol').value
      const rawProvider = modal.querySelector('#settings-provider').value.trim()
      const rawBaseUrl = modal.querySelector('#settings-base-url').value.trim()
      const body = {
        provider:
          protocol === 'openai-compatible' && rawProvider === 'deepseek-official' && rawBaseUrl.length === 0
            ? 'openai-compatible'
            : rawProvider,
        baseUrl: rawBaseUrl,
        modelApiProtocol: protocol,
        modelThinkingAdapter: modal.querySelector('#settings-model-thinking-adapter').value,
      }
      const apiKey = modal.querySelector('#settings-api-key').value.trim()
      if (apiKey.length > 0) body.apiKey = apiKey
      const controller = new AbortController()
      context.controller = controller
      context.controllerOwner = 'models'
      const payload = await api('/api/settings/models', { method: 'POST', body, signal: controller.signal })
      if (!isCurrent() || generation !== context.modelGeneration) return
      const result = payload.result
      modelList.hidden = false
      modelList.className = 'model-list' + (result.success ? '' : ' err')
      const contextKnown = Number(modal.querySelector('#settings-model-context-window').value) > 0
      if (!contextKnown) {
        const contextNote = document.createElement('div')
        contextNote.className = 'model-hint'
        contextNote.textContent = '模型列表通常只返回 ID，没有窗口容量；请按服务端配置手动填写。'
        modelList.append(contextNote)
      }
      if (result.success !== true || result.models.length === 0) {
        modelList.textContent = result.message
        return
      }
      const hint = document.createElement('div')
      hint.className = 'model-hint'
      hint.textContent = result.message
      modelList.append(hint)
      // Feed the Model field's native dropdown as well, so a detected model can
      // be picked from the arrow without scrolling the chip row.
      datalist.replaceChildren()
      for (const id of result.models) {
        const option = document.createElement('option')
        option.value = id
        datalist.append(option)
      }
      const selectModel = (id) => {
        modelInput.value = id
        for (const other of modelList.querySelectorAll('.model-chip')) {
          other.classList.toggle('active', other.dataset.model === id)
        }
      }
      for (const id of result.models) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.dataset.model = id
        chip.className = 'model-chip' + (modelInput.value.trim() === id ? ' active' : '')
        chip.textContent = id
        chip.addEventListener('click', () => selectModel(id))
        modelList.append(chip)
      }
      // Nothing chosen yet: preselect the first detected model so "检测模型"
      // right after loading uses a model that is known to exist.
      if (modelInput.value.trim().length === 0) selectModel(result.models[0])
    } catch (error) {
      if (!isCurrent() || generation !== context.modelGeneration || error?.name === 'AbortError') return
      modelList.hidden = false
      modelList.className = 'model-list err'
      modelList.textContent = error.message || String(error)
    } finally {
      if (generation === context.modelGeneration) {
        context.modelPending = false
        if (context.controllerOwner === 'models') {
          context.controller = null
          context.controllerOwner = null
        }
        modelButton.disabled = false
        modelButton.textContent = label
      }
    }
  }

  modelButton.addEventListener('click', () => {
    void loadModels()
  })
}

async function openSettings() {
  try {
    const payload = await api('/api/settings')
    openSettingsModal(payload.settings)
  } catch (error) {
    toast(error.message, 'err')
  }
}

async function deleteCurrentTask() {
  const raw = location.hash.slice(1)
  const taskId = raw.length > 0 ? decodeURIComponent(raw) : ''
  if (taskId.length === 0) {
    toast('请先在左侧选择一个任务', 'err')
    return
  }
  if (!window.confirm('确定删除任务 ' + taskId + '？任务目录、发现、证据、会话和日志都会被删除，无法恢复。运行中的任务请先停止。')) {
    return
  }
  try {
    const payload = await api('/api/tasks/' + encodeURIComponent(taskId), { method: 'DELETE' })
    toast(payload.result && payload.result.text ? payload.result.text : '任务已删除', 'ok')
    history.replaceState(null, '', location.pathname)
    location.reload()
  } catch (error) {
    toast(error.message, 'err')
  }
}

const settingsButton = $('#api-settings')
if (settingsButton !== null) settingsButton.addEventListener('click', openSettings)
const deleteButton = $('#delete-task')
if (deleteButton !== null) deleteButton.addEventListener('click', deleteCurrentTask)

if (adminHooks.exposeTest === true) {
  globalThis.__nexoraAdminTest = { hooks: adminTestHooks, openSettingsModal }
}
