/** Web-owned model settings. Saved > environment > default; secrets stay private. */
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readTextIfExists, writeFileAtomic } from '../util/atomic.ts'
import { AppError } from '../util/errors.ts'
import { parseModelConcurrency } from '../util/semaphore.ts'
import {
  MODEL_POLICY_ENV,
  MODEL_POLICY_PARSERS,
  contextBudget,
  validateContextBudget,
  type ContextBudgetStatus,
  type ModelPolicy,
} from '../util/model-limits.ts'

export interface WebSettings extends ModelPolicy {
  apiKey: string
  provider: string
  model: string
  baseUrl: string
  modelConcurrency: number
}

export type SettingsSource = 'saved' | 'environment' | 'default'
export type ApiKeySource = SettingsSource | 'none'
export type SettingsSources = { [K in keyof WebSettings]: K extends 'apiKey' ? ApiKeySource : SettingsSource }

export interface ResolvedWebSettings {
  settings: WebSettings
  sources: SettingsSources
  savedOverride: boolean
  savedInvalid: boolean
}

export interface PublicWebSettings extends Omit<WebSettings, 'apiKey'>, ContextBudgetStatus {
  apiKeySet: boolean
  apiKeySource: ApiKeySource
  sources: SettingsSources
  savedOverride: boolean
  savedInvalid: boolean
  settingsApply: 'next-runtime'
}

export const ENV_API_KEY = ['LIEBIAN_API_KEY', 'DEEPSEEK_API_KEY'] as const
export const ENV_BASE_URL = ['LIEBIAN_BASE_URL', 'DEEPSEEK_BASE_URL'] as const
export const ENV_PROVIDER = 'LIEBIAN_PROVIDER'
export const ENV_MODEL = 'LIEBIAN_MODEL'

export function envText(...names: readonly string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? '').trim()
    if (value) return value
  }
  return ''
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const settingsFile = (root: string): string => join(root, '.web-settings.json')
const parsers = {
  ...MODEL_POLICY_PARSERS,
  modelConcurrency: (value: unknown) => parseModelConcurrency(value, 2),
}
const envNames = { ...MODEL_POLICY_ENV, modelConcurrency: 'LIEBIAN_MODEL_CONCURRENCY' }

/** The legacy secret is valid only for its original official DeepSeek host. */
export function canUseLegacyKey(s: Pick<WebSettings, 'modelApiProtocol' | 'baseUrl' | 'provider'>): boolean {
  return s.modelApiProtocol === 'deepseek' && s.provider === 'deepseek-official'
    && (!s.baseUrl || /^https:\/\/api\.deepseek\.com\/?$/.test(s.baseUrl))
}

export async function resolveWebSettings(root: string): Promise<ResolvedWebSettings> {
  const raw = await readTextIfExists(settingsFile(root))
  let saved: Record<string, unknown> | null = null
  let savedInvalid = false
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
      saved = parsed as Record<string, unknown>
    } catch {
      savedInvalid = true
    }
  }

  const settings = {} as WebSettings
  const sources = {} as SettingsSources
  for (const [key, parse] of Object.entries(parsers)) {
    const typed = key as keyof typeof parsers
    let value = parse(undefined)
    let source: SettingsSource = 'default'
    const env = process.env[envNames[typed]]
    if (env?.trim()) {
      try {
        value = parse(env)
        source = 'environment'
      } catch {
        // An illegal environment value is defaulted, never reported as env-sourced.
      }
    }
    if (saved?.[typed] !== undefined) {
      try {
        if (saved[typed] === null || saved[typed] === '') throw new Error('empty')
        value = parse(saved[typed])
        source = 'saved'
      } catch {
        value = parse(undefined)
        source = 'default'
      }
    }
    Object.assign(settings, { [typed]: value })
    Object.assign(sources, { [typed]: source })
  }

  for (const [key, envName, fallback] of [
    ['provider', ENV_PROVIDER, 'deepseek-official'],
    ['model', ENV_MODEL, 'deepseek-flash'],
  ] as const) {
    const stored = text(saved?.[key])
    const env = envText(envName)
    settings[key] = stored || env || fallback
    sources[key] = stored ? 'saved' : env ? 'environment' : 'default'
  }

  const envBase = settings.modelApiProtocol === 'deepseek'
    ? envText(...ENV_BASE_URL)
    : envText('LIEBIAN_BASE_URL')
  settings.baseUrl = saved && 'baseUrl' in saved ? text(saved.baseUrl) : envBase
  sources.baseUrl = saved && 'baseUrl' in saved ? 'saved' : envBase ? 'environment' : 'default'

  const explicitKey = process.env.LIEBIAN_API_KEY?.trim()
  const envKey = explicitKey || (canUseLegacyKey(settings) ? envText('DEEPSEEK_API_KEY') : '')
  settings.apiKey = saved && 'apiKey' in saved ? text(saved.apiKey) : envKey
  sources.apiKey = settings.apiKey ? (saved && 'apiKey' in saved ? 'saved' : 'environment') : 'none'

  return { settings, sources, savedOverride: raw !== null, savedInvalid }
}

