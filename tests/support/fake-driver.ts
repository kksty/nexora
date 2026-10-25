/**
 * Test-only harness driver.
 *
 * It implements the same narrow seam as the real SDK driver so runtime
 * behaviour can be exercised deterministically without model calls. It is not
 * a second harness integration: no production code path constructs it.
 */

import type { EnsureResult, HarnessDriver, PromptReceipt, WorkSessionSpec } from '../../src/harness/driver.ts'
import type { ActivityEvent } from '../../src/types.ts'
import { AppError } from '../../src/util/errors.ts'

interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
}

export class FakeDriver implements HarnessDriver {
  autoFinish = true
  generation = 1
  /** Session-log events to replay when a persisted session is resumed. */
  replay: ActivityEvent[] = []
  onActivity?: (workId: string, events: ActivityEvent[]) => void
  readonly prompts: { workId: string; text: string }[] = []
  readonly receipts: Map<string, string> = new Map()
  readonly ensures: { workId: string; sessionStarted: boolean }[] = []
  readonly stops: string[] = []
  readonly alive = new Set<string>()
  onUnexpectedExit?: (workId: string, reason: string) => void

  private readonly waiters = new Map<string, Waiter[]>()
  private readonly sessionIds = new Map<string, string>()
  private readonly finished = new Set<string>()
  private nextEnsureFailure: Error | undefined
  private readonly nextPromptFailures: Error[] = []
  private messageCounter = 0

  failNextEnsure(error: Error = new AppError('HARNESS_START_FAILED', '模拟启动失败')): void {
    this.nextEnsureFailure = error
  }

  failNextPrompt(error: Error = new AppError('HARNESS_PROMPT_FAILED', '模拟请求失败')): void {
    this.nextPromptFailures.push(error)
  }

  async ensure(spec: WorkSessionSpec): Promise<EnsureResult> {
    if (this.nextEnsureFailure !== undefined) {
      const error = this.nextEnsureFailure
      this.nextEnsureFailure = undefined
      throw error
    }
    this.ensures.push({ workId: spec.workId, sessionStarted: spec.sessionStarted })
    this.sessionIds.set(spec.workId, spec.sessionId)
    this.alive.add(spec.workId)
    return {
      resumed: spec.sessionStarted,
      freshFallback: false,
      generation: this.generation,
      replay: spec.sessionStarted ? this.replay : [],
    }
  }

  async prompt(workId: string, text: string): Promise<PromptReceipt> {
    const failure = this.nextPromptFailures.shift()
    if (failure !== undefined) throw failure
    this.prompts.push({ workId, text })
    const messageId = `fake-message-${++this.messageCounter}`
    this.receipts.set(workId, messageId)
    return { messageId }
  }

  async waitForIdle(workId: string): Promise<void> {
    if (this.autoFinish) return
    if (this.finished.delete(workId)) return
    await new Promise<void>((resolve, reject) => {
      const list = this.waiters.get(workId) ?? []
      list.push({ resolve, reject })
      this.waiters.set(workId, list)
    })
  }

  async quiesce(): Promise<void> {
    // Synchronous fake callbacks need no transport barrier.
  }

  async stop(workId: string): Promise<void> {
    this.stops.push(workId)
    this.alive.delete(workId)
    const list = this.waiters.get(workId)
    if (list !== undefined) {
      this.waiters.delete(workId)
      for (const waiter of list) waiter.reject(new AppError('HARNESS_EXITED', `work ${workId} 的 harness 已停止`))
    }
  }

  async stopAll(): Promise<void> {
    for (const workId of this.alive) {
      this.stops.push(workId)
      const list = this.waiters.get(workId)
      if (list !== undefined) {
        this.waiters.delete(workId)
        for (const waiter of list) waiter.reject(new AppError('HARNESS_EXITED', 'harness 已停止'))
      }
    }
    this.alive.clear()
  }

  /** Finish the current turn of a work when `autoFinish` is disabled. */
  finishTurn(workId: string): void {
    const list = this.waiters.get(workId)
    if (list !== undefined && list.length > 0) {
      this.waiters.delete(workId)
      for (const waiter of list) waiter.resolve()
      return
    }
    this.finished.add(workId)
  }

