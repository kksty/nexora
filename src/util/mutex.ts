/**
 * A tiny async mutex.
 *
 * The runtime is the single writer for a task directory. Every state mutation
 * runs through one mutex, which is what makes "append a finding" and "commit a
 * completion" atomic with respect to each other: a last agreement vote and a
 * new discovery can never interleave inside the commit check.
 */

export class Mutex {
  private tail: Promise<void> = Promise.resolve()

  /** Run `fn` after every previously queued operation settled. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn, fn)
    // Keep the queue alive even when `fn` rejects; the rejection belongs to the
    // caller that queued it.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
