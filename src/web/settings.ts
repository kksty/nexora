/**
 * Web UI-owned API settings.
 *
 * Precedence, highest first:
 *   1. values typed into the Web UI dialog (per request, never persisted here)
 *   2. values saved from the Web UI  -> tasks/.web-settings.json
 *   3. the process environment      -> LIEBIAN_* / legacy DEEPSEEK_*
 *   4. built-in defaults
 *
 * Once `.web-settings.json` exists its fields are authoritative, including an
 * empty API Key or Base URL. That is what lets the UI override - or switch off -
 * a value that came from the environment. `clearWebSettings` drops the file so
 * the environment applies again.
 *
 * The API key is only ever returned to the browser as a boolean plus the name of
 * the layer it came from.
 */
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readTextIfExists, writeFileAtomic } from '../util/atomic.ts'
import { DEFAULT_MODEL_CONCURRENCY, parseModelConcurrency } from '../util/semaphore.ts'
import { DEFAULT_MODEL_MAX_TOKENS, envModelMaxTokens, envModelThinking, parseModelMaxTokens, parseModelThinking, type ModelThinking } from '../util/model-limits.ts'

export interface WebSettings {
  apiKey: string
  provider: string
  model: string
  baseUrl: string
  modelConcurrency: number
  /** Per-response output budget handed to the harness. */
  modelMaxTokens: number
  /** Reasoning intensity; `off` disables extended thinking. */
  modelThinking: ModelThinking
}

/** Which layer a resolved value came from. */
export type SettingsSource = 'saved' | 'environment' | 'default'
/** A credential additionally has a "nothing configured" state. */
export type ApiKeySource = SettingsSource | 'none'

export interface SettingsSources {
  apiKey: ApiKeySource
  provider: SettingsSource
  model: SettingsSource
  baseUrl: SettingsSource
  modelConcurrency: SettingsSource
  modelMaxTokens: SettingsSource
  modelThinking: SettingsSource
}

export interface PublicWebSettings {
  apiKeySet: boolean
  apiKeySource: ApiKeySource
  provider: string
  model: string
  baseUrl: string
  modelConcurrency: number
  modelMaxTokens: number
  modelThinking: ModelThinking
  sources: SettingsSources
  /** True when `.web-settings.json` exists and therefore shadows the environment. */
  savedOverride: boolean
}

export interface ResolvedWebSettings {
  settings: WebSettings
  sources: SettingsSources
  savedOverride: boolean
}

const DEFAULT_PROVIDER = 'deepseek-official'
const DEFAULT_MODEL = 'deepseek-flash'

/** Provider-neutral names first, legacy DeepSeek-only names second. */
export const ENV_API_KEY = ['LIEBIAN_API_KEY', 'DEEPSEEK_API_KEY'] as const
export const ENV_BASE_URL = ['LIEBIAN_BASE_URL', 'DEEPSEEK_BASE_URL'] as const
export const ENV_PROVIDER = 'LIEBIAN_PROVIDER'
export const ENV_MODEL = 'LIEBIAN_MODEL'

/** First non-empty value among `names`, trimmed. */
export function envText(...names: readonly string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? '').trim()
    if (value.length > 0) return value
  }
  return ''
}

function envApiKey(): string {
  return envText(...ENV_API_KEY)
}

function envBaseUrl(): string {
  return envText(...ENV_BASE_URL)
}

function envProvider(): string {
  return envText(ENV_PROVIDER) || DEFAULT_PROVIDER
}

function envModel(): string {
  return envText(ENV_MODEL) || DEFAULT_MODEL
}

/** Web UI configuration is forgiving: a bad env value falls back to 4. */
function envModelConcurrency(): number {
  try {
    return parseModelConcurrency(process.env.LIEBIAN_MODEL_CONCURRENCY)
  } catch {
    return DEFAULT_MODEL_CONCURRENCY
  }
}

