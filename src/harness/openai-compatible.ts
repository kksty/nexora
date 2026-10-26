/**
 * Small, project-owned OpenAI Chat Completions adapter.
 *
 * This intentionally does not use llm-pi-ai. That adapter treats apiKeyEnv as
 * a required credential reference and rejects an empty value before fetch;
 * local vLLM and Ollama deployments commonly accept requests without auth.
 * The route reads the current task environment at request time and omits the
 * Authorization header entirely when the configured key is empty.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  attributionHeaders,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { OPENAI_COMPATIBLE_ROUTE, FALLBACK_CONTEXT_WINDOW, envModelPolicy, thinkingAdapter } from '../util/model-limits.ts'

export const name = 'liebian-openai-compatible'
export const inject = ['llm']

interface OpenAIChunk {
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  id?: string
}

interface ToolState {
  id: string
  name: string
  arguments: string
  index: number
  started: boolean
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function baseUrl(): string {
  const value = (process.env.LIEBIAN_BASE_URL ?? '').trim().replace(/\/+$/, '')
  if (value.length === 0) throw new LlmError('OpenAI-compatible provider needs LIEBIAN_BASE_URL', 'INVALID_CONFIG')
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return [block.text]
    if (block.type === 'file') return [`[file: ${block.attachment.name}]`]
    if (block.type === 'image') return [`[image: ${block.attachment.name}]`]
    return []
  }).join('')
}

function assistantParts(message: RequestMessage): { content: string; toolCalls: unknown[] } {
  const toolCalls: unknown[] = []
  const content: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'reasoning') content.push(block.text)
    if (block.type === 'tool-call') {
      toolCalls.push({
        id: String(block.id),
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
      })
    }
  }
  return { content: content.join(''), toolCalls }
}

function messagesForOpenAI(options: GenerateOptions): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  if (options.system !== undefined && options.system.length > 0) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    switch (message.role) {
      case 'system':
        messages.push({ role: 'system', content: textOf(message.content) })
        break
      case 'developer':
        messages.push({ role: 'system', content: textOf(message.content) })
        break
      case 'user':
        messages.push({ role: 'user', content: textOf(message.content) })
        break
      case 'assistant': {
        const parts = assistantParts(message)
        messages.push({
          role: 'assistant',
          content: parts.content.length > 0 ? parts.content : null,
          ...(parts.toolCalls.length > 0 ? { tool_calls: parts.toolCalls } : {}),
        })
        break
      }
      case 'tool':
        messages.push({ role: 'tool', tool_call_id: String(message.toolCallId), content: textOf(message.content) })
        break
    }
  }
  return messages
}

function toolSchemas(tools: readonly ToolSchema[] | undefined): unknown[] | undefined {
  if (tools === undefined) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

function finishReason(value: string | null | undefined): { kind: 'stop' | 'tool-calls' | 'max-tokens' } {
  if (value === 'tool_calls' || value === 'function_call') return { kind: 'tool-calls' }
  if (value === 'length' || value === 'max_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

function responseError(status: number, body: string): LlmError {
  let detail = body.trim().replace(/\s+/g, ' ').slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    if (typeof parsed.error === 'string') detail = parsed.error
    else if (parsed.error?.message) detail = parsed.error.message
    else if (parsed.message) detail = parsed.message
  } catch { /* retain bounded raw response */ }
  const code = status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
  return new LlmError(`OpenAI-compatible HTTP ${status}${detail ? `: ${detail}` : ''}`, code, { status })
}

function requestBody(options: GenerateOptions, adapter: ModelAdapter): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: messagesForOpenAI(options),
    stream: true,
    max_tokens: options.maxTokens ?? adapter.maxTokens,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.stop !== undefined) body.stop = options.stop
  const tools = toolSchemas(options.tools)
  if (tools !== undefined && tools.length > 0) body.tools = tools
  if (adapter.thinking === 'dashscope') body.enable_thinking = options.reasoningEffort !== 'off'
  if (adapter.thinking === 'vllm') body.chat_template_kwargs = { enable_thinking: options.reasoningEffort !== 'off', preserve_thinking: true }
  return body
}

class ModelAdapter extends LlmAdapter {
  readonly maxTokens: number
  readonly contextWindow: number
  readonly thinking: 'dashscope' | 'vllm' | 'none'

