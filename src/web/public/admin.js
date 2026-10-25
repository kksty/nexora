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

function openSettingsModal(settings) {
  const root = $('#modal-root')
  const keyHint = settings.apiKeySet ? '已配置；留空保持' : '未配置'
  const keyPlaceholder = settings.apiKeySet ? '已配置，留空保持' : 'sk-...'
  root.innerHTML =
    '<div class="modal-backdrop">' +
    '<div class="modal" role="dialog" aria-modal="true" aria-label="API 配置">' +
    '<div class="modal-head"><h3>API 配置</h3><button class="modal-close" type="button" data-close aria-label="关闭">×</button></div>' +
    '<div class="modal-body">' +
    '<div class="field"><span>API Key <span class="hint">' + esc(keyHint) + '</span></span>' +
    '<input id="settings-api-key" type="password" autocomplete="new-password" placeholder="' + esc(keyPlaceholder) + '"></div>' +
    '<div class="field-row">' +
    '<label class="field"><span>Provider</span><input id="settings-provider" value="' + esc(settings.provider) + '"></label>' +
    '<label class="field"><span>Model</span><input id="settings-model" value="' + esc(settings.model) + '"></label>' +
    '</div>' +
    '<div class="test-row"><button class="btn small ghost" type="button" data-load-models>获取模型列表</button>' +
    '<span class="test-hint">从当前 Base URL 读取，点击模型名填入 Model。</span></div>' +
    '<div class="model-list" data-model-list hidden></div>' +
    '<label class="field"><span>Base URL（可选）</span><input id="settings-base-url" value="' + esc(settings.baseUrl) + '" placeholder="https://api.deepseek.com"></label>' +
    '<label class="field"><span>模型请求并发数 <span class="hint">整个任务合计，默认 4</span></span>' +
    '<input id="settings-model-concurrency" type="number" min="1" step="1" value="' + esc(String(settings.modelConcurrency)) + '"></label>' +
    '<label class="radio-line"><input type="checkbox" id="settings-clear-key" ' + (settings.apiKeySet ? '' : 'disabled') + '> 清除已保存的 API Key</label>' +
    '<div class="test-row"><button class="btn small ghost" type="button" data-test-model>检测模型</button>' +
    '<span class="test-hint">用当前填写的内容发一次最小请求，不保存配置。</span></div>' +
    '<div class="modal-test" data-test-result hidden></div>' +
    '<div class="modal-error" data-error></div>' +
    '<div class="modal-note">保存后用于之后启动的任务；任务容器通过环境变量接收。API Key 不会回显。</div>' +
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
      const body = {
        provider: modal.querySelector('#settings-provider').value.trim(),
        model: modal.querySelector('#settings-model').value.trim(),
        baseUrl: modal.querySelector('#settings-base-url').value.trim(),
        modelConcurrency,
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
      if (result.success) toast('模型检测通过', 'ok')
    } catch (error) {
      testResult.hidden = false
      testResult.className = 'modal-test err'
      testResult.textContent = error.message || String(error)
    } finally {
      testButton.disabled = false
      testButton.textContent = label
    }
  })

  const modelButton = modal.querySelector('[data-load-models]')
  const modelList = modal.querySelector('[data-model-list]')
  const modelInput = modal.querySelector('#settings-model')
  modelButton.addEventListener('click', async () => {
    modelButton.disabled = true
    const label = modelButton.textContent
    modelButton.textContent = '获取中…'
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
      for (const id of result.models) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'model-chip' + (modelInput.value.trim() === id ? ' active' : '')
        chip.textContent = id
        chip.addEventListener('click', () => {
          modelInput.value = id
          for (const other of modelList.querySelectorAll('.model-chip')) {
            other.classList.toggle('active', other === chip)
          }
        })
        modelList.append(chip)
      }
    } catch (error) {
      modelList.hidden = false
      modelList.className = 'model-list err'
      modelList.textContent = error.message || String(error)
    } finally {
      modelButton.disabled = false
      modelButton.textContent = label
    }
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
