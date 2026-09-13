import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import { log, warn } from "./log.ts"

export interface PhoneConfig {
  /** Kilo's own cogos number, e.g. COGOS002:A0006. */
  number: string
  /** Directory for the helper's phone data (cards/contacts/history). */
  dataDir: string
  /** Path to the cogos checkout the helper runs from. */
  cogosDir: string
  /** Contact roster: name -> [numbers]. Static config, not a tool step. */
  contacts?: Record<string, string[]>
  /** Python interpreter (default python3.11). */
  python?: string
  /** Per-peer consecutive inbound fuse. */
  maxConsecutive?: number
  /** Loopback port for the helper's inbound sink (0 = ephemeral). */
  sinkPort?: number
}

export interface PhoneInbound {
  source: string
  from: string
  to?: string | null
  content: string
  round?: number
  paused?: boolean
  note?: string
  chat_id?: string
}

/** Render an inbound agent message as a sourced turn for the Kilo session. */
export function formatInbound(p: PhoneInbound): string {
  const round = p.round ?? 0
  const head = p.paused
    ? `[agent来信] ${p.from} · 连续第 ${round} 轮已达上限`
    : `[agent来信] ${p.from} · 第 ${round} 轮`
  const tail = p.note ? `\n(${p.note})` : ""
  return `${head}：${p.content}${tail}`
}

export interface PhoneStatus {
  running: boolean
  url: string
  number: string
  error: string
}

/**
 * Owns the cogos phone helper process for Kilo's own number and bridges it to a
 * session: inbound messages land on the sink and are handed to ``onInbound``;
 * outbound only happens when ``send`` is called explicitly (no auto-reply).
 */
export class PhoneManager {
  private cfg: PhoneConfig
  private onInbound: (p: PhoneInbound) => void
  private proc?: ChildProcess
  private sink?: Server
  private url = ""
  private endpoint = ""
  private starting?: Promise<string>
  private stderrTail = ""
  private lastError = ""

  constructor(cfg: PhoneConfig, onInbound: (p: PhoneInbound) => void) {
    this.cfg = cfg
    this.onInbound = onInbound
  }

  running(): boolean {
    return Boolean(this.proc && this.url)
  }

  status(): PhoneStatus {
    return { running: this.running(), url: this.url, number: this.cfg.number, error: this.lastError }
  }

  get sinkEndpoint(): string {
    return this.endpoint
  }

  /** Start the local HTTP sink the helper posts inbound messages to. */
  async startSink(): Promise<string> {
    if (this.sink) return this.endpoint
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405)
        res.end()
        return
      }
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c as Buffer))
      req.on("end", () => {
        try {
          const p = JSON.parse(Buffer.concat(chunks).toString("utf8")) as PhoneInbound
          this.onInbound(p)
          res.writeHead(200, { "content-type": "application/json" })
          res.end("{}")
        } catch (err) {
          res.writeHead(400)
          res.end(String(err))
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.cfg.sinkPort ?? 0, "127.0.0.1", () => resolve())
    })
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    this.endpoint = `http://127.0.0.1:${port}/phone`
    this.sink = server
    return this.endpoint
  }

  /** Spawn the helper (idempotent). Resolves with the helper's loopback URL. */
  async open(): Promise<string> {
    if (this.running()) return this.url
    if (this.starting) return this.starting
    this.starting = this.doOpen()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async doOpen(): Promise<string> {
    const sinkUrl = await this.startSink()
    this.lastError = ""
    this.stderrTail = ""
    const python = this.cfg.python ?? "python3.11"
    const args = [
      "-m", "cogos.phone.helper",
      "--number", this.cfg.number,
      "--data-dir", this.cfg.dataDir,
      "--sink", sinkUrl,
      "--contacts", JSON.stringify(this.cfg.contacts ?? {}),
      "--max-consecutive", String(this.cfg.maxConsecutive ?? 5),
    ]
    const env = {
      ...process.env,
      PYTHONPATH: this.cfg.cogosDir + (process.env.PYTHONPATH ? ":" + process.env.PYTHONPATH : ""),
    }
    log("phone", `spawn ${python} -m cogos.phone.helper --number ${this.cfg.number}`)
    const proc = spawn(python, args, { cwd: this.cfg.cogosDir, env, stdio: ["ignore", "pipe", "pipe"] })
    this.proc = proc
    proc.stderr?.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000)
    })
    const url = await new Promise<string>((resolve, reject) => {
      let buf = ""
      const timer = setTimeout(
        () => reject(new Error(`phone helper not ready in 30s; stderr=${this.stderrTail.slice(-400)}`)),
        30_000,
      )
      const fail = (err: Error) => {
        clearTimeout(timer)
        this.lastError = err.message
        reject(err)
      }
      proc.stdout?.on("data", (d: Buffer) => {
        buf += d.toString()
        let idx: number
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          const m = line.match(/^READY (\S+)/)
          if (m) {
            clearTimeout(timer)
            resolve(m[1])
            return
          }
        }
      })
      proc.once("error", (e) => fail(e instanceof Error ? e : new Error(String(e))))
      proc.once("exit", (code) => fail(new Error(`phone helper exited code=${code}; stderr=${this.stderrTail.slice(-400)}`)))
    })
    this.url = url
    proc.once("exit", () => {
      if (this.proc === proc) {
        this.url = ""
        this.proc = undefined
      }
    })
    log("phone", `ready ${url}`)
    return url
  }

  async send(to: string, text: string): Promise<void> {
    if (!this.running()) throw new Error("phone not open")
    const r = await fetch(this.url + "/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, text }),
    })
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!r.ok || j.ok === false) throw new Error(j.error ?? `phone send failed http ${r.status}`)
  }

  async close(): Promise<void> {
    const proc = this.proc
    this.url = ""
    this.proc = undefined
    if (proc && !proc.killed) proc.kill("SIGTERM")
    if (this.sink) {
      const sink = this.sink
      this.sink = undefined
      this.endpoint = ""
      await new Promise<void>((resolve) => sink.close(() => resolve()))
    }
    log("phone", "closed")
  }
}
