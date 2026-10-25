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
import { loadWebSettings } from './settings.ts'

export interface ModelConfigInput {
  apiKey?: unknown
  provider?: unknown
  model?: unknown
  baseUrl?: unknown
}

export type ApiKeySource = 'request' | 'saved' | 'environment' | 'none'

export interface ResolvedModelConfig {
  apiKey: string
  apiKeySource: ApiKeySource
  provider: string
  model: string
  /** Normalized to http(s), without query/hash or a trailing slash. */
  baseUrl: string
}

export type ConfigResolution =
  | { ok: true; config: ResolvedModelConfig }
  | { ok: false; config: Omit<ResolvedModelConfig, 'baseUrl'>; message: string }

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
}

export interface ModelListResult {
  success: boolean
  provider: string
  apiKeySource: ApiKeySource
  endpoint: string
  models: string[]
  latencyMs: number
  message: string
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const TIMEOUT_MS = 20_000
const MAX_REPLY = 160
const MAX_MODELS = 1_000

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

/**
 * Resolve the effective settings: explicitly supplied form values win, then the
 * saved Web UI settings, then the process environment.
 */
export async function resolveModelConfig(tasksRoot: string, input: ModelConfigInput): Promise<ConfigResolution> {
  const requestKey = text(input.apiKey)
  if (requestKey.length > 4096) throw new AppError('INVALID_ARGUMENT', 'API Key 过长')
  const saved = await loadWebSettings(tasksRoot)
  const savedKey = saved.apiKey
  const envKey = (process.env.DEEPSEEK_API_KEY ?? '').trim()

  const apiKey = requestKey || savedKey || envKey
  const apiKeySource: ApiKeySource =
    requestKey.length > 0 ? 'request' : savedKey.length > 0 ? 'saved' : envKey.length > 0 ? 'environment' : 'none'
  const provider = text(input.provider) || saved.provider || process.env.LIEBIAN_PROVIDER || 'deepseek-official'
  const model = text(input.model) || saved.model || process.env.LIEBIAN_MODEL || 'deepseek-flash'
  const configuredBase = text(input.baseUrl) || saved.baseUrl || (process.env.DEEPSEEK_BASE_URL ?? '').trim()
  const identity = { apiKey, apiKeySource, provider, model }

  if (apiKey.length === 0) {
    return {
      ok: false,
      config: identity,
      message: '没有可用的 API Key：请在弹窗中填写，或保存配置，或在启动 Web UI 的环境里设置 DEEPSEEK_API_KEY。',
    }
  }

  const rawBase =
    configuredBase.length > 0
      ? configuredBase
      : provider === 'deepseek-official'
        ? DEFAULT_BASE_URL
        : ''
  if (rawBase.length === 0) {
    return {
      ok: false,
      config: identity,
      message: `provider「${provider}」不是内置的 deepseek-official，请填写 OpenAI 兼容的 Base URL。`,
    }
  }
  const baseUrl = normalizeBaseUrl(rawBase)
  if (baseUrl === null) {
    return { ok: false, config: identity, message: `Base URL 不是合法的 http(s) 地址：${rawBase}` }
  }
  return { ok: true, config: { ...identity, baseUrl } }
}

/**
 * Send one minimal chat completion and report connectivity, latency and the
 * model's short reply. Provider errors are returned as `success: false`.
 */
export async function testModelConfig(tasksRoot: string, input: ModelConfigInput): Promise<ModelTestResult> {
  const resolved = await resolveModelConfig(tasksRoot, input)
  const base: Omit<ModelTestResult, 'success' | 'message' | 'latencyMs'> = {
    provider: resolved.config.provider,
    model: resolved.config.model,
    endpoint: '',
    apiKeySource: resolved.config.apiKeySource,
  }
  if (!resolved.ok) return { success: false, ...base, latencyMs: 0, message: resolved.message }

  const { apiKey, model, baseUrl } = resolved.config
  const endpoint = chatCompletionsUrl(baseUrl)
  base.endpoint = endpoint

  const started = Date.now()
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Connectivity check. Reply with exactly: OK' }],
        max_tokens: 8,
        temperature: 0,
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
  const choices = (payload as Record<string, unknown>).choices
  const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined
  const message = first?.message as Record<string, unknown> | undefined
  const reply = flatten(
    typeof message?.content === 'string' ? message.content : typeof first?.text === 'string' ? first.text : '',
  ).slice(0, MAX_REPLY)

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
  const base = {
    provider: resolved.config.provider,
    apiKeySource: resolved.config.apiKeySource,
    endpoint: '',
    models: [] as string[],
  }
  if (!resolved.ok) return { success: false, ...base, latencyMs: 0, message: resolved.message }

  const endpoint = modelsUrl(resolved.config.baseUrl)
  base.endpoint = endpoint
  const started = Date.now()
  let response: Response
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${resolved.config.apiKey}`, accept: 'application/json' },
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
