import { spawn, type ChildProcess } from "node:child_process"

export type TerminalState = "idle" | "busy" | "exited"

export interface TerminalSession {
  id: number
  cwd: string
  state: TerminalState
  proc?: ChildProcess
  chunks: Buffer[]
  length: number
  cursor: number
  exitCode: number | null
  signal?: NodeJS.Signals | null
  truncated: boolean
  cancelled: boolean
  command?: string
  /** Session that opened/exec'd this terminal, used to route the completion wake. */
  ownerSessionID?: string
  ownerDirectory?: string
  /** Server that owns the session, so the wake can reach non-attached sessions. */
  ownerServerUrl?: string
  startedAt?: number
  endedAt?: number
}

export interface TerminalView {
  id: number
  state: TerminalState
  cwd: string
  command?: string
  exitCode: number | null
  cursor: number
  truncated: boolean
}

export interface TerminalObserve extends TerminalView {
  output: string
}

export interface TerminalManagerOptions {
  defaultCwd: string
  onDone: (session: TerminalSession) => void
  maxOutput?: number
  defaultObserveLimit?: number
  cancelGraceMs?: number
}

/**
 * Observable, cancellable, non-blocking subprocess sessions (no pty).
 * Ported from cogos `cogos/agent/terminal.py` semantics: busy/idle state,
 * append-only capped buffer, cursor-based incremental observe, killpg cancel.
 */
export class TerminalManager {
  private readonly sessions = new Map<number, TerminalSession>()
  private readonly opts: TerminalManagerOptions
  private nextId = 1

  constructor(opts: TerminalManagerOptions) {
    this.opts = opts
  }

  get maxOutput(): number {
    return this.opts.maxOutput ?? 256 * 1024
  }

  private get defaultObserveLimit(): number {
    return this.opts.defaultObserveLimit ?? 8 * 1024
  }

  private get cancelGraceMs(): number {
    return this.opts.cancelGraceMs ?? 2000
  }

  private resolve(id: unknown): { session?: TerminalSession; error?: string } {
    const sid = Number(id)
    if (!Number.isInteger(sid)) return { error: "invalid id" }
    const session = this.sessions.get(sid)
    if (!session) return { error: "unknown session" }
    return { session }
  }

  open(input: { cwd?: string; sessionID?: string; directory?: string; serverUrl?: string }): { ok: true; id: number; cwd: string } {
    const session: TerminalSession = {
      id: this.nextId++,
      cwd: input.cwd || this.opts.defaultCwd,
      state: "idle",
      chunks: [],
      length: 0,
      cursor: 0,
      exitCode: null,
      signal: null,
      truncated: false,
      cancelled: false,
      ownerSessionID: input.sessionID,
      ownerDirectory: input.directory,
      ownerServerUrl: input.serverUrl,
    }
    this.sessions.set(session.id, session)
    return { ok: true, id: session.id, cwd: session.cwd }
  }

  exec(id: unknown, command: string, owner?: { sessionID?: string; directory?: string; serverUrl?: string }): { ok: boolean; id?: number; started?: boolean; reason?: string } {
    const { session, error } = this.resolve(id)
    if (error || !session) return { ok: false, reason: error }
    if (session.state === "busy") return { ok: false, reason: "busy" }
    if (session.state === "exited") return { ok: false, reason: "exited" }
    if (owner?.sessionID) session.ownerSessionID = owner.sessionID
    if (owner?.directory) session.ownerDirectory = owner.directory
    if (owner?.serverUrl) session.ownerServerUrl = owner.serverUrl

    session.cancelled = false
    session.command = command
    session.startedAt = Date.now()
    session.endedAt = undefined
    session.exitCode = null
    session.signal = null

    let child: ChildProcess
    try {
      child = spawn(command, {
        cwd: session.cwd,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      })
    } catch (err) {
      session.state = "idle"
      return { ok: false, reason: `spawn failed: ${String(err)}` }
    }

    session.proc = child
    session.state = "busy"
    const onData = (chunk: Buffer) => this.append(session, chunk)
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.on("error", (err) => {
      this.append(session, Buffer.from(`\n[spawn error] ${String(err)}\n`))
      this.finish(session, child, null, null)
    })
    child.on("close", (code, signal) => this.finish(session, child, code, signal))

    return { ok: true, id: session.id, started: true }
  }