  constructor(maxTokens: number, contextWindow: number, thinking: 'dashscope' | 'vllm' | 'none') {
    super()
    this.maxTokens = maxTokens
    this.contextWindow = contextWindow
    this.thinking = thinking
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenAI-compatible (keyless supported)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const model = (process.env.LIEBIAN_MODEL ?? '').trim()
    return Promise.resolve(model ? [{ provider, id: model, name: model, inputModalities: ['text'] }] : [])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: this.contextWindow },
      defaultMaxTokens: this.maxTokens,
      reasoning: {
        efforts: ['off', 'low', 'high', 'max'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId((process.env.LIEBIAN_MODEL_THINKING ?? 'high').trim()),
      },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const controller = new AbortController()
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
    const headers: Record<string, string> = { ...attributionHeaders(), accept: 'text/event-stream', 'content-type': 'application/json' }
    const key = (process.env.LIEBIAN_API_KEY ?? '').trim()
    if (key.length > 0) headers.authorization = `Bearer ${key}`
    let response: Response
    try {
      response = await fetch(baseUrl(), { method: 'POST', headers, body: JSON.stringify(requestBody(options, this)), signal })
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('OpenAI-compatible request aborted', 'ABORTED', { cause: error })
      throw new LlmError('OpenAI-compatible transport failed', 'TRANSPORT', { cause: error })
    }
    if (!response.ok) throw responseError(response.status, await response.text().catch(() => ''))
    if (response.body === null) throw new LlmError('OpenAI-compatible response has no body', 'STREAM_CLOSED')

    const textIndexes = new Set<number>()
    const reasoningIndexes = new Set<number>()
    const textBlocks = new Map<number, string>()
    const reasoningBlocks = new Map<number, string>()
    const toolStates = new Map<number, ToolState>()
    let nextTextIndex = 0
    let finalReason: { kind: 'stop' | 'tool-calls' | 'max-tokens' } = { kind: 'stop' }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const emitLine = async function* (line: string): AsyncIterable<StreamChunk> {
      const value = line.startsWith('data:') ? line.slice(5).trim() : ''
      if (value.length === 0 || value === '[DONE]') return
      let chunk: OpenAIChunk
      try { chunk = JSON.parse(value) as OpenAIChunk } catch { return }
      if (chunk.usage !== undefined && typeof chunk.usage.prompt_tokens === 'number' && typeof chunk.usage.completion_tokens === 'number') {
        yield { type: 'usage', usage: { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, ...(typeof chunk.usage.total_tokens === 'number' ? { totalTokens: chunk.usage.total_tokens } : {}) } }
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {}
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finalReason = finishReason(choice.finish_reason)
        const visible = delta.content ?? ''
        if (visible.length > 0) {
          if (!textIndexes.has(nextTextIndex)) { textIndexes.add(nextTextIndex); yield { type: 'block-start', index: nextTextIndex, blockType: 'text' } }
          textBlocks.set(nextTextIndex, `${textBlocks.get(nextTextIndex) ?? ''}${visible}`)
          yield { type: 'text-delta', index: nextTextIndex, text: visible }
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? ''
        if (reasoning.length > 0) {
          const index = 1
          if (!reasoningIndexes.has(index)) { reasoningIndexes.add(index); yield { type: 'block-start', index, blockType: 'reasoning' } }
          reasoningBlocks.set(index, `${reasoningBlocks.get(index) ?? ''}${reasoning}`)
          yield { type: 'reasoning-delta', index, text: reasoning }
        }
        for (const call of delta.tool_calls ?? []) {
          const sourceIndex = call.index ?? 0
          const index = 10 + sourceIndex
          let state = toolStates.get(sourceIndex)
          if (state === undefined) {
            state = { id: call.id ?? `tool-call-${sourceIndex}`, name: call.function?.name ?? '', arguments: '', index, started: false }
            toolStates.set(sourceIndex, state)
          }
          if (!state.started) { state.started = true; yield { type: 'block-start', index, blockType: 'tool-call' } }
          if (call.id) state.id = call.id
          if (call.function?.name) state.name = call.function.name
          const args = call.function?.arguments ?? ''
          if (args.length > 0) { state.arguments += args; yield { type: 'tool-call-delta', index, id: ToolCallId(state.id), ...(state.name ? { name: state.name } : {}), argumentsDelta: args } }
        }
      }
    }
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        buffer += decoder.decode(part.value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) yield* emitLine(line)
      }
      if (buffer.length > 0) yield* emitLine(buffer)
    } finally {
      reader.releaseLock()
      controller.abort()
    }
    for (const index of reasoningIndexes) yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoningBlocks.get(index) ?? '' } }
    for (const index of textIndexes) yield { type: 'block-end', index, block: { type: 'text', text: textBlocks.get(index) ?? '' } }
    for (const state of toolStates.values()) yield { type: 'block-end', index: state.index, block: { type: 'tool-call', id: ToolCallId(state.id), name: state.name, arguments: state.arguments } }
    yield { type: 'finish', reason: finalReason }
  }
}

export function apply(ctx: Context): void {
  const policy = envModelPolicy()
  const url = (process.env.LIEBIAN_BASE_URL ?? '').trim()
  const thinking = thinkingAdapter({ modelThinkingAdapter: policy.modelThinkingAdapter, baseUrl: url })
  const adapter = new ModelAdapter(policy.modelMaxTokens, policy.modelContextWindow || FALLBACK_CONTEXT_WINDOW, thinking)
  const registration = ctx.llm.registerAdapter([OPENAI_COMPATIBLE_ROUTE], adapter)
  ctx.effect(() => registration)
}