function settingsFile(tasksRoot: string): string {
  return join(tasksRoot, '.web-settings.json')
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Raw saved JSON, or null when the file is missing or unusable. */
async function readSavedSettings(tasksRoot: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextIfExists(settingsFile(tasksRoot))
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Resolve the effective settings and remember where every value came from.
 *
 * `provider` and `model` cannot be meaningfully empty, so an empty saved value
 * falls through to the environment and then to the default. `apiKey` and
 * `baseUrl` treat an empty saved value as a deliberate override.
 */
export async function resolveWebSettings(tasksRoot: string): Promise<ResolvedWebSettings> {
  const saved = await readSavedSettings(tasksRoot)
  const savedOverride = saved !== null

  const savedKey = saved === null ? '' : asString(saved.apiKey)
  const savedProvider = saved === null ? '' : asString(saved.provider)
  const savedModel = saved === null ? '' : asString(saved.model)
  const savedBaseUrl = saved === null ? '' : asString(saved.baseUrl)

  const envKey = envApiKey()
  const envBase = envBaseUrl()
  const envProviderValue = envText(ENV_PROVIDER)
  const envModelValue = envText(ENV_MODEL)

  const apiKey = saved === null ? envKey : savedKey
  const apiKeySource: ApiKeySource =
    apiKey.length === 0 ? 'none' : saved === null ? 'environment' : 'saved'

  const provider = savedProvider.length > 0 ? savedProvider : envProvider()
  const providerSource: SettingsSource =
    savedProvider.length > 0 ? 'saved' : envProviderValue.length > 0 ? 'environment' : 'default'

  const model = savedModel.length > 0 ? savedModel : envModel()
  const modelSource: SettingsSource =
    savedModel.length > 0 ? 'saved' : envModelValue.length > 0 ? 'environment' : 'default'

  const baseUrl = saved === null ? envBase : savedBaseUrl
  const baseUrlSource: SettingsSource =
    saved === null ? (envBase.length > 0 ? 'environment' : 'default') : 'saved'

  const storedConcurrency = saved === null ? undefined : saved.modelConcurrency
  let modelConcurrency = envModelConcurrency()
  let concurrencySource: SettingsSource =
    process.env.LIEBIAN_MODEL_CONCURRENCY === undefined ? 'default' : 'environment'
  if (storedConcurrency !== undefined) {
    try {
      modelConcurrency = parseModelConcurrency(storedConcurrency, envModelConcurrency())
      concurrencySource = 'saved'
    } catch {
      // A hand-edited bad value falls back to the environment, then to 4.
    }
  }

  const storedMaxTokens = saved === null ? undefined : saved.modelMaxTokens
  let modelMaxTokens = envModelMaxTokens()
  let maxTokensSource: SettingsSource =
    (process.env.LIEBIAN_MODEL_MAX_TOKENS ?? '').trim().length === 0 ? 'default' : 'environment'
  if (storedMaxTokens !== undefined) {
    try {
      modelMaxTokens = parseModelMaxTokens(storedMaxTokens, envModelMaxTokens())
      maxTokensSource = 'saved'
    } catch {
      // A hand-edited bad value falls back to the environment, then to the default.
    }
  }

  const storedThinking = saved === null ? undefined : saved.modelThinking
  let modelThinking = envModelThinking()
  let thinkingSource: SettingsSource =
    (process.env.LIEBIAN_MODEL_THINKING ?? '').trim().length === 0 ? 'default' : 'environment'
  if (storedThinking !== undefined) {
    try {
      modelThinking = parseModelThinking(storedThinking, envModelThinking())
      thinkingSource = 'saved'
    } catch {
      // Same fallback chain as above.
    }
  }

  return {
    settings: { apiKey, provider, model, baseUrl, modelConcurrency, modelMaxTokens, modelThinking },
    sources: {
      apiKey: apiKeySource,
      provider: providerSource,
      model: modelSource,
      baseUrl: baseUrlSource,
      modelConcurrency: concurrencySource,
      modelMaxTokens: maxTokensSource,
      modelThinking: thinkingSource,
    },
    savedOverride,
  }
}

/** Effective settings only; see {@link resolveWebSettings} for provenance. */
export async function loadWebSettings(tasksRoot: string): Promise<WebSettings> {
  return (await resolveWebSettings(tasksRoot)).settings
}

/** Saved settings take precedence; environment is the fallback. */
export async function effectiveWebSettings(tasksRoot: string): Promise<WebSettings> {
  return loadWebSettings(tasksRoot)
}

export async function saveWebSettings(tasksRoot: string, settings: WebSettings): Promise<void> {
  const file = settingsFile(tasksRoot)
  const modelConcurrency = parseModelConcurrency(settings.modelConcurrency)
  const modelMaxTokens = parseModelMaxTokens(settings.modelMaxTokens)
  const modelThinking = parseModelThinking(settings.modelThinking)
  await writeFileAtomic(
    file,
    `${JSON.stringify({ ...settings, modelConcurrency, modelMaxTokens, modelThinking }, null, 2)}\n`,
  )
  await chmod(file, 0o600).catch(() => undefined)
}

/** Drop the saved override so the environment applies again. */
export async function clearWebSettings(tasksRoot: string): Promise<void> {
  await rm(settingsFile(tasksRoot), { force: true })
}

export function publicWebSettings(resolved: ResolvedWebSettings): PublicWebSettings {
  const { settings, sources, savedOverride } = resolved
  return {
    apiKeySet: settings.apiKey.length > 0,
    apiKeySource: sources.apiKey,
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    modelConcurrency: settings.modelConcurrency,
    modelMaxTokens: settings.modelMaxTokens,
    modelThinking: settings.modelThinking,
    sources,
    savedOverride,
  }
}

/** Human-readable label for a source, used by the Web UI hints. */
export function sourceLabel(source: SettingsSource | 'none'): string {
  switch (source) {
    case 'saved':
      return '已保存'
    case 'environment':
      return '环境变量'
    case 'none':
      return '未配置'
    default:
      return '默认值'
  }
}
