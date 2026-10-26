/**
 * Model response size limits shared by the harness patch and the Web UI.
 *
 * The harness SDK defaults the per-response output budget to the official
 * DeepSeek ceiling (256000). Third-party OpenAI/Anthropic-compatible gateways
 * often cap far lower, and some answer an oversized `max_tokens` with an empty
 * turn (`output_tokens: 0`, no content blocks) instead of an error - which the
 * harness surfaces as EMPTY_RESPONSE, so the executor silently does nothing.
 *
 * A conservative default keeps the request inside any plausible ceiling while
 * staying far above what one tool call needs.
 */
import { AppError } from './errors.ts'

export const DEFAULT_MODEL_MAX_TOKENS = 6_144
/** Previous built-in output limit; retained so legacy DeepSeek settings keep working. */
export const LEGACY_DEFAULT_MODEL_MAX_TOKENS = 32_000
/** Guard against typos such as an extra zero. */
export const MAX_MODEL_MAX_TOKENS = 1_000_000

export function parseModelMaxTokens(value: unknown, fallback = DEFAULT_MODEL_MAX_TOKENS): number {
  if (value === undefined || value === null || value === '') return fallback
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^[1-9]\d*$/.test(text)) {
    throw new AppError('INVALID_ARGUMENT', `单次响应输出上限必须是正整数：${String(value)}`)
  }
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed > MAX_MODEL_MAX_TOKENS) {
    throw new AppError('INVALID_ARGUMENT', `单次响应输出上限超出范围（1-${MAX_MODEL_MAX_TOKENS}）：${String(value)}`)
  }
  return parsed
}

/** Environment value, falling back to the default when unset or malformed. */
export function envModelMaxTokens(): number {
  try {
    return parseModelMaxTokens(process.env.LIEBIAN_MODEL_MAX_TOKENS)
  } catch {
    return DEFAULT_MODEL_MAX_TOKENS
  }
}

/**
 * Reasoning ("thinking") intensity for one model request.
 *
 * `off` sends `thinking: disabled`; the other levels send `thinking: enabled`
 * plus an effort hint. Whether a level actually changes anything is up to the
 * model and the gateway: many models ignore the effort hint entirely, and a few
 * return an empty response when thinking is switched off. The hint is therefore
 * a preference, not a guarantee.
 */
export const MODEL_THINKING_LEVELS = ['off', 'low', 'high', 'max'] as const
export type ModelThinking = (typeof MODEL_THINKING_LEVELS)[number]

/** Keep the SDK's own default so behaviour does not change silently. */
export const DEFAULT_MODEL_THINKING: ModelThinking = 'high'

export function isModelThinking(value: unknown): value is ModelThinking {
  return typeof value === 'string' && (MODEL_THINKING_LEVELS as readonly string[]).includes(value)
}

export function parseModelThinking(value: unknown, fallback = DEFAULT_MODEL_THINKING): ModelThinking {
  if (value === undefined || value === null || value === '') return fallback
  if (isModelThinking(value)) return value
  // Accept the shapes people type by hand.
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'on' || text === 'enabled' || text === 'true') return 'high'
  if (text === 'disabled' || text === 'false' || text === 'none') return 'off'
  throw new AppError(
    'INVALID_ARGUMENT',
    `思考强度只能是 ${MODEL_THINKING_LEVELS.join(' / ')}：${String(value)}`,
  )
}

export function envModelThinking(): ModelThinking {
  try {
    return parseModelThinking(process.env.LIEBIAN_MODEL_THINKING)
  } catch {
    return DEFAULT_MODEL_THINKING
  }
}

export type ModelApiProtocol = 'deepseek' | 'openai-compatible'
export type ModelThinkingAdapter = 'auto' | 'dashscope' | 'vllm' | 'none'
export const OPENAI_COMPATIBLE_ROUTE = 'liebian-openai-compatible'
export const FALLBACK_CONTEXT_WINDOW = 32_768
export interface ModelPolicy {
  modelApiProtocol: ModelApiProtocol
  modelContextWindow: number
  modelAutoCompactRatio: number
  modelSafetyMarginTokens: number
  modelThinkingAdapter: ModelThinkingAdapter
  modelMaxTokens: number
  modelThinking: ModelThinking
}
export type ContextBudgetSource = 'declared' | 'deepseek-catalog' | 'server-metrics' | 'fallback'
export interface ContextBudgetStatus {
  contextWindowEffective: number
  contextWindowKnown: boolean
  contextWindowSource: ContextBudgetSource
  requiresServerConfirmation: boolean
  contextWindowWarning: string
  autoCompactTriggerTokens: number
}

function budgetForWindow(
  s: ModelPolicy,
  effective: number,
  known: boolean,
  source: ContextBudgetSource,
): ContextBudgetStatus {
  const available = effective - s.modelMaxTokens - s.modelSafetyMarginTokens
  return {
    contextWindowEffective: effective,
    contextWindowKnown: known,
    contextWindowSource: source,
    requiresServerConfirmation: !known,
    contextWindowWarning: !known
      ? '上下文窗口未知：客户端 fallback 为 32768，仍需确认服务端窗口（Ollama 可能仅 4096）。请手填已确认窗口；vLLM max_model_len / Ollama num_ctx 必须在服务端设置，Web 值不会改变服务端。'
      : '',
    autoCompactTriggerTokens: Math.max(0, Math.floor(Math.min(effective * s.modelAutoCompactRatio, available))),
  }
}

