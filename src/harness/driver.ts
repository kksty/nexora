/**
 * The narrow seam between the thin runtime and the chosen harness.
 *
 * Only one implementation ships (`SdkHarnessDriver`, which drives
 * `dsh --profile sdk`). The interface exists so runtime behaviour can be
 * tested deterministically without model calls, not to build a cross-harness
 * plugin layer.
 */

import type { ActivityEvent } from '../types.ts'

export interface WorkSessionSpec {
  workId: string
  sessionId: string
  /** True once at least one prompt was durably enqueued in this session. */
  sessionStarted: boolean
  /** Last session-log sequence number the runtime already projected. */
  activityCursor?: number
  taskDir: string
}

export interface EnsureResult {
  /** True when a previously persisted session was resumed. */
  resumed: boolean
  /** True when the persisted session was missing and a fresh one must be used. */
  freshFallback: boolean
  /** Harness process generation; increases whenever the process is replaced. */
  generation: number
  /**
   * Session-log events after the runtime cursor. `session/resume` deliberately
   * does not stream history, so recovery must read the persisted log itself.
   */
  replay?: ActivityEvent[]
}

/** Durable admission receipt returned by `session/prompt`. */
export interface PromptReceipt {
  /** Identity of the queued user message (enqueue only, not context entry). */
  messageId: string
}

export interface HarnessDriver {
  inspectProcesses?(): Promise<Record<string, unknown>[]>
  /** Make sure a ready harness session exists for this work. */
  ensure(spec: WorkSessionSpec): Promise<EnsureResult>
  /** Durably enqueue one user turn and return its admission receipt. */
  prompt(workId: string, text: string): Promise<PromptReceipt>
  /** Resolve when the agent has finished its current turn and is idle. */
  waitForIdle(workId: string): Promise<void>
  /**
   * Transport barrier: resolve after every notification already received has
   * been handed to the activity callback. Used before committing completion,
   * never as a substitute for checking projected activity.
   */
  quiesce(workId: string): Promise<void>
  /** Stop one work's harness process. */
  stop(workId: string): Promise<void>
  /** Stop every harness process (task completed or stopped). */
  stopAll(): Promise<void>
  /** Ordered batches of actual harness activity for one work. */
  onActivity?: (workId: string, events: ActivityEvent[]) => void
  /** Called when a harness process dies without the runtime asking it to stop. */
  onUnexpectedExit?: (workId: string, reason: string) => void
  /**
   * Called whenever a harness process exits, including an explicit stop. The
   * runtime uses it to reclaim model-request permits that can no longer be
   * released by the dead process itself.
   */
  onWorkerExit?: (workId: string, reason: string, generation?: number) => void
  /** Register identity before a resumed process can request model permits. */
  onWorkerStart?: (workId: string, generation: number) => void
}
