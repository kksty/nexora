import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../util/errors.ts'

/** Success means an authenticated request reached this runtime, not merely docker up. */
export async function waitForRuntimeReady(options: {
  timeoutMs: number
  intervalMs?: number
  running: () => Promise<boolean>
  probe: () => Promise<{ pid: number } | null>
}): Promise<{ pid: number }> {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    if (!(await options.running())) {
      throw new AppError('TASK_START_FAILED', '任务容器在运行时就绪前退出')
    }
    const ready = await options.probe()
    if (ready !== null && Number.isInteger(ready.pid) && ready.pid > 0) return ready
    await sleep(Math.min(options.intervalMs ?? 300, Math.max(0, deadline - Date.now())))
  }
  throw new AppError('TASK_START_TIMEOUT', `等待任务运行时就绪超时（${options.timeoutMs}ms）`)
}

export function taskStartTimeout(): number {
  const raw = process.env.LIEBIAN_TASK_START_TIMEOUT_MS ?? '60000'
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1000 || value > 300000) {
    throw new AppError('INVALID_ARGUMENT', 'LIEBIAN_TASK_START_TIMEOUT_MS 必须为 1000–300000 毫秒')
  }
  return value
}
