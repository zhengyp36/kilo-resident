import type { TimerRecord } from "./types.ts"

export type TimerFire = (t: TimerRecord, missed: boolean) => void

const CHUNK_MS = 60_000

export interface TimerOptions {
  maxActive: number
  minIntervalSec: number
  persist: () => void
}

/**
 * Wall-clock alarm store. Timers are absolute (fireAt epoch ms) and persisted.
 * On start, overdue timers are delivered late, marked "missed".
 * Delivery is at-least-once: the callback runs before status is committed, so a
 * crash mid-delivery re-fires on the next start rather than silently dropping.
 */
export class TimerStore {
  constructor(
    private timers: TimerRecord[],
    private onFire: TimerFire,
    private opts: TimerOptions,
  ) {}

  list(): TimerRecord[] {
    return this.timers
  }

  pending(): TimerRecord[] {
    return this.timers.filter((t) => t.status === "pending").sort((a, b) => a.fireAt - b.fireAt)
  }

  set(input: { fireAt: number; title: string; notes?: string; origin: string }): TimerRecord {
    if (this.pending().length >= this.opts.maxActive) {
      throw new Error(`too many active timers (max ${this.opts.maxActive})`)
    }
    const minAt = Date.now() + this.opts.minIntervalSec * 1000
    const rec: TimerRecord = {
      id: `tmr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      fireAt: Math.max(input.fireAt, minAt),
      title: input.title,
      notes: input.notes,
      origin: input.origin,
      status: "pending",
      createdAt: Date.now(),
    }
    this.timers.push(rec)
    this.persistAndReschedule()
    return rec
  }

  cancel(id: string): TimerRecord | null {
    const t = this.timers.find((x) => x.id === id && x.status === "pending")
    if (!t) return null
    t.status = "cancelled"
    this.persistAndReschedule()
    return t
  }

  /** Rehydrate on start: deliver missed timers late, then schedule. */
  start(): void {
    const now = Date.now()
    for (const t of this.pending()) {
      if (t.fireAt > now) continue
      this.onFire({ ...t }, true)
      t.status = "missed"
      t.firedAt = now
    }
    this.persistAndReschedule()
  }

  private persistAndReschedule(): void {
    this.opts.persist()
    this.reschedule()
  }

  private reschedule(): void {
    if (this.handle) clearTimeout(this.handle)
    this.handle = undefined
    const next = this.pending()[0]
    if (!next) return
    const delay = Math.min(Math.max(next.fireAt - Date.now(), 0), CHUNK_MS)
    this.handle = setTimeout(() => this.tick(), delay)
    this.handle.unref?.()
  }

  private tick(): void {
    const now = Date.now()
    for (const t of this.pending()) {
      if (t.fireAt > now) break
      this.onFire({ ...t }, false)
      t.status = "fired"
      t.firedAt = now
    }
    this.persistAndReschedule()
  }

  private handle?: NodeJS.Timeout
}
