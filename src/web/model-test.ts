/**
 * Lightweight model probes for the Web UI.
 *
 * The executor itself talks to models through the harness SDK; these helpers
 * only answer "which models does this key/endpoint expose?" and "is the
 * configured key/model/base URL usable right now?". They send at most one
 * OpenAI-compatible request and never persist anything. The API key is never
 * echoed back in a result.
 */
import { AppError, describeError } from '../util/errors.ts'
import { applySettingsInput, resolveWebSettings, validateModelSettings } from './settings.ts'
import { contextBudget, contextBudgetFromServerMetrics, type ContextBudgetStatus, type ModelApiProtocol } from '../util/model-limits.ts'

export interface ModelConfigInput {
  apiKey?: unknown
  clearApiKey?: unknown
  modelApiProtocol?: unknown
  provider?: unknown
  model?: unknown
  baseUrl?: unknown
  modelThinkingAdapter?: unknown
}

export type ApiKeySource = 'request' | 'saved' | 'environment' | 'default' | 'none'

export interface ResolvedModelConfig {
  apiKey: string
  apiKeySource: ApiKeySource
  modelApiProtocol: ModelApiProtocol
  settings: import('./settings.ts').WebSettings
  provider: string
  model: string
  /** Normalized to http(s), without query/hash or a trailing slash. */
  baseUrl: string
}

export type ConfigResolution =
  | { ok: true; config: ResolvedModelConfig }
  | { ok: false; config: Partial<ResolvedModelConfig>; message: string }

export interface ModelTestResult {
  success: boolean
  provider: string
  model: string
  endpoint: string
  apiKeySource: ApiKeySource
  latencyMs: number
  status?: number
  reply?: string
  message: string
  protocol: ModelApiProtocol
  contextWindow: ContextBudgetStatus
}

export interface ModelListResult {
  success: boolean
  provider: string
  apiKeySource: ApiKeySource
  endpoint: string
  models: string[]
  latencyMs: number
  message: string
  protocol: ModelApiProtocol
  contextWindow: ContextBudgetStatus
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'
const TIMEOUT_MS = 20_000
const MAX_REPLY = 160
const MAX_MODELS = 1_000
const METRICS_TIMEOUT_MS = 2_000

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Normalize a Base URL; null when it is not a usable http(s) URL. */
export function normalizeBaseUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** Normalize a configured base URL into the chat-completions endpoint. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  return `${trimmed}/chat/completions`
}

/** Normalize a configured base URL into the model-list endpoint. */
export function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/models')) return trimmed
  if (trimmed.endsWith('/chat/completions')) {
    return `${trimmed.slice(0, -'/chat/completions'.length).replace(/\/+$/, '')}/models`
  }
  return `${trimmed}/models`
}

/** The native DeepSeek Messages adapter appends /v1 at request time. */
export function deepSeekMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  const root = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
  return `${root}/messages`
}

function providerError(payload: unknown, raw: string): string {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    const error = record.error
    if (typeof error === 'string' && error.length > 0) return error
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message.length > 0) return message
    }
    if (typeof record.message === 'string' && record.message.length > 0) return record.message
  }
  return flatten(raw).slice(0, 300)
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function extractModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : []
  const ids = new Set<string>()
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim().length > 0) ids.add(item.trim())
      continue
    }
    if (typeof item === 'object' && item !== null) {
      const id = (item as Record<string, unknown>).id
      if (typeof id === 'string' && id.trim().length > 0) ids.add(id.trim())
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right)).slice(0, MAX_MODELS)
}

/** vLLM exposes this Prometheus metric at the server root, outside /v1. */
export function vllmMetricsUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl)
  const path = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = `${path.replace(/\/v1$/i, '')}/metrics`.replace(/\/+/g, '/')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

