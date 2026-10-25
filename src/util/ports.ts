import type { Server } from 'node:net'
import { AppError } from './errors.ts'

export const DEFAULT_WEB_PORT = 43187
export const DEFAULT_API_PORT_RANGE = '43188-43287'

export function parsePort(value: string | number, allowZero = false): number {
  const text = String(value).trim()
  const port = Number(text)
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) {
    throw new AppError('INVALID_ARGUMENT', `非法端口：${String(value)}`)
  }
  return port
}

/** Bind directly: no check-then-bind race when several host-network tasks start. */
export async function listenInPortRange(server: Server, range: string): Promise<void> {
  const parts = range.trim().split('-')
  if (parts.length > 2) throw new AppError('INVALID_ARGUMENT', `非法 API 端口段：${range}`)
  const first = parsePort(parts[0]!, parts.length === 1)
  const last = parts.length === 1 ? first : parsePort(parts[1]!)
  if (last < first || last - first > 1000) {
    throw new AppError('INVALID_ARGUMENT', 'API 端口段必须递增且不超过 1001 个端口')
  }
  for (let port = first; port <= last; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { server.removeListener('listening', ready); reject(error) }
        const ready = (): void => { server.removeListener('error', failed); resolve() }
        server.once('error', failed)
        server.once('listening', ready)
        server.listen(port, '127.0.0.1')
      })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new AppError('PORT_RANGE_EXHAUSTED', `管理 API 端口段 ${range} 已占满，请调整 LIEBIAN_API_PORT_RANGE`)
}
