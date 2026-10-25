/**
 * Time formatting for runtime-generated fields.
 *
 * Timestamps in shared Markdown use the local wall clock with an explicit UTC
 * offset (for example `2026-10-21T10:20:00+08:00`) so that every record is both
 * human-readable and unambiguous. The runtime never depends on parsing these
 * strings back; ordering uses the monotonic counters instead.
 */

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** Format a Date as `YYYY-MM-DDTHH:mm:ss±HH:MM` in the host's local time zone. */
export function formatIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** Current local time as an ISO string with offset. */
export function nowIso(): string {
  return formatIso(new Date())
}

/** Compact local timestamp for task directory names (`20261021-102000`). */
export function compactStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** Add milliseconds to an ISO timestamp; used for retry scheduling records. */
export function plusMs(iso: string, ms: number): string {
  const parsed = Date.parse(iso)
  return formatIso(new Date((Number.isNaN(parsed) ? Date.now() : parsed) + ms))
}
