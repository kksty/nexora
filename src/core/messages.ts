/** Message filtering helpers. Messages are stored in append order. */

import type { MessageRecord, RuntimeState } from '../types.ts'

/** Messages that have not yet entered the recipient's context. */
export function pendingMessages(state: RuntimeState, workId: string): MessageRecord[] {
  return state.messages.filter((message) => message.toWorkId === workId && message.status === 'pending')
}

/** Pending agent-to-agent messages (runtime notices do not block completion). */
export function pendingUserMessages(state: RuntimeState, workIds: readonly string[]): MessageRecord[] {
  const wanted = new Set(workIds)
  return state.messages.filter(
    (message) => !message.system && message.status === 'pending' && wanted.has(message.toWorkId),
  )
}

/** Messages a work can still read from its inbox. */
export function inboxMessages(
  state: RuntimeState,
  workId: string,
  options: { includeDelivered?: boolean; includeSystem?: boolean; limit?: number },
): MessageRecord[] {
  const includeDelivered = options.includeDelivered ?? false
  const includeSystem = options.includeSystem ?? true
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  return state.messages
    .filter((message) => message.toWorkId === workId)
    .filter((message) => includeSystem || !message.system)
    .filter((message) => message.status === 'pending' || (includeDelivered && message.status === 'delivered'))
    .slice(-limit)
}
