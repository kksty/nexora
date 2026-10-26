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

export const DEFAULT_MODEL_MAX_TOKENS = 32_000
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
