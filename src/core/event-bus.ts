/** An in-memory event bus backing `executor.wait`. */

import type { WorkEvent } from '../types.ts'
import { nowIso } from '../util/time.ts'

interface InternalEvent extends WorkEvent {
  targets: string[] | 'all'
}

interface Waiter {
  workId: string
  afterSeq: number
  resolve: (value: { events: WorkEvent[]; cursor: number; timedOut: boolean }) => void
  timer?: NodeJS.Timeout
}

const MAX_BUFFER = 1000

/**
 * Events are ephemeral. They wake a waiting executor inside its current turn;
 * durable shared knowledge still belongs in the findings document. After a
 * daemon restart a stale cursor simply yields future events.
 */
export class EventBus {
  private seq = 0
  private buffer: InternalEvent[] = []
  private waiters = new Set<Waiter>()

  get cursor(): number {
    return this.seq
  }

  /** Publish an event to all works or a selected set. */
  emit(targets: string[] | 'all', kind: string, text: string): WorkEvent {
    this.seq += 1
    const event: InternalEvent = { seq: this.seq, at: nowIso(), kind, text, targets }
    this.buffer.push(event)
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift()
    this.flushWaiters()
    return { seq: event.seq, at: event.at, kind: event.kind, text: event.text }
  }

  /** Resolve immediately with new matching events, or wait until one arrives. */
  wait(workId: string, afterSeq: number, timeoutMs: number): Promise<{ events: WorkEvent[]; cursor: number; timedOut: boolean }> {
    const effectiveAfter = afterSeq > this.seq ? this.seq : afterSeq
    const existing = this.collect(workId, effectiveAfter)
    if (existing.length > 0) {
      return Promise.resolve({ events: existing, cursor: this.seq, timedOut: false })
    }
    return new Promise((resolve) => {
      const waiter: Waiter = { workId, afterSeq: effectiveAfter, resolve }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve({ events: [], cursor: this.seq, timedOut: true })
      }, timeoutMs)
      waiter.timer.unref?.()
      this.waiters.add(waiter)
    })
  }

  /** Wake everyone (shutdown) without inventing state. */
  close(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve({ events: [], cursor: this.seq, timedOut: true })
    }
    this.waiters.clear()
  }

  private collect(workId: string, afterSeq: number): WorkEvent[] {
    return this.buffer
      .filter((event) => event.seq > afterSeq && (event.targets === 'all' || event.targets.includes(workId)))
      .map(({ seq, at, kind, text }) => ({ seq, at, kind, text }))
  }

  private flushWaiters(): void {
    for (const waiter of [...this.waiters]) {
      const events = this.collect(waiter.workId, waiter.afterSeq)
      if (events.length === 0) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve({ events, cursor: this.seq, timedOut: false })
    }
  }
}
