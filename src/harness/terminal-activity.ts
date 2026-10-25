/** Persist terminal lifetime snapshots alongside harness tools/jobs. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-terminal'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'liebian/terminals': { generation: number; terminals: { id: string; label: string }[] }
  }
}

export const name = 'liebian-terminal-activity'
export const inject = ['terminals', 'tools']

export function apply(ctx: Context): void {
  ctx.on('tools/result', (exec) => {
    if (!exec.name.startsWith('terminal_') || exec.agent === undefined) return
    // Read the actual registry even on tool failure; never infer process
    // lifetime from rendered output or from a send's idle/timeout result.
    const terminals = ctx.terminals.list(exec.agent)
      .filter((terminal) => terminal.status.kind === 'running')
      .map((terminal) => ({ id: terminal.sessionId, label: terminal.name ?? terminal.sessionId }))
    exec.agent.session.append('liebian/terminals', { generation: Number(process.env.LIEBIAN_GENERATION ?? '0'), terminals })
  })
}