  observe(id: unknown, offset?: number, limit?: number): { ok: boolean; reason?: string } & Partial<TerminalObserve> {
    const { session, error } = this.resolve(id)
    if (error || !session) return { ok: false, reason: error }
    const all = Buffer.concat(session.chunks)
    let start: number
    let end: number
    if (offset != null && Number.isFinite(Number(offset))) {
      start = Math.max(Math.trunc(Number(offset)), 0)
      const lim = limit != null && Number.isFinite(Number(limit)) ? Math.max(Math.trunc(Number(limit)), 1) : this.defaultObserveLimit
      end = Math.min(start + lim, all.length)
    } else {
      start = session.cursor
      end = all.length
      session.cursor = end
    }
    return {
      ok: true,
      id: session.id,
      state: session.state,
      cwd: session.cwd,
      command: session.command,
      exitCode: session.exitCode,
      output: all.subarray(start, end).toString("utf8"),
      cursor: session.cursor,
      truncated: session.truncated,
    }
  }

  async cancel(id: unknown): Promise<{ ok: boolean; id?: number; state?: TerminalState; reason?: string }> {
    const { session, error } = this.resolve(id)
    if (error || !session) return { ok: false, reason: error }
    if (session.state !== "busy" || !session.proc || session.proc.exitCode !== null) {
      return { ok: true, id: session.id, state: session.state }
    }
    session.cancelled = true
    this.signal(session.proc, "SIGTERM")
    await this.waitFor(session.proc, this.cancelGraceMs)
    if (session.proc && session.proc.exitCode === null && session.proc.signalCode === null) {
      this.signal(session.proc, "SIGKILL")
      await this.waitFor(session.proc, 2000)
    }
    return { ok: true, id: session.id, state: session.state }
  }

  list(): TerminalView[] {
    return [...this.sessions.values()].map((s) => this.view(s))
  }

  async close(id: unknown): Promise<{ ok: boolean; id?: number; state?: TerminalState; reason?: string }> {
    const { session, error } = this.resolve(id)
    if (error || !session) return { ok: false, reason: error }
    if (session.state === "busy") await this.cancel(id)
    session.state = "exited"
    return { ok: true, id: session.id, state: session.state }
  }

  private view(s: TerminalSession): TerminalView {
    return { id: s.id, state: s.state, cwd: s.cwd, command: s.command, exitCode: s.exitCode, cursor: s.cursor, truncated: s.truncated }
  }

  /** Recent output tail (best-effort), used in completion wake messages. */
  tail(session: TerminalSession, maxBytes = 2000): string {
    const all = Buffer.concat(session.chunks)
    const start = Math.max(all.length - maxBytes, 0)
    return all.subarray(start).toString("utf8")
  }

  private append(session: TerminalSession, chunk: Buffer): void {
    const remaining = this.maxOutput - session.length
    if (remaining <= 0) {
      session.truncated = true
      return
    }
    if (chunk.length > remaining) {
      session.chunks.push(chunk.subarray(0, remaining))
      session.length += remaining
      session.truncated = true
    } else {
      session.chunks.push(chunk)
      session.length += chunk.length
    }
  }

  private finish(session: TerminalSession, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.proc !== child) return
    session.proc = undefined
    session.exitCode = code
    session.signal = signal
    session.endedAt = Date.now()
    if (session.state !== "exited") session.state = "idle"
    this.opts.onDone(session)
  }

  private signal(child: ChildProcess, sig: NodeJS.Signals): void {
    const pid = child.pid
    if (pid == null) return
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        /* already gone */
      }
    }
  }

  private waitFor(child: ChildProcess, ms: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      child.once("close", done)
      child.once("error", done)
    })
  }
}
