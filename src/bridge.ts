import { matchAccount, loadDaemon, type FeishuCreds } from "./config.ts"
import { makeKiloClient, createSession, listSessionIds, getMessages, promptAsync, summarize, type Model } from "./kilo.ts"
import type { KiloClient } from "@kilocode/sdk"
import { FeishuBot, type InboundMessage } from "./feishu.ts"
import { SessionQueue } from "./queue.ts"
import { TimerStore } from "./timer.ts"
import { startControl, type ControlServer } from "./control.ts"
import { log, warn } from "./log.ts"
import { saveState } from "./state.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import type { Config, State, Trust, TimerRecord } from "./types.ts"

interface Inbound extends InboundMessage {
  trust: Trust
}

interface Inflight {
  injectedId: string
  chatId: string
}

interface Runtime {
  name: string
  directory: string
  sessionId: string
  feishu: FeishuBot
  busy: boolean
  queue: SessionQueue<Inbound>
  inflight?: Inflight
  lastChatId?: string
}

export class Bridge {
  private readonly client: KiloClient
  private readonly runtimes = new Map<string, Runtime>()
  private readonly byBot = new Map<string, Runtime>()
  private readonly timers: TimerStore
  private readonly seenEvents = new Set<string>()
  private readonly seenInbound = new Set<string>()
  private readonly cfg: Config
  private readonly state: State
  private readonly stateFile: string
  private readonly creds: Map<string, FeishuCreds>
  private control?: ControlServer

  constructor(cfg: Config, state: State, stateFile: string, creds: Map<string, FeishuCreds>) {
    this.cfg = cfg
    this.state = state
    this.stateFile = stateFile
    this.creds = creds
    const daemon =
      cfg.daemon?.url
        ? { url: cfg.daemon.url, username: cfg.daemon.username, password: cfg.daemon.password }
        : loadDaemon()
    if (!daemon?.url) throw new Error("daemon not found: start `kilo daemon start` or set config.daemon.url")
    this.client = makeKiloClient(daemon)

    this.timers = new TimerStore(state.timers, (t, missed) => this.onTimerFire(t, missed), {
      maxActive: cfg.timers?.maxActive ?? 20,
      minIntervalSec: cfg.timers?.minIntervalSec ?? 10,
      persist: () => saveState(this.stateFile, this.state),
    })
  }

  listTimers() {
    return this.timers.list()
  }

  setTimer(input: { fireAt: number; title: string; notes?: string; origin: string }) {
    return this.timers.set(input)
  }

  cancelTimer(id: string) {
    return this.timers.cancel(id)
  }

  private ensureToken(): string {
    const t = this.cfg.control?.token || this.state.controlToken || randomBytes(24).toString("hex")
    if (this.state.controlToken !== t) {
      this.state.controlToken = t
      saveState(this.stateFile, this.state)
    }
    return t
  }

  private originFor(sessionID: string): string {
    const rt = sessionID ? this.runtimes.get(sessionID) : undefined
    if (rt?.lastChatId) return `feishu|${rt.name}|${rt.lastChatId}`
    if (rt) return `session|${rt.directory}|${sessionID}`
    return "window"
  }

  private setTimerFromSession(body: Record<string, unknown>): TimerRecord {
    const title = String(body.title ?? "").trim()
    if (!title) throw new Error("title required")
    const delaySec = body.delaySec != null ? Number(body.delaySec) : undefined
    const at = body.at != null ? String(body.at) : undefined
    const fireAt =
      body.fireAt != null
        ? Number(body.fireAt)
        : at
          ? Date.parse(at)
          : delaySec != null
            ? Date.now() + delaySec * 1000
            : NaN
    if (!Number.isFinite(fireAt)) throw new Error("need one of: delaySec, at (ISO), fireAt (epoch ms)")
    return this.timers.set({
      fireAt,
      title,
      notes: body.notes != null ? String(body.notes) : undefined,
      origin: this.originFor(String(body.sessionID ?? "")),
    })
  }

  private writeControlFile(port: number, token: string): void {
    const dir = join(homedir(), ".local", "state", "kilo-resident")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "control.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, token, pid: process.pid }, null, 2))
  }

  async start(): Promise<void> {
    for (const bot of this.cfg.bots) {
      const creds = this.creds.get(bot.name)
      if (!creds) {
        warn("bridge", `bot ${bot.name} not found in ~/.secrets/feishu.key; skipping`)
        continue
      }
      const sessionId = await this.resolveSession(bot.name, bot.directory, bot.session)
      const feishu = new FeishuBot(creds, (m) => this.onInbound(bot.name, m))
      const queue = new SessionQueue<Inbound>(this.cfg.queue?.maxWaitMs ?? 900_000, (item) => {
        void this.byBot.get(bot.name)?.feishu.sendText(item.chatId, "[busy] dropped an earlier message after waiting too long; please resend.")
      })
      const rt: Runtime = { name: bot.name, directory: bot.directory, sessionId, feishu, busy: false, queue }
      this.runtimes.set(sessionId, rt)
      this.byBot.set(bot.name, rt)
      feishu.start()
      log("bridge", `bot ${bot.name} dir=${bot.directory} session=${sessionId}`)
    }

    const dirs = new Set([...this.byBot.values()].map((r) => r.directory))
    for (const dir of dirs) void this.subscribeEvents(dir)
    this.timers.start()

    const port = this.cfg.control?.port ?? 4180
    const token = this.ensureToken()
    this.control = startControl(port, token, {
      list: () => this.timers.list(),
      set: (body) => this.setTimerFromSession(body),
      cancel: (id) => this.timers.cancel(id),
    })
    this.writeControlFile(port, token)

    log("bridge", `ready (${this.byBot.size} bot(s), ${dirs.size} dir(s))`)
  }

