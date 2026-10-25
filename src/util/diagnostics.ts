/**
 * Bounded, rotating JSONL diagnostics. Never participates in task correctness.
 * One writer per task is guaranteed by ownership; offline edits use another file.
 */
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function positiveSetting(value: string | undefined, fallback: number, max = 1_000_000_000): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback
}

export function redactDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]'
  if (typeof value === 'string') {
    let text = value.slice(0, 4096)
    for (const [key, secret] of Object.entries(process.env)) {
      if (/API_KEY|TOKEN|PASSWORD|SECRET/i.test(key) && secret && secret.length >= 8) text = text.split(secret).join('[redacted]')
    }
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/([?&](?:api_key|key|token|password)=)[^&\s]+/gi, '$1[redacted]')
      .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1[redacted]@')
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactDiagnostic(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      out[key] = /^(authorization|cookie|password|secret|api[_-]?key|token|access[_-]?token|daemonToken)$/i.test(key)
        ? '[redacted]' : redactDiagnostic(item, depth + 1)
    }
    return out
  }
  return value
}

export interface DiagnosticOptions {
  maxBytes?: number
  files?: number
  maxQueueBytes?: number
  warn?: (message: string) => void
}

export class DiagnosticLog {
  readonly bootId = randomUUID()
  private sequence = 0
  private queue: string[] = []
  private queuedBytes = 0
  private dropped = 0
  private failedWrites = 0
  private written = 0
  private bytes: number | undefined
  private running: Promise<void> | undefined
  private warned = false
  private readonly maxBytes: number
  private readonly files: number
  private readonly maxQueueBytes: number
  private readonly file: string
  private readonly base: Record<string, unknown>
  private readonly warn: (message: string) => void

  constructor(file: string, base: Record<string, unknown>, options: DiagnosticOptions = {}) {
    this.file = file
    this.base = base
    this.maxBytes = options.maxBytes ?? positiveSetting(process.env.LIEBIAN_DIAGNOSTICS_MAX_BYTES, 16 * 1024 * 1024)
    this.files = options.files ?? positiveSetting(process.env.LIEBIAN_DIAGNOSTICS_FILES, 8, 64)
    this.maxQueueBytes = options.maxQueueBytes ?? 4 * 1024 * 1024
    this.warn = options.warn ?? ((message) => process.stderr.write(message + '\n'))
  }

  get stats(): Record<string, number> {
    return { queuedBytes: this.queuedBytes, dropped: this.dropped, failedWrites: this.failedWrites, written: this.written }
  }

  record(event: string, data: Record<string, unknown> = {}): void {
    try {
      const line = JSON.stringify({
        schema: 1, at: new Date().toISOString(), monoMs: performance.now(),
        bootId: this.bootId, seq: ++this.sequence, pid: process.pid,
        ...this.base, event, data: redactDiagnostic(data),
        dropped: this.dropped, failedWrites: this.failedWrites,
      }) + '\n'
      const size = Buffer.byteLength(line)
      if (size > this.maxBytes || this.queuedBytes + size > this.maxQueueBytes) {
        this.dropped += 1
        this.warning('诊断日志队列已满或单条过大，丢弃计数会写入后续记录')
        return
      }
      this.queue.push(line)
      this.queuedBytes += size
      this.pump()
    } catch {
      this.dropped += 1
    }
  }

  private warning(message: string): void {
    if (this.warned) return
    this.warned = true
    try { this.warn(message) } catch { /* diagnostics cannot stop execution */ }
  }

  private pump(): void {
    if (this.running !== undefined) return
    this.running = this.drain().finally(() => {
      this.running = undefined
      if (this.queue.length > 0) this.pump()
    })
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const line = this.queue.shift()!
      const size = Buffer.byteLength(line)
      try {
        await mkdir(dirname(this.file), { recursive: true })
        if (this.bytes === undefined) {
          this.bytes = await stat(this.file).then((info) => info.size).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return 0
            throw error
          })
          // A hard kill may leave a partial last line. An explicit newline keeps
          // subsequent records parseable; readers count malformed lines.
          if (this.bytes > 0) { await appendFile(this.file, '\n'); this.bytes += 1 }
        }
        if (this.bytes + size > this.maxBytes) await this.rotate()
        await appendFile(this.file, line, 'utf8')
        this.bytes += size
        this.written += 1
        this.warned = false
      } catch {
        this.failedWrites += 1
        this.dropped += 1
        this.bytes = undefined
        this.warning('诊断日志写入失败，运行继续；失败和丢弃计数会写入后续记录')
      } finally {
        this.queuedBytes -= size
      }
    }
  }

  private async rotate(): Promise<void> {
    if (this.files === 1) await rm(this.file, { force: true })
    else {
      await rm(this.file + '.' + (this.files - 1), { force: true })
      for (let n = this.files - 2; n >= 0; n -= 1) {
        const from = n === 0 ? this.file : this.file + '.' + n
        await rename(from, this.file + '.' + (n + 1)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    }
    this.bytes = 0
  }

  async flush(): Promise<void> {
    while (this.running !== undefined) await this.running
  }
}

/** Metadata only; raw prompts, tool arguments and credentials stay out of this stream. */
export function activityDiagnostic(event: Record<string, unknown>): Record<string, unknown> {
  const fields = ['kind', 'sessionId', 'generation', 'seq', 'at', 'turn', 'step', 'callId', 'name',
    'jobId', 'jobKind', 'status', 'isError', 'cause', 'messageId', 'sourceKind', 'form', 'sourceGeneration']
  const out: Record<string, unknown> = {}
  for (const key of fields) if (event[key] !== undefined) out[key] = event[key]
  if (typeof event.arguments === 'string') out.argumentBytes = Buffer.byteLength(event.arguments)
  if (typeof event.text === 'string') out.textBytes = Buffer.byteLength(event.text)
  if (Array.isArray(event.terminals)) out.terminalIds = event.terminals.map((t) => t.id)
  return out
}