export async function loadWebSettings(root: string): Promise<WebSettings> {
  return (await resolveWebSettings(root)).settings
}

export const effectiveWebSettings = loadWebSettings

/** Shared by save, model probes and task launch. */
export function validateModelSettings(s: WebSettings): void {
  if (!s.provider) throw new AppError('INVALID_ARGUMENT', 'Provider 不能为空')
  if (!s.model) throw new AppError('INVALID_ARGUMENT', 'Model 不能为空')
  if (s.modelApiProtocol === 'deepseek' && !s.apiKey) {
    throw new AppError('INVALID_ARGUMENT', 'DeepSeek Messages 协议必须提供非空 API Key（LIEBIAN_API_KEY 或 Web API Key）')
  }
  if (!s.baseUrl && (s.modelApiProtocol !== 'deepseek' || s.provider !== 'deepseek-official')) {
    throw new AppError('INVALID_ARGUMENT', '此协议 / provider 必须配置 Base URL')
  }
  if (s.baseUrl) {
    try {
      const url = new URL(s.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('url')
      }
      if (/\/(?:chat\/completions|messages|models)\/?$/.test(url.pathname)) throw new Error('endpoint')
    } catch {
      throw new AppError('INVALID_ARGUMENT', 'Base URL 必须是 http(s) 基础地址，不含凭据、查询或 /chat/completions、/messages、/models')
    }
  }
  validateContextBudget(s)
}

/** Apply one Web request through the same parsers used by save and launch. */
export function applySettingsInput(current: ResolvedWebSettings, input: Record<string, unknown>): WebSettings {
  const next = { ...current.settings }
  for (const key of ['provider', 'model', 'baseUrl'] as const) {
    if (typeof input[key] === 'string') next[key] = text(input[key])
  }
  for (const [key, parse] of Object.entries(parsers)) {
    if (input[key] !== undefined) Object.assign(next, { [key]: parse(input[key]) })
  }
  const requestKey = text(input.apiKey)
  if (requestKey.length > 4096) throw new AppError('INVALID_ARGUMENT', 'API Key 过长')
  if (requestKey) next.apiKey = requestKey
  if (input.clearApiKey === true) next.apiKey = ''
  // Never forward the legacy DeepSeek environment secret to another host.
  if (!requestKey && current.sources.apiKey === 'environment' && !process.env.LIEBIAN_API_KEY?.trim()
    && !canUseLegacyKey(next)) next.apiKey = ''
  return next
}

export async function saveWebSettings(
  root: string,
  input: Omit<WebSettings, keyof ModelPolicy> & Partial<ModelPolicy>,
): Promise<void> {
  const settings = { ...input } as WebSettings
  for (const [key, parse] of Object.entries(parsers)) {
    Object.assign(settings, { [key]: parse(input[key as keyof typeof input]) })
  }
  for (const key of ['apiKey', 'provider', 'model', 'baseUrl'] as const) settings[key] = text(settings[key])
  validateModelSettings(settings)
  const file = settingsFile(root)
  await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`)
  await chmod(file, 0o600).catch(() => undefined)
}

export async function clearWebSettings(root: string): Promise<void> {
  await rm(settingsFile(root), { force: true })
}

export function publicWebSettings(resolved: ResolvedWebSettings): PublicWebSettings {
  const { apiKey, ...publicSettings } = resolved.settings
  return {
    ...publicSettings,
    ...contextBudget(resolved.settings),
    apiKeySet: apiKey.length > 0,
    apiKeySource: resolved.sources.apiKey,
    sources: resolved.sources,
    savedOverride: resolved.savedOverride,
    savedInvalid: resolved.savedInvalid,
    settingsApply: 'next-runtime',
  }
}

export function sourceLabel(source: SettingsSource | 'none'): string {
  return ({ saved: '已保存', environment: '环境变量', default: '默认值', none: '未配置' })[source]
}

/** Container environment for one immutable runtime generation. */
export function modelSettingsEnvironment(s: WebSettings): NodeJS.ProcessEnv {
  validateModelSettings(s)
  const env: NodeJS.ProcessEnv = {
    LIEBIAN_API_KEY: s.apiKey,
    LIEBIAN_BASE_URL: s.baseUrl,
    LIEBIAN_PROVIDER: s.modelApiProtocol === 'openai-compatible' ? 'liebian-openai-compatible' : s.provider,
    LIEBIAN_MODEL: s.model,
    LIEBIAN_MODEL_CONCURRENCY: String(s.modelConcurrency),
  }
  for (const [key, name] of Object.entries(MODEL_POLICY_ENV)) env[name] = String(s[key as keyof ModelPolicy])
  if (s.modelApiProtocol === 'deepseek') {
    env.DEEPSEEK_API_KEY = s.apiKey
    env.DEEPSEEK_BASE_URL = s.baseUrl
  }
  return env
}
