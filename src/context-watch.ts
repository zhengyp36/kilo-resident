import type { ContextWatchRecord } from "./types.ts"

export type ContextFire = (w: ContextWatchRecord, tokens: number) => void
export type ContextProbe = (w: ContextWatchRecord) => Promise<number>

/** Cap a single wait so long intervals still re-check wall-clock progress. */
const CHUNK_MS = 60_000

export interface ContextWatchOptions {
  maxActive: number
  defaultIntervalSec: number
  minIntervalSec: number
  persist: () => void
}

/**
 * Per-session context-length watch. Explicitly started by a session (threshold + notification
 * message supplied at start), checked every intervalSec. When the session's context crosses the
 * threshold the callback fires once and the watch is done; nothing is sent while under threshold.
 * Watches are absolute (nextCheckAt epoch ms) and persisted, mirroring TimerStore.
 */
export class ContextWatchStore {
  private readonly watches: ContextWatchRecord[]
  private readonly onFire: ContextFire
  private readonly probe: ContextProbe
  private readonly opts: ContextWatchOptions
  private running = false
  private handle?: NodeJS.Timeout

  constructor(watches: ContextWatchRecord[], onFire: ContextFire, probe: ContextProbe, opts: ContextWatchOptions) {
    this.watches = watches
    this.onFire = onFire
    this.probe = probe
    this.opts = opts
  }

  list(): ContextWatchRecord[] {
    return this.watches
  }

  watching(): ContextWatchRecord[] {
    return this.watches.filter((w) => w.status === "watching")
  }

  set(input: {
    sessionID: string
    directory: string
    threshold: number
    message: string
    origin: string
    intervalSec?: number
    auto?: boolean
  }): ContextWatchRecord {
    if (this.watching().length >= this.opts.maxActive) {
      throw new Error(`too many active context watches (max ${this.opts.maxActive})`)
    }
    const intervalSec = Math.max(input.intervalSec ?? this.opts.defaultIntervalSec, this.opts.minIntervalSec)
    const now = Date.now()
    const rec: ContextWatchRecord = {
      id: `ctx_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      sessionID: input.sessionID,
      directory: input.directory,
      threshold: input.threshold,
      message: input.message,
      intervalSec,
      origin: input.origin,
      auto: input.auto,
      status: "watching",
      createdAt: now,
      nextCheckAt: now + intervalSec * 1000,
    }
    this.watches.push(rec)
    this.persistAndReschedule()
    return rec
  }

  cancel(id: string): ContextWatchRecord | null {
    const w = this.watches.find((x) => x.id === id && x.status === "watching")
    if (!w) return null
    w.status = "cancelled"
    this.persistAndReschedule()
    return w
  }

  /** Close every watching entry for a session (session deleted / runtime switched away). */
  removeBySession(sessionID: string): number {
    let n = 0
    for (const w of this.watches) {
      if (w.status === "watching" && w.sessionID === sessionID) {
        w.status = "closed"
        n++
      }
    }
    if (n > 0) this.persistAndReschedule()
    return n
  }

  /** Rehydrate on bridge start: reschedule, no immediate checks. */
  start(): void {
    const now = Date.now()
    for (const w of this.watches) {
      if (w.status === "watching" && !(w.nextCheckAt > now)) w.nextCheckAt = now + w.intervalSec * 1000
    }
    this.reschedule()
  }

  stop(): void {
    if (this.handle) clearTimeout(this.handle)
    this.handle = undefined
  }

  private persistAndReschedule(): void {
    this.opts.persist()
    this.reschedule()
  }

  private reschedule(): void {
    if (this.handle) clearTimeout(this.handle)
    this.handle = undefined
    const pending = this.watching()
    if (pending.length === 0) return
    const next = pending.reduce((a, b) => (a.nextCheckAt <= b.nextCheckAt ? a : b))
    const delay = Math.min(Math.max(next.nextCheckAt - Date.now(), 0), CHUNK_MS)
    this.handle = setTimeout(() => void this.tick(), delay)
    this.handle.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = Date.now()
      const due = this.watching().filter((w) => w.nextCheckAt <= now)
      for (const w of due) {
        let tokens = 0
        try {
          tokens = await this.probe(w)
        } catch {
          w.nextCheckAt = Date.now() + w.intervalSec * 1000
          continue
        }
        w.lastCheckAt = Date.now()
        w.lastTokens = tokens
        if (tokens >= w.threshold) {
          this.onFire(w, tokens)
          w.status = "fired"
          w.firedAt = Date.now()
        } else {
          w.nextCheckAt = Date.now() + w.intervalSec * 1000
        }
      }
    } finally {
      this.running = false
      this.persistAndReschedule()
    }
  }
}
