/* Web UI administration helpers: API settings and task deletion. */
const $ = (selector) => document.querySelector(selector)

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
  const response = await fetch(path, {
    method,
    headers,
    body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
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

function closeModal() {
  $('#modal-root').innerHTML = ''
}

function sourceLabel(source) {
  return ({
    saved: '已保存',
    environment: '环境变量',
    default: '默认值',
    none: '未配置',
  })[source] || ''
}

function sourceHint(source, text) {
  const label = sourceLabel(source)
  if (label.length === 0) return ''
  return '<span class="hint" data-source="' + esc(source) + '">' + esc(label) + (text ? '：' + esc(text) : '') + '</span>'
}

function openSettingsModal(settings) {
  const root = $('#modal-root')
  const sources = settings.sources || {}
  const keyHint = settings.apiKeySet
    ? '已配置，来源：' + sourceLabel(settings.apiKeySource)
    : '未配置'
  const keyPlaceholder = settings.apiKeySet ? '已配置，留空保持' : 'sk-...'
  const basePlaceholder = settings.baseUrl || 'https://api.example.com/v1'
  const overrideNote = settings.savedOverride
    ? '当前使用已保存的配置，它会覆盖环境变量。'
    : '当前配置来自环境变量；保存后将以这里的设置为准。'
  root.innerHTML =
    '<div class="modal-backdrop">' +
    '<div class="modal" role="dialog" aria-modal="true" aria-label="API 配置">' +
    '<div class="modal-head"><h3>API 配置</h3><button class="modal-close" type="button" data-close aria-label="关闭">×</button></div>' +
    '<div class="modal-body">' +
    '<div class="modal-note" data-override-note>' + esc(overrideNote) + '</div>' +
    '<div class="field"><span>API Key <span class="hint">' + esc(keyHint) + '</span></span>' +
    '<input id="settings-api-key" type="password" autocomplete="new-password" placeholder="' + esc(keyPlaceholder) + '"></div>' +
    '<div class="field-row">' +
    '<label class="field"><span>Provider ' + sourceHint(sources.provider) + '</span><input id="settings-provider" value="' + esc(settings.provider) + '" placeholder="deepseek-official"></label>' +
    '<label class="field"><span>Model ' + sourceHint(sources.model) + '</span><input id="settings-model" list="settings-model-options" autocomplete="off" value="' + esc(settings.model) + '" placeholder="点击下方获取，或直接输入模型 id"></label>' +
    '</div>' +
    '<datalist id="settings-model-options"></datalist>' +
    '<div class="test-row"><button class="btn small ghost" type="button" data-load-models>获取模型列表</button>' +
    '<span class="test-hint">从当前 Base URL 读取；下拉框或点击模型名即可选中。</span></div>' +
    '<div class="model-list" data-model-list hidden></div>' +
    '<label class="field"><span>Base URL（可选）' + sourceHint(sources.baseUrl) + '</span><input id="settings-base-url" value="' + esc(settings.baseUrl) + '" placeholder="' + esc(basePlaceholder) + '"></label>' +
    '<label class="field"><span>模型请求并发数 <span class="hint">整个任务合计，默认 4</span></span>' +
    '<input id="settings-model-concurrency" type="number" min="1" step="1" value="' + esc(String(settings.modelConcurrency)) + '"></label>' +
    '<label class="field"><span>单次响应输出上限 ' + sourceHint(sources.modelMaxTokens) + '<span class="hint">默认 32000；网关上限更低时调小，过大可能返回空回复</span></span>' +
    '<input id="settings-model-max-tokens" type="number" min="1" step="1" value="' + esc(String(settings.modelMaxTokens)) + '"></label>' +
    '<label class="field"><span>思考强度 ' + sourceHint(sources.modelThinking) + '<span class="hint">关＝不思考（更快）；仅部分模型支持调整，个别模型关闭后会返回空回复</span></span>' +
    '<select id="settings-model-thinking">' +
    [['off', '关'], ['low', '低'], ['high', '高（默认）'], ['max', '最高']]
      .map(([value, label]) => '<option value="' + value + '"' + (settings.modelThinking === value ? ' selected' : '') + '>' + label + '</option>')
      .join('') +
    '</select></label>' +
    '<label class="radio-line"><input type="checkbox" id="settings-clear-key" ' + (settings.apiKeySet ? '' : 'disabled') + '> 清除 API Key（保存后不再使用任何 Key，包括环境变量里的）</label>' +
    '<div class="test-row"><button class="btn small ghost" type="button" data-test-model>检测模型</button>' +
    '<span class="test-hint">用当前填写的内容发一次最小请求，不保存配置。</span></div>' +
    '<div class="modal-test" data-test-result hidden></div>' +
    '<div class="modal-error" data-error></div>' +
    '<div class="modal-note">保存后用于之后启动的任务；任务容器通过环境变量接收。API Key 不会回显。' +
    (settings.savedOverride ? ' <button class="btn small ghost" type="button" data-reset>回退到环境变量</button>' : '') +
    '</div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn ghost" type="button" data-close>取消</button>' +
    '<button class="btn primary" type="button" data-save>保存</button></div>' +
    '</div></div>'
  const modal = root.querySelector('.modal')
  const errorEl = modal.querySelector('[data-error]')
  for (const button of modal.querySelectorAll('[data-close]')) button.addEventListener('click', closeModal)
  root.querySelector('.modal-backdrop').addEventListener('mousedown', (event) => {
    if (event.target === root.querySelector('.modal-backdrop')) closeModal()
  })
  const resetButton = modal.querySelector('[data-reset]')
  if (resetButton !== null) {
    resetButton.addEventListener('click', async () => {
      resetButton.disabled = true
      errorEl.textContent = ''
      try {
        await api('/api/settings', { method: 'DELETE' })
        toast('已回退到环境变量配置', 'ok')
        closeModal()
      } catch (error) {
        errorEl.textContent = error.message || String(error)
      } finally {
        resetButton.disabled = false
      }
    })
  }
  modal.querySelector('[data-save]').addEventListener('click', async () => {
    const save = modal.querySelector('[data-save]')
    save.disabled = true
    errorEl.textContent = ''
    try {
      const clearApiKey = modal.querySelector('#settings-clear-key').checked
      const apiKey = modal.querySelector('#settings-api-key').value.trim()
      const modelConcurrency = Number(modal.querySelector('#settings-model-concurrency').value)
      if (!Number.isInteger(modelConcurrency) || modelConcurrency < 1) {
        throw new Error('模型请求并发数必须是正整数')
      }
      const modelMaxTokens = Number(modal.querySelector('#settings-model-max-tokens').value)
      if (!Number.isInteger(modelMaxTokens) || modelMaxTokens < 1) {
        throw new Error('单次响应输出上限必须是正整数')
      }
      const body = {
        provider: modal.querySelector('#settings-provider').value.trim(),
        model: modal.querySelector('#settings-model').value.trim(),
        baseUrl: modal.querySelector('#settings-base-url').value.trim(),
        modelConcurrency,
        modelMaxTokens,
        modelThinking: modal.querySelector('#settings-model-thinking').value,
        clearApiKey,
      }
      if (apiKey.length > 0 && !clearApiKey) body.apiKey = apiKey
      const payload = await api('/api/settings', { method: 'POST', body })
      toast(payload.settings.apiKeySet ? 'API 配置已保存（Key 已配置）' : 'API 配置已保存', 'ok')
      closeModal()
    } catch (error) {
      errorEl.textContent = error.message || String(error)
    } finally {
      save.disabled = false
    }
  })

  const modelButton = modal.querySelector('[data-load-models]')
  const modelList = modal.querySelector('[data-model-list]')
  const modelInput = modal.querySelector('#settings-model')
  // Picking from the native datalist dropdown must update the chip highlight too.
  modelInput.addEventListener('input', () => {
    for (const chip of modelList.querySelectorAll('.model-chip')) {
      chip.classList.toggle('active', chip.dataset.model === modelInput.value.trim())
    }
  })
  // Assigned below; a successful connectivity probe reuses it so the detected
  // models become selectable without a second click.
  let loadModels = null

  const testButton = modal.querySelector('[data-test-model]')
  const testResult = modal.querySelector('[data-test-result]')
  testButton.addEventListener('click', async () => {
    testButton.disabled = true
    const label = testButton.textContent
    testButton.textContent = '检测中…'
    testResult.hidden = true
    testResult.textContent = ''
    try {
      const body = {
        provider: modal.querySelector('#settings-provider').value.trim(),
        model: modal.querySelector('#settings-model').value.trim(),
        baseUrl: modal.querySelector('#settings-base-url').value.trim(),
      }
      const apiKey = modal.querySelector('#settings-api-key').value.trim()
      // A blank field means "use the saved key", matching the save semantics.
      if (apiKey.length > 0) body.apiKey = apiKey
      const payload = await api('/api/settings/test', { method: 'POST', body })
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
      testResult.hidden = false
      testResult.className = 'modal-test err'
      testResult.textContent = error.message || String(error)
    } finally {
      testButton.disabled = false
      testButton.textContent = label
    }
  })

  loadModels = async (options) => {
    const quiet = options !== undefined && options.quiet === true
    modelButton.disabled = true
    const label = modelButton.textContent
    if (!quiet) modelButton.textContent = '获取中…'
    modelList.hidden = true
    modelList.replaceChildren()
    try {
      const body = {
        provider: modal.querySelector('#settings-provider').value.trim(),
        baseUrl: modal.querySelector('#settings-base-url').value.trim(),
      }
      const apiKey = modal.querySelector('#settings-api-key').value.trim()
      if (apiKey.length > 0) body.apiKey = apiKey
      const payload = await api('/api/settings/models', { method: 'POST', body })
      const result = payload.result
      modelList.hidden = false
      modelList.className = 'model-list' + (result.success ? '' : ' err')
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
      const datalist = modal.querySelector('#settings-model-options')
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
      modelList.hidden = false
      modelList.className = 'model-list err'
      modelList.textContent = error.message || String(error)
    } finally {
      modelButton.disabled = false
      modelButton.textContent = label
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