function choice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'string' && choices.includes(value.trim() as T)) return value.trim() as T
  throw new AppError('INVALID_ARGUMENT', `配置必须是 ${choices.join(' / ')}：${String(value)}`)
}
function integer(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback
  const raw = typeof value === 'string' ? value.trim() : String(value)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new AppError('INVALID_ARGUMENT', `${label}必须是非负整数`)
  }
  return Number(raw)
}
export const parseModelApiProtocol = (v: unknown): ModelApiProtocol => choice(v, ['deepseek', 'openai-compatible'], 'deepseek')
export const parseModelContextWindow = (v: unknown): number => integer(v, 0, '上下文窗口')
export const parseModelSafetyMarginTokens = (v: unknown): number => integer(v, 2048, '安全余量')
export const parseModelThinkingAdapter = (v: unknown): ModelThinkingAdapter => choice(v, ['auto', 'dashscope', 'vllm', 'none'], 'auto')
export function parseModelAutoCompactRatio(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0.75
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0.5 || n > 0.9) throw new AppError('INVALID_ARGUMENT', '自动压缩比例必须在 0.5–0.9 之间')
  return n
}
export const MODEL_POLICY_PARSERS = {
  modelApiProtocol: parseModelApiProtocol,
  modelContextWindow: parseModelContextWindow,
  modelAutoCompactRatio: parseModelAutoCompactRatio,
  modelSafetyMarginTokens: parseModelSafetyMarginTokens,
  modelThinkingAdapter: parseModelThinkingAdapter,
  modelMaxTokens: parseModelMaxTokens,
  modelThinking: parseModelThinking,
} as const
export const MODEL_POLICY_ENV = {
  modelApiProtocol: 'LIEBIAN_MODEL_API_PROTOCOL',
  modelContextWindow: 'LIEBIAN_MODEL_CONTEXT_WINDOW',
  modelAutoCompactRatio: 'LIEBIAN_MODEL_AUTO_COMPACT_RATIO',
  modelSafetyMarginTokens: 'LIEBIAN_MODEL_SAFETY_MARGIN_TOKENS',
  modelThinkingAdapter: 'LIEBIAN_MODEL_THINKING_ADAPTER',
  modelMaxTokens: 'LIEBIAN_MODEL_MAX_TOKENS',
  modelThinking: 'LIEBIAN_MODEL_THINKING',
} as const

export function envModelPolicy(env: NodeJS.ProcessEnv = process.env): ModelPolicy {
  return Object.fromEntries(Object.entries(MODEL_POLICY_PARSERS).map(([key, parse]) => {
    try { return [key, parse(env[MODEL_POLICY_ENV[key as keyof ModelPolicy]])] }
    catch { return [key, parse(undefined)] }
  })) as unknown as ModelPolicy
}

/** Entries in the installed dsh-llm-deepseek catalog. */
export const DEEPSEEK_CONTEXT_CATALOG = {
  'deepseek-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
} as const

export function contextBudget(s: ModelPolicy & { model?: string; baseUrl?: string; provider?: string }): ContextBudgetStatus {
  const catalogWindow = DEEPSEEK_CONTEXT_CATALOG[s.model as keyof typeof DEEPSEEK_CONTEXT_CATALOG]
  const official = s.modelApiProtocol === 'deepseek' && (s.provider ?? 'deepseek-official') === 'deepseek-official'
    && (!s.baseUrl || /^https:\/\/api\.deepseek\.com\/?$/.test(s.baseUrl))
    && catalogWindow !== undefined
  const known = s.modelContextWindow > 0 || official
  const effective = s.modelContextWindow || catalogWindow || FALLBACK_CONTEXT_WINDOW
  return budgetForWindow(
    s,
    effective,
    known,
    s.modelContextWindow > 0 ? 'declared' : official ? 'deepseek-catalog' : 'fallback',
  )
}

/** Apply a positive context window obtained from a trusted server capability endpoint. */
export function contextBudgetFromServerMetrics(s: ModelPolicy, contextWindow: number): ContextBudgetStatus {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return contextBudget(s)
  return budgetForWindow(s, contextWindow, true, 'server-metrics')
}

export function validateContextBudget(s: ModelPolicy & { model?: string; baseUrl?: string; provider?: string }): void {
  const budget = contextBudget(s)
  if (s.modelMaxTokens + s.modelSafetyMarginTokens >= budget.contextWindowEffective) {
    throw new AppError('INVALID_ARGUMENT', `输出上限 + 安全余量必须小于上下文窗口 ${budget.contextWindowEffective}。请降低输出上限，或手填已在服务端确认的窗口；未知窗口不会自动扩大。`)
  }
}

export function thinkingAdapter(s: Pick<ModelPolicy, 'modelThinkingAdapter'> & { baseUrl: string }): Exclude<ModelThinkingAdapter, 'auto'> {
  if (s.modelThinkingAdapter !== 'auto') return s.modelThinkingAdapter
  const host = new URL(s.baseUrl || 'https://api.deepseek.com').hostname
  // A private/local port can be vLLM or Ollama; guessing would send a vendor
  // field to the wrong server. Only the known DashScope hosts are safe to infer.
  return /(^|\.)dashscope(?:-intl)?\.aliyuncs\.com$/.test(host) ? 'dashscope' : 'none'
}
