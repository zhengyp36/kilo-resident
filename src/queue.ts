export interface QueueEntry<T> {
  item: T
  enqueuedAt: number
}

/** FIFO queue with a wait timeout. Busy state is driven externally by session events. */
export class SessionQueue<T> {
  private entries: QueueEntry<T>[] = []
  private readonly maxWaitMs: number
  private readonly onDrop: (item: T) => void

  constructor(maxWaitMs: number, onDrop: (item: T) => void) {
    this.maxWaitMs = maxWaitMs
    this.onDrop = onDrop
  }

  push(item: T): void {
    this.entries.push({ item, enqueuedAt: Date.now() })
  }

  shift(): T | undefined {
    return this.entries.shift()?.item
  }

  get size(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries = []
  }

  /** Drop entries that have waited longer than maxWaitMs. Returns dropped items. */
  dropExpired(now = Date.now()): T[] {
    const kept: QueueEntry<T>[] = []
    const dropped: T[] = []
    for (const e of this.entries) {
      if (now - e.enqueuedAt > this.maxWaitMs) dropped.push(e.item)
      else kept.push(e)
    }
    this.entries = kept
    for (const d of dropped) this.onDrop(d)
    return dropped
  }
}