  promptsFor(workId: string): string[] {
    return this.prompts.filter((prompt) => prompt.workId === workId).map((prompt) => prompt.text)
  }

  lastPrompt(workId: string): string {
    const texts = this.promptsFor(workId)
    return texts.at(-1) ?? ''
  }

  // -------------------------------------------------------------------------
  // Activity simulation (same normalized shape as the real SDK driver)
  // -------------------------------------------------------------------------

  emit(workId: string, events: ActivityEvent[]): void {
    this.onActivity?.(workId, events)
  }

  emitStatus(workId: string, status: 'idle' | 'running'): void {
    this.emit(workId, [
      {
        kind: 'status',
        sessionId: this.sessionIdFor(workId),
        generation: this.generation,
        at: new Date().toISOString(),
        status,
      },
    ])
  }

  emitToolCall(
    workId: string,
    input: { callId: string; name: string; arguments?: string; turn?: number; step?: number },
  ): void {
    this.emit(workId, [
      {
        kind: 'tool-call',
        sessionId: this.sessionIdFor(workId),
        generation: this.generation,
        seq: this.nextSeq(),
        at: new Date().toISOString(),
        callId: input.callId,
        name: input.name,
        ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
        turn: input.turn ?? 1,
        step: input.step ?? 1,
      },
    ])
  }

  emitToolResult(workId: string, callId: string, isError = false): void {
    this.emit(workId, [
      {
        kind: 'tool-result',
        sessionId: this.sessionIdFor(workId),
        generation: this.generation,
        seq: this.nextSeq(),
        at: new Date().toISOString(),
        callId,
        isError,
      },
    ])
  }

  emitJobRegistered(
    workId: string,
    input: {
      jobId: string
      jobKind?: string
      label?: string
      toolCallId?: string
      rootToolCallId?: string
    },
  ): void {
    this.emit(workId, [
      {
        kind: 'job-registered',
        sessionId: this.sessionIdFor(workId),
        generation: this.generation,
        seq: this.nextSeq(),
        at: new Date().toISOString(),
        jobId: input.jobId,
        jobKind: input.jobKind ?? 'bash',
        label: input.label ?? input.jobId,
        ownerSessionId: this.sessionIdFor(workId),
        startedAt: new Date().toISOString(),
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
        ...(input.rootToolCallId === undefined ? {} : { rootToolCallId: input.rootToolCallId }),
      },
    ])
  }

  emitJobSettled(
    workId: string,
    input: {
      jobId: string
      status?: 'completed' | 'killed' | 'failed'
      jobKind?: string
      label?: string
      toolCallId?: string
      rootToolCallId?: string
      detail?: string
    },
  ): void {
    this.emit(workId, [
      {
        kind: 'job-settled',
        sessionId: this.sessionIdFor(workId),
        generation: this.generation,
        seq: this.nextSeq(),
        at: new Date().toISOString(),
        jobId: input.jobId,
        jobKind: input.jobKind ?? 'bash',
        label: input.label ?? input.jobId,
        ownerSessionId: this.sessionIdFor(workId),
        startedAt: new Date().toISOString(),
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
        ...(input.rootToolCallId === undefined ? {} : { rootToolCallId: input.rootToolCallId }),
        status: input.status ?? 'completed',
        cause: 'producer',
        producerReported: true,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        finishedAt: new Date().toISOString(),
      },
    ])
  }

  emitUserMessage(
    workId: string,
    input: { messageId?: string; sourceKind?: string; form?: string; text?: string },
  ): void {
    this.emit(workId, [
      {
        kind: 'user-message',
        sessionId: this.sessionIdFor(workId),
        generation: this.generation,
        seq: this.nextSeq(),
        at: new Date().toISOString(),
        messageId: input.messageId ?? this.receipts.get(workId) ?? 'unknown',
        ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
        ...(input.form === undefined ? {} : { form: input.form }),
        ...(input.text === undefined ? {} : { text: input.text }),
      },
    ])
  }

  private seq = 0

  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  private sessionIdFor(workId: string): string {
    return this.sessionIds.get(workId) ?? `session-${workId}`
  }
}