  private model(): Model {
    return { providerID: this.cfg.model.providerID, modelID: this.cfg.model.modelID }
  }

  private async resolveSession(botName: string, directory: string, pinned?: string): Promise<string> {
    const candidate = pinned || this.state.sessions[botName]
    if (candidate) {
      const ids = await listSessionIds(this.client, directory)
      if (ids.includes(candidate)) return candidate
      warn("bridge", `pinned session ${candidate} for ${botName} not found in ${directory}; creating a new one`)
    }
    const id = await createSession(this.client, directory, "resident")
    this.state.sessions[botName] = id
    saveState(this.stateFile, this.state)
    return id
  }

  // ---------- inbound ----------

  private onInbound(botName: string, msg: InboundMessage): void {
    const rt = this.byBot.get(botName)
    if (!rt) return
    if (this.seenInbound.has(msg.messageId)) return
    this.seenInbound.add(msg.messageId)
    if (this.seenInbound.size > 20000) this.seenInbound.clear()

    const acc = matchAccount(this.cfg.accounts, { open_id: msg.openId, user_id: msg.userId })
    if (!acc) {
      log("bridge", `drop non-whitelist sender open_id=${msg.openId ?? "-"} user_id=${msg.userId ?? "-"}`)
      return
    }
    if (acc.trust === "deny") {
      log("bridge", `drop denied sender ${acc.name ?? acc.user_id ?? acc.open_id}`)
      return
    }
    rt.lastChatId = msg.chatId
    if (!msg.text.trim()) {
      log("bridge", "ignore empty or non-text message")
      return
    }
    if (msg.text.trimStart().startsWith("/")) {
      void this.handleCommand(rt, msg)
      return
    }
    log("bridge", `inbound bot=${botName} from=${acc.name ?? "?"} chat=${msg.chatId}: ${msg.text.slice(0, 80)}`)
    this.submit(rt, { ...msg, trust: acc.trust })
  }

  private async handleCommand(rt: Runtime, msg: InboundMessage): Promise<void> {
    const [cmd, ...rest] = msg.text.trim().slice(1).split(/\s+/)
    const arg = rest.join(" ").trim()
    const reply = (t: string) => rt.feishu.sendText(msg.chatId, t)
    log("bridge", `command /${cmd} ${arg}`)
    try {
      switch (cmd) {
        case "new": {
          const old = rt.sessionId
          const id = await createSession(this.client, rt.directory, "resident")
          this.state.sessions[rt.name] = id
          saveState(this.stateFile, this.state)
          this.runtimes.delete(old)
          rt.sessionId = id
          rt.inflight = undefined
          rt.busy = false
          rt.queue.clear()
          this.runtimes.set(id, rt)
          await reply(`已开新会话 ${id}\n(旧 ${old})`)
          break
        }
        case "compact":
        case "summarize": {
          if (rt.busy || rt.inflight) {
            await reply("当前正忙，等这轮结束再 /compact")
            break
          }
          await summarize(this.client, rt.sessionId, rt.directory, this.model())
          await reply("已原地压缩上下文（同 session）")
          break
        }
        case "timers": {
          const list = this.timers.list().filter((t) => t.status === "pending")
          if (list.length === 0) {
            await reply("没有待触发的 timer")
            break
          }
          await reply("待触发 timer:\n" + list.map((t) => `${t.id}  ${new Date(t.fireAt).toLocaleString()}  ${t.title}`).join("\n"))
          break
        }
        case "cancel": {
          if (!arg) {
            await reply("用法: /cancel <timer id>")
            break
          }
          const t = this.timers.cancel(arg)
          await reply(t ? `已取消 ${t.id}` : `未找到待触发的 timer ${arg}`)
          break
        }
        case "timer": {
          const m = arg.match(/^(\d+(?:\.\d+)?)\s+(.+)$/)
          if (!m) {
            await reply("用法: /timer <分钟后> <标题>")
            break
          }
          const t = this.timers.set({
            fireAt: Date.now() + Number(m[1]) * 60_000,
            title: m[2],
            origin: `feishu|${rt.name}|${msg.chatId}`,
          })
          await reply(`已设 timer ${t.id}\n${new Date(t.fireAt).toLocaleString()}  ${t.title}`)
          break
        }
        case "help":
        default:
          await reply("命令:\n/new 新会话\n/compact 压缩上下文\n/timers 列 timer\n/timer <分钟后> <标题> 设 timer\n/cancel <id> 取消 timer\n/help 帮助")
          break
      }
    } catch (err) {
      warn("bridge", `command /${cmd} failed: ${String(err)}`)
      await reply(`命令 /${cmd} 执行失败: ${String(err).slice(0, 120)}`)
    }
  }

