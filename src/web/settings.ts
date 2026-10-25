/**
 * Web UI-owned API settings.
 *
 * The API key is only ever returned as a boolean to the browser. The file lives
 * under the tasks root so it stays with the project's host-side data; it is
 * written atomically and chmod 600 where the filesystem supports it.
 */
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { readTextIfExists, writeFileAtomic } from '../util/atomic.ts'
import { DEFAULT_MODEL_CONCURRENCY, parseModelConcurrency } from '../util/semaphore.ts'

export interface WebSettings {
  apiKey: string
  provider: string
  model: string
  baseUrl: string
  modelConcurrency: number
}

export interface PublicWebSettings {
  apiKeySet: boolean
  provider: string
  model: string
  baseUrl: string
  modelConcurrency: number
}

const DEFAULT_PROVIDER = 'deepseek-official'
const DEFAULT_MODEL = 'deepseek-flash'

/** Provider/model may come from the host environment when not saved in the UI. */
function envProvider(): string {
  const value = (process.env.LIEBIAN_PROVIDER ?? '').trim()
  return value.length > 0 ? value : DEFAULT_PROVIDER
}

function envModel(): string {
  const value = (process.env.LIEBIAN_MODEL ?? '').trim()
  return value.length > 0 ? value : DEFAULT_MODEL
}

function envBaseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL ?? '').trim()
}

function settingsFile(tasksRoot: string): string {
  return join(tasksRoot, '.web-settings.json')
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Web UI configuration is forgiving: a bad env value falls back to 4. */
function envModelConcurrency(): number {
  try {
    return parseModelConcurrency(process.env.LIEBIAN_MODEL_CONCURRENCY)
  } catch {
    return DEFAULT_MODEL_CONCURRENCY
  }
}

function storedModelConcurrency(value: unknown): number {
  try {
    return parseModelConcurrency(value, envModelConcurrency())
  } catch {
    return envModelConcurrency()
  }
}

export async function loadWebSettings(tasksRoot: string): Promise<WebSettings> {
  const raw = await readTextIfExists(settingsFile(tasksRoot))
  if (raw === null) {
    return {
      apiKey: '',
      provider: envProvider(),
      model: envModel(),
      baseUrl: envBaseUrl(),
      modelConcurrency: envModelConcurrency(),
    }
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      apiKey: asString(parsed.apiKey),
      provider: asString(parsed.provider) || envProvider(),
      model: asString(parsed.model) || envModel(),
      baseUrl: asString(parsed.baseUrl) || envBaseUrl(),
      modelConcurrency: storedModelConcurrency(parsed.modelConcurrency),
    }
  } catch {
    return {
      apiKey: '',
      provider: envProvider(),
      model: envModel(),
      baseUrl: envBaseUrl(),
      modelConcurrency: envModelConcurrency(),
    }
  }
}

export async function saveWebSettings(tasksRoot: string, settings: WebSettings): Promise<void> {
  const file = settingsFile(tasksRoot)
  const modelConcurrency = parseModelConcurrency(settings.modelConcurrency)
  await writeFileAtomic(file, `${JSON.stringify({ ...settings, modelConcurrency }, null, 2)}\n`)
  await chmod(file, 0o600).catch(() => undefined)
}

export function publicWebSettings(settings: WebSettings): PublicWebSettings {
  return {
    apiKeySet: settings.apiKey.length > 0,
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    modelConcurrency: settings.modelConcurrency,
  }
}

/** Saved settings take precedence; environment is the fallback. */
export async function effectiveWebSettings(tasksRoot: string): Promise<WebSettings> {
  const saved = await loadWebSettings(tasksRoot)
  return {
    apiKey: saved.apiKey || process.env.DEEPSEEK_API_KEY || '',
    provider: saved.provider || process.env.LIEBIAN_PROVIDER || DEFAULT_PROVIDER,
    model: saved.model || process.env.LIEBIAN_MODEL || DEFAULT_MODEL,
    baseUrl: saved.baseUrl || process.env.DEEPSEEK_BASE_URL || '',
    modelConcurrency: saved.modelConcurrency,
  }
}
