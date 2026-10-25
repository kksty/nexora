/** Errors that cross the runtime boundary carry a stable machine-readable code. */

export class AppError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

/** Convert an unknown thrown value into a readable message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === undefined ? error.message : `${error.message} (${code})`
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

/** Convert an unknown thrown value into an AppError, preserving known codes. */
export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  return new AppError('INTERNAL_ERROR', describeError(error))
}

/** Build a structured error payload for the HTTP and MCP boundaries. */
export function errorPayload(error: unknown): { code: string; message: string; details?: unknown } {
  const appError = asAppError(error)
  const payload: { code: string; message: string; details?: unknown } = {
    code: appError.code,
    message: appError.message,
  }
  if (appError.details !== undefined) payload.details = appError.details
  return payload
}