/** Parse vLLM's cache_config_info metric without treating unrelated model labels as capacity. */
export function parseVllmMaxModelLen(metrics: string): number | null {
  for (const line of metrics.split(/\r?\n/)) {
    if (!/(?:^|\s)(?:vllm:)?cache_config_info(?:\{|\s|$)/.test(line)) continue
    const match = line.match(/(?:\{|,)\s*max_model_len\s*=\s*["'](\d+)["']/)
    if (match === null) continue
    const value = Number(match[1])
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  return null
}

async function discoverVllmContextWindow(baseUrl: string, apiKey: string): Promise<number | null> {
  let endpoint: string
  try { endpoint = vllmMetricsUrl(baseUrl) } catch { return null }
  try {
    const response = await fetch(endpoint, {
      headers: { ...(apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}), accept: 'text/plain' },
      signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return parseVllmMaxModelLen(await response.text())
  } catch {
    return null
  }
}

async function contextWindowForConfig(
  settings: import('./settings.ts').WebSettings,
  baseUrl: string,
  apiKey: string,
): Promise<ContextBudgetStatus> {
  const initial = contextBudget({ ...settings, baseUrl })
  if (settings.modelThinkingAdapter !== 'vllm' || initial.contextWindowKnown) return initial
  const discovered = await discoverVllmContextWindow(baseUrl, apiKey)
  return discovered === null ? initial : contextBudgetFromServerMetrics(settings, discovered)
}

/**
 * Resolve the effective settings: explicitly supplied form values win, then the
 * saved Web UI settings, then the process environment, then the defaults.
 *
 * Any provider name is accepted. `deepseek-official` is merely the one that has
 * a built-in endpoint; every other provider - a self-hosted gateway, a vendor
 * proxy, "pai", ... - works as long as a Base URL is configured, either through
 * LIEBIAN_BASE_URL / DEEPSEEK_BASE_URL or in the Web UI.
 */
export async function resolveModelConfig(tasksRoot: string, input: ModelConfigInput): Promise<ConfigResolution> {
  const resolved = await resolveWebSettings(tasksRoot)
  let settings
  try {
    settings = applySettingsInput(resolved, input as Record<string, unknown>)
    validateModelSettings(settings)
  } catch (error) {
    const message = error instanceof AppError ? error.message : describeError(error)
    return { ok: false, config: { ...resolved.settings, settings: resolved.settings, apiKeySource: resolved.sources.apiKey }, message }
  }
  const requestKey = text(input.apiKey)
  const apiKeySource: ApiKeySource = requestKey.length > 0 ? 'request' : resolved.sources.apiKey
  const identity = {
    apiKey: settings.apiKey,
    apiKeySource,
    modelApiProtocol: settings.modelApiProtocol,
    provider: settings.provider,
    model: settings.model,
    settings,
  }
  const rawBase = settings.baseUrl.length > 0
    ? settings.baseUrl
    : settings.modelApiProtocol === 'deepseek' && settings.provider === 'deepseek-official'
      ? DEFAULT_BASE_URL
      : ''
  if (rawBase.length === 0) {
    return {
      ok: false,
      config: identity,
      message:
        `provider「${settings.provider}」没有可用的 Base URL：请填写 OpenAI 兼容的 Base URL，` +
        '或设置环境变量 LIEBIAN_BASE_URL（兼容旧名 DEEPSEEK_BASE_URL）。',
    }
  }
  const baseUrl = normalizeBaseUrl(rawBase)
  if (baseUrl === null) {
    return { ok: false, config: identity, message: `Base URL 不是合法的 http(s) 地址：${rawBase}` }
  }
  return { ok: true, config: { ...identity, baseUrl, settings } }
}

/**
 * Send one minimal chat completion and report connectivity, latency and the
 * model's short reply. Provider errors are returned as `success: false`.
 */
export async function testModelConfig(tasksRoot: string, input: ModelConfigInput): Promise<ModelTestResult> {
  const resolved = await resolveModelConfig(tasksRoot, input)
  const fallbackSettings = resolved.config.settings ?? (await resolveWebSettings(tasksRoot)).settings
  const base: Omit<ModelTestResult, 'success' | 'message' | 'latencyMs'> = {
    provider: resolved.config.provider ?? fallbackSettings.provider,
    model: resolved.config.model ?? fallbackSettings.model,
    endpoint: '',
    apiKeySource: resolved.config.apiKeySource ?? 'none',
    protocol: resolved.config.modelApiProtocol ?? fallbackSettings.modelApiProtocol,
    contextWindow: contextBudget({ ...fallbackSettings, model: resolved.config.model ?? fallbackSettings.model, baseUrl: resolved.config.baseUrl ?? fallbackSettings.baseUrl, provider: resolved.config.provider ?? fallbackSettings.provider }),
  }
  if (!resolved.ok) return { success: false, ...base, latencyMs: 0, message: resolved.message }
  const valid = resolved.config

  base.contextWindow = await contextWindowForConfig(valid.settings, valid.baseUrl, valid.apiKey)

  const { apiKey, model, baseUrl } = valid
  const endpoint = valid.modelApiProtocol === 'deepseek' ? deepSeekMessagesUrl(baseUrl) : chatCompletionsUrl(baseUrl)
  base.endpoint = endpoint

  const started = Date.now()
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...(valid.modelApiProtocol === 'deepseek'
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        ...(valid.modelApiProtocol === 'deepseek'
          ? { max_tokens: Math.min(valid.settings.modelMaxTokens, 256_000), messages: [{ role: 'user', content: 'Connectivity check. Reply with exactly: OK' }] }
          : { messages: [{ role: 'user', content: 'Connectivity check. Reply with exactly: OK' }], max_tokens: 8, temperature: 0 }),
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? `请求超过 ${Math.round(TIMEOUT_MS / 1000)} 秒未返回`
        : describeError(error)
    return { success: false, ...base, latencyMs: Date.now() - started, message: `无法连接模型接口：${reason}` }
  }

  const latencyMs = Date.now() - started
  const raw = await response.text().catch(() => '')
  const payload = parseJson(raw)

  if (!response.ok) {
    const detail = providerError(payload, raw)
    const hint =
      response.status === 401 || response.status === 403
        ? '（API Key 无效或没有权限）'
        : response.status === 404
          ? '（接口或模型不存在，请检查 Base URL 与 Model）'
          : response.status === 429
            ? '（请求过于频繁或额度不足）'
            : ''
    return {
      success: false,
      ...base,
      latencyMs,
      status: response.status,
      message: `模型接口返回 HTTP ${response.status}${hint}${detail.length > 0 ? `：${detail}` : ''}`,
    }
  }

  if (payload === null || typeof payload !== 'object') {
    return {
      success: false,
      ...base,
      latencyMs,
      status: response.status,
      message: '模型接口返回成功，但响应不是 JSON；请检查 Base URL 是否指向 OpenAI 兼容接口。',
    }
  }
  const record = payload as Record<string, unknown>
  const choices = record.choices
  const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined
  const message = first?.message as Record<string, unknown> | undefined
  const deepSeekContent = Array.isArray(record.content) ? record.content.map((part) => typeof part === 'object' && part !== null ? (part as Record<string, unknown>).text : '').filter((part): part is string => typeof part === 'string').join('') : ''
  const reply = flatten(valid.modelApiProtocol === 'deepseek'
    ? deepSeekContent
    : typeof message?.content === 'string' ? message.content : typeof first?.text === 'string' ? first.text : '').slice(0, MAX_REPLY)

  return {
    success: true,
    ...base,
    latencyMs,
    status: response.status,
    ...(reply.length > 0 ? { reply } : {}),
    message:
      reply.length > 0
        ? `连接成功：${model} 在 ${latencyMs} ms 内返回「${reply}」。`
        : `连接成功：${model} 接口可达（${latencyMs} ms），但响应中没有文本内容。`,
  }
}

/** Query the OpenAI-compatible `/models` endpoint with the effective settings. */
export async function listModelConfig(tasksRoot: string, input: ModelConfigInput): Promise<ModelListResult> {
  const resolved = await resolveModelConfig(tasksRoot, input)
  const fallbackSettings = resolved.config.settings ?? (await resolveWebSettings(tasksRoot)).settings
  const base = {
    provider: resolved.config.provider ?? fallbackSettings.provider,
    apiKeySource: resolved.config.apiKeySource ?? 'none',
    endpoint: '',
    models: [] as string[],
    protocol: resolved.config.modelApiProtocol ?? fallbackSettings.modelApiProtocol,
    contextWindow: contextBudget({ ...fallbackSettings, model: resolved.config.model ?? fallbackSettings.model, baseUrl: resolved.config.baseUrl ?? fallbackSettings.baseUrl, provider: resolved.config.provider ?? fallbackSettings.provider }),
  }
  if (!resolved.ok) return { success: false, ...base, latencyMs: 0, message: resolved.message }
  const valid = resolved.config

  base.contextWindow = await contextWindowForConfig(valid.settings, valid.baseUrl, valid.apiKey)

  if (valid.modelApiProtocol === 'deepseek') {
    return { success: false, ...base, latencyMs: 0, message: 'DeepSeek Messages 原生接口不提供 OpenAI /models 列表；请手动填写 Model。' }
  }
  const endpoint = modelsUrl(valid.baseUrl)
  base.endpoint = endpoint
  const started = Date.now()
  let response: Response
  try {
    response = await fetch(endpoint, {
      headers: { ...(valid.apiKey.length > 0 ? { authorization: `Bearer ${valid.apiKey}` } : {}), accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? `请求超过 ${Math.round(TIMEOUT_MS / 1000)} 秒未返回`
        : describeError(error)
    return { success: false, ...base, latencyMs: Date.now() - started, message: `无法连接模型列表接口：${reason}` }
  }

  const latencyMs = Date.now() - started
  const raw = await response.text().catch(() => '')
  const payload = parseJson(raw)

  if (!response.ok) {
    const detail = providerError(payload, raw)
    const hint =
      response.status === 404 || response.status === 405
        ? '（该接口不提供模型列表；请手动填写 Model）'
        : response.status === 401 || response.status === 403
          ? '（API Key 无效或没有权限）'
          : ''
    return {
      success: false,
      ...base,
      latencyMs,
      message: `获取模型列表失败（HTTP ${response.status}）${hint}${detail.length > 0 ? `：${detail}` : ''}`,
    }
  }

  const models = extractModelIds(payload)
  return {
    success: true,
    ...base,
    latencyMs,
    models,
    message:
      models.length > 0
        ? `获取到 ${models.length} 个可用模型，点击即可填入 Model。`
        : '接口可达，但没有返回模型；可以直接手动填写 Model。',
  }
}
