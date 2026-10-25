/**
 * Minimal structured logger.
 *
 * Runtime logs are diagnostic only; they are not part of the shared task
 * state and never enter an agent's context. Writes are chained so lines stay
 * ordered without blocking the event loop.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { formatIso } from './time.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  child(scope: string): Logger
}

export interface LoggerOptions {
  file?: string
  echo?: boolean
  level?: LogLevel
  scope?: string
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

class FileLogger implements Logger {
  private queue: Promise<void> = Promise.resolve()
  private readonly file: string | undefined
  private readonly echo: boolean
  private readonly level: LogLevel
  private readonly scope: string

  constructor(options: LoggerOptions) {
    this.file = options.file
    this.echo = options.echo ?? false
    this.level = options.level ?? 'info'
    this.scope = options.scope ?? 'runtime'
  }

  child(scope: string): Logger {
    return new FileLogger({
      file: this.file,
      echo: this.echo,
      level: this.level,
      scope: this.scope === 'runtime' ? scope : `${this.scope}/${scope}`,
    })
  }

  debug(message: string): void {
    this.write('debug', message)
  }

  info(message: string): void {
    this.write('info', message)
  }

  warn(message: string): void {
    this.write('warn', message)
  }

  error(message: string): void {
    this.write('error', message)
  }

  private write(level: LogLevel, message: string): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return
    const line = `${formatIso(new Date())} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}\n`
    if (this.echo) {
      const target = level === 'error' || level === 'warn' ? process.stderr : process.stdout
      target.write(line)
    }
    if (this.file === undefined) return
    const file = this.file
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, line, 'utf8')
      })
      .catch(() => undefined)
  }
}

/** Create a logger. With no file and no echo it becomes a no-op sink. */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new FileLogger(options)
}

/** A logger that discards everything; convenient for tests. */
export const nullLogger: Logger = createLogger({ level: 'error' })