  private submit(rt: Runtime, item: Inbound): void {
    if (!rt.busy && !rt.inflight && rt.queue.size === 0) {
      void this.inject(rt, item)
      return
    }
    rt.queue.dropExpired()
    rt.queue.push(item)
    log("bridge", `queued for ${rt.name} (size=${rt.queue.size})`)
  }

  private async inject(rt: Runtime, item: Inbound): Promise<void> {
    const injectedId = `msg_feishu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    rt.inflight = { injectedId, chatId: item.chatId }
    rt.busy = true
    try {
      await promptAsync(this.client, rt.sessionId, rt.directory, this.model(), injectedId, item.text)
      log("bridge", `injected ${injectedId} -> ${rt.sessionId}`)
    } catch (err) {
      warn("bridge", `inject failed: ${String(err)}`)
      rt.busy = false
      rt.inflight = undefined
    }
  }

  // ---------- events ----------

  private async subscribeEvents(directory: string): Promise<void> {
    for (;;) {
      try {
        const sub = await this.client.event.subscribe({ query: { directory } })
        for await (const ev of sub.stream) this.onEvent(ev as { id?: string; type: string; properties?: Record<string, unknown> })
      } catch (err) {
        warn("bridge", `event stream[${directory}] ended (${String(err)}); reconnecting in 2s`)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }

  private onEvent(e: { id?: string; type: string; properties?: Record<string, unknown> }): void {
    if (e.id) {
      if (this.seenEvents.has(e.id)) return
      this.seenEvents.add(e.id)
      if (this.seenEvents.size > 20000) this.seenEvents.clear()
    }
    const props = e.properties ?? {}
    if (e.type === "session.idle") {
      void this.becameIdle(String(props.sessionID))
    } else if (e.type === "session.status") {
      const status = props.status as { type?: string } | undefined
      if (status?.type === "idle") void this.becameIdle(String(props.sessionID))
    }
  }

  private async becameIdle(sessionId: string): Promise<void> {
    const rt = this.runtimes.get(sessionId)
    if (!rt) return
    if (!rt.busy && !rt.inflight) return
    rt.busy = false
    const inflight = rt.inflight
    rt.inflight = undefined
    if (inflight) await this.resolveReply(rt, inflight)
    rt.queue.dropExpired()
    const next = rt.queue.shift()
    if (next) await this.inject(rt, next)
  }

  private async resolveReply(rt: Runtime, inflight: Inflight): Promise<void> {
    try {
      const msgs = await getMessages(this.client, rt.sessionId, rt.directory)
      const replies = msgs.filter((m) => m.info.role === "assistant" && m.info.parentID === inflight.injectedId)
      const texts: string[] = []
      const files: string[] = []
      for (const m of replies) {
        for (const p of m.parts) {
          if (p.type === "text" && !p.synthetic && p.text.trim()) texts.push(p.text.trim())
          if (p.type === "file" && p.url) files.push(p.url)
        }
      }
      const body = texts.join("\n\n").trim()
      if (body) await rt.feishu.sendText(inflight.chatId, body)
      for (const url of files) await this.sendFilePart(rt, inflight.chatId, url)
      log("bridge", `reply -> chat=${inflight.chatId} chars=${body.length} files=${files.length}`)
    } catch (err) {
      warn("bridge", `resolveReply failed: ${String(err)}`)
    }
  }

  private async sendFilePart(rt: Runtime, chatId: string, url: string): Promise<void> {
    const path = url.startsWith("file://") ? decodeURIComponent(new URL(url).pathname) : url
    if (path.startsWith("/")) {
      await rt.feishu.sendFile(chatId, path)
    } else {
      warn("bridge", `unsupported file part url: ${url}`)
    }
  }

  // ---------- timers ----------

  private onTimerFire(t: TimerRecord, missed: boolean): void {
    const note = missed ? `\n(delayed; was due ${new Date(t.fireAt).toLocaleString()})` : ""
    const text = `[timer] ${t.title}${t.notes ? "\n" + t.notes : ""}${note}`
    const wake = `[timer ${t.id}] ${t.title}${t.notes ? " — " + t.notes : ""}${missed ? " (missed, delivered late)" : ""}`
    const [kind, a, b] = t.origin.split("|")

    if (kind === "feishu") {
      const rt = this.byBot.get(a)
      if (rt && b) void rt.feishu.sendText(b, text)
      else log("timer", `fired but bot ${a} not found: ${text}`)
      if (rt && !rt.busy) {
        void promptAsync(this.client, rt.sessionId, rt.directory, this.model(), `msg_timer_${t.id}`, wake).catch(() => {})
      }
      return
    }
    if (kind === "session") {
      void promptAsync(this.client, b, a, this.model(), `msg_timer_${t.id}`, wake).catch(() => {})
      log("timer", `woke session ${b}: ${text}`)
      return
    }
    log("timer", `fired without a delivery channel: ${text}`)
  }
}
