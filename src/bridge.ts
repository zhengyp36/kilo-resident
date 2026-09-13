import { matchAccount, loadDaemon, type FeishuCreds } from "./config.ts"
import { makeKiloClient, createSession, listSessionIds, listSessions, getMessages, promptAsync, summarize, type Model, type SessionInfo } from "./kilo.ts"
import { createKiloClient, type KiloClient } from "@kilocode/sdk"
import { FeishuBot, type InboundMessage } from "./feishu.ts"
import { SessionQueue } from "./queue.ts"
import { TimerStore } from "./timer.ts"
import { TerminalManager, type TerminalSession } from "./terminal.ts"
import { PhoneManager, formatInbound, type PhoneInbound } from "./phone.ts"
import { matchesAllow } from "./permission.ts"
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
  since: number
}

interface PendingPermission {
  id: string
  sessionID: string
  directory: string
  permission: string
  patterns: string[]
  chatId: string
  botName: string
  createdAt: number
  timer: NodeJS.Timeout
}

interface Runtime {
  name: string
  directory: string
  sessionId: string
  feishu: FeishuBot
  busy: boolean
  queue: SessionQueue<Inbound>
  wakes: { messageID: string; text: string; serverUrl?: string; chatId?: string }[]
  inflight?: Inflight
  lastChatId?: string
  /** Snapshot from the last /sessions listing, so /pin <n> resolves to a stable id. */
  lastSessions?: SessionInfo[]
  /** Set while becameIdle is resolving/awaiting a reply, to avoid concurrent duplicate sends. */
  resolving?: boolean
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  return new Date(ms).toLocaleDateString()
}

export class Bridge {
  private readonly client: KiloClient
  private readonly daemonUrl: string
  private readonly wakeClients = new Map<string, KiloClient>()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly byBot = new Map<string, Runtime>()
  private readonly timers: TimerStore
  private readonly terminals: TerminalManager
  private readonly seenEvents = new Set<string>()
  private readonly seenInbound = new Set<string>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly cfg: Config
  private readonly state: State
  private readonly stateFile: string
  private readonly creds: Map<string, FeishuCreds>
  private readonly wakeMode: "async" | "tui"
  private control?: ControlServer
  private phone?: PhoneManager
  private phoneBound?: { sessionID: string; directory: string; serverUrl?: string }

  constructor(cfg: Config, state: State, stateFile: string, creds: Map<string, FeishuCreds>) {
    this.cfg = cfg
    this.state = state
    this.stateFile = stateFile
    this.creds = creds
    this.wakeMode = cfg.wake?.mode === "tui" ? "tui" : "async"
    const daemon =
      cfg.daemon?.url
        ? { url: cfg.daemon.url, username: cfg.daemon.username, password: cfg.daemon.password }
        : loadDaemon()
    if (!daemon?.url) throw new Error("daemon not found: start `kilo daemon start` or set config.daemon.url")
    this.client = makeKiloClient(daemon)
    this.daemonUrl = daemon.url

    this.timers = new TimerStore(state.timers, (t, missed) => this.onTimerFire(t, missed), {
      maxActive: cfg.timers?.maxActive ?? 20,
      minIntervalSec: cfg.timers?.minIntervalSec ?? 10,
      persist: () => saveState(this.stateFile, this.state),
    })

    this.terminals = new TerminalManager({
      defaultCwd: process.cwd(),
      maxOutput: cfg.terminal?.maxOutput,
      defaultObserveLimit: cfg.terminal?.defaultObserveLimit,
      onDone: (s) => this.onTerminalDone(s),
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

  private originFor(sessionID: string, directory?: string): string {
    const rt = sessionID ? this.runtimes.get(sessionID) : undefined
    if (rt?.lastChatId) return `feishu|${rt.name}|${rt.lastChatId}`
    if (rt) return `session|${rt.directory}|${sessionID}`
    if (sessionID) return `session|${directory ?? ""}|${sessionID}`
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
      origin: this.originFor(String(body.sessionID ?? ""), body.directory != null ? String(body.directory) : undefined),
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
      const rt: Runtime = { name: bot.name, directory: bot.directory, sessionId, feishu, busy: false, queue, wakes: [] }
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
      terminal: {
        open: (b) =>
          this.terminals.open({
            cwd: b.cwd != null ? String(b.cwd) : undefined,
            sessionID: b.sessionID != null ? String(b.sessionID) : undefined,
            directory: b.directory != null ? String(b.directory) : undefined,
            serverUrl: b.serverUrl != null ? String(b.serverUrl) : undefined,
          }),
        exec: (b) =>
          this.terminals.exec(b.id, String(b.command ?? ""), {
            sessionID: b.sessionID != null ? String(b.sessionID) : undefined,
            directory: b.directory != null ? String(b.directory) : undefined,
            serverUrl: b.serverUrl != null ? String(b.serverUrl) : undefined,
          }),
        observe: (b) =>
          this.terminals.observe(b.id, b.offset != null ? Number(b.offset) : undefined, b.limit != null ? Number(b.limit) : undefined),
        cancel: (b) => this.terminals.cancel(b.id),
        list: () => this.terminals.list(),
        close: (b) => this.terminals.close(b.id),
      },
      phone: {
        open: (b) => this.phoneOpen(b),
        send: (b) => this.phoneSend(b),
        status: () => this.phone?.status() ?? { running: false },
        close: () => this.phoneClose(),
      },
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

  /** Point a runtime at a session id (used by /new and /pin). Returns the previous id. */
  private switchSession(rt: Runtime, id: string): string {
    const old = rt.sessionId
    if (old !== id) this.runtimes.delete(old)
    this.state.sessions[rt.name] = id
    saveState(this.stateFile, this.state)
    rt.sessionId = id
    rt.inflight = undefined
    rt.busy = false
    rt.queue.clear()
    rt.wakes = []
    this.runtimes.set(id, rt)
    return old
  }

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
          const id = await createSession(this.client, rt.directory, "resident")
          const old = this.switchSession(rt, id)
          await reply(`已开新会话 ${id}\n(旧 ${old})`)
          break
        }
        case "sessions": {
          const list = await listSessions(this.client, rt.directory)
          list.sort((a, b) => b.updated - a.updated)
          const shown = list.slice(0, 30)
          rt.lastSessions = shown
          if (shown.length === 0) {
            await reply("没有会话")
            break
          }
          const lines = shown.map(
            (s, i) => `${s.id === rt.sessionId ? ">" : " "} ${i + 1}. ${s.title || "(untitled)"}  ${s.id}  ${timeAgo(s.updated)}`,
          )
          const more = list.length > shown.length ? `\n(共 ${list.length} 个，仅显示最近 ${shown.length} 个)` : ""
          await reply(`会话（/pin <编号> 切换）:\n${lines.join("\n")}${more}`)
          break
        }
        case "pin": {
          if (!arg) {
            await reply("用法: /pin <编号|session id>\n先发 /sessions 获取编号")
            break
          }
          let target: string | undefined
          if (/^\d+$/.test(arg)) {
            if (!rt.lastSessions) {
              await reply("先发 /sessions 获取编号")
              break
            }
            target = rt.lastSessions[Number(arg) - 1]?.id
            if (!target) {
              await reply(`编号 ${arg} 超出范围，重新发 /sessions`)
              break
            }
          } else {
            target = arg
          }
          if (target === rt.sessionId) {
            await reply(`已在会话 ${target}`)
            break
          }
          const ids = await listSessionIds(this.client, rt.directory)
          if (!ids.includes(target)) {
            await reply(`未找到会话 ${target}`)
            break
          }
          const old = this.switchSession(rt, target)
          await reply(`已切换会话\n${target}\n(旧 ${old})`)
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
        case "allow": {
          if (!arg) {
            await reply("用法: /allow <审批 id>")
            break
          }
          await reply(await this.resolvePermission(arg, true))
          break
        }
        case "deny": {
          if (!arg) {
            await reply("用法: /deny <审批 id>")
            break
          }
          await reply(await this.resolvePermission(arg, false))
          break
        }
        case "pending": {
          if (this.pendingPermissions.size === 0) {
            await reply("没有待审批的权限请求")
            break
          }
          await reply(
            "待审批:\n" +
              [...this.pendingPermissions.values()]
                .map((p) => `${p.id}  ${p.permission}  ${p.patterns.join(", ") || "-"}`)
                .join("\n"),
          )
          break
        }
        case "help":
        default:
          await reply(
            "命令:\n/new 新会话\n/sessions 列会话\n/pin <编号> 切换会话\n/compact 压缩上下文\n/timers 列 timer\n/timer <分钟后> <标题> 设 timer\n/cancel <id> 取消 timer\n/pending 列待审批\n/allow <id> 放行审批\n/deny <id> 拒绝审批\n/help 帮助",
          )
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
    rt.inflight = { injectedId, chatId: item.chatId, since: Date.now() }
    rt.busy = true
    try {
      const actualId = await this.deliver(rt.sessionId, rt.directory, injectedId, item.text)
      if (rt.inflight) rt.inflight.injectedId = actualId
      log("bridge", `injected ${actualId} -> ${rt.sessionId}`)
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
        for await (const ev of sub.stream) this.onEvent(ev as { id?: string; type: string; properties?: Record<string, unknown> }, directory)
      } catch (err) {
        warn("bridge", `event stream[${directory}] ended (${String(err)}); reconnecting in 2s`)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }

  private onEvent(e: { id?: string; type: string; properties?: Record<string, unknown> }, directory: string): void {
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
    } else if (e.type === "permission.asked") {
      this.onPermissionAsked(props, directory)
    } else if (e.type === "permission.replied") {
      const requestID = String(props.requestID ?? props.permissionID ?? "")
      const entry = this.pendingPermissions.get(requestID)
      if (entry) {
        clearTimeout(entry.timer)
        this.pendingPermissions.delete(requestID)
      }
    }
  }

  private async becameIdle(sessionId: string): Promise<void> {
    const rt = this.runtimes.get(sessionId)
    if (!rt || rt.resolving) return
    if (!rt.busy && !rt.inflight) return
    rt.resolving = true
    try {
      if (rt.inflight) {
        const settled = await this.resolveReply(rt, rt.inflight)
        if (!settled && Date.now() - rt.inflight.since < 600_000) return // turn still generating; wait for the next idle
        if (!settled) warn("bridge", `giving up on reply for ${rt.inflight.injectedId} after 10min`)
        rt.inflight = undefined
      }
      rt.busy = false
      rt.queue.dropExpired()
      const next = rt.queue.shift()
      if (next) {
        await this.inject(rt, next)
        return
      }
      const wake = rt.wakes.shift()
      if (wake) await this.deliverWake(rt, wake.messageID, wake.text, wake.serverUrl, wake.chatId)
    } finally {
      rt.resolving = false
    }
  }

  /**
   * Send the assistant reply for an injected turn. Returns true once the turn is settled (reply sent,
   * or nothing to send). Returns false when the reply is not ready yet — an idle can fire before the
   * assistant message finishes streaming, so callers keep the inflight and retry on the next idle.
   */
  private async resolveReply(rt: Runtime, inflight: Inflight): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        const msgs = await getMessages(this.client, rt.sessionId, rt.directory)
        const replies = msgs.filter((m) => m.info.role === "assistant" && m.info.parentID === inflight.injectedId)
        const last = replies[replies.length - 1]
        const finished = last != null && ((last.info as { time?: { completed?: number } }).time?.completed ?? 0) > 0
        if (finished) {
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
          return true
        }
      } catch (err) {
        warn("bridge", `resolveReply read failed: ${String(err)}`)
      }
      if (attempt >= 4) return false
      await new Promise((r) => setTimeout(r, 250))
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

  // ---------- permissions ----------

  private onPermissionAsked(props: Record<string, unknown>, directory: string): void {
    const id = String(props.id ?? props.permissionID ?? "")
    const sessionID = String(props.sessionID ?? "")
    if (!id || !sessionID) return
    const permission = String(props.permission ?? props.tool ?? "?")
    const raw: unknown[] = Array.isArray(props.patterns)
      ? props.patterns
      : props.pattern != null
        ? [props.pattern]
        : props.metadata && typeof props.metadata === "object" && (props.metadata as { command?: unknown }).command != null
          ? [(props.metadata as { command?: unknown }).command]
          : []
    const patterns = raw.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))

    if (matchesAllow(this.cfg.permissions?.allow, { permission, patterns })) {
      log("permission", `auto-allow ${permission} patterns=${patterns.join(" | ") || "-"}`)
      void this.replyPermission(sessionID, id, "once", directory)
      return
    }

    const rt = this.runtimes.get(sessionID)
    const chatId = rt?.lastChatId
    if (!rt || !chatId) {
      warn("permission", `no feishu channel for ${permission} id=${id} session=${sessionID}; left pending`)
      return
    }
    const timeoutSec = this.cfg.permissions?.approvalTimeoutSec ?? 300
    const timer = setTimeout(() => {
      const entry = this.pendingPermissions.get(id)
      if (!entry) return
      this.pendingPermissions.delete(id)
      void this.replyPermission(entry.sessionID, entry.id, "reject", entry.directory)
      const bot = this.byBot.get(entry.botName)
      if (bot) void bot.feishu.sendText(entry.chatId, `审批 ${entry.id} 超时，已拒绝`)
    }, timeoutSec * 1000)
    timer.unref?.()
    this.pendingPermissions.set(id, { id, sessionID, directory, permission, patterns, chatId, botName: rt.name, createdAt: Date.now(), timer })
    const text = `[Kilo] 需要审批\nid: ${id}\n权限: ${permission}\n目标: ${patterns.join(", ") || "-"}\n回复 /allow ${id} 或 /deny ${id}（${timeoutSec}s 后自动拒绝）`
    log("permission", `ask ${permission} id=${id} -> feishu ${chatId}`)
    void rt.feishu.sendText(chatId, text)
  }

  private async resolvePermission(id: string, allow: boolean): Promise<string> {
    const entry = this.pendingPermissions.get(id)
    if (!entry) return `未找到待审批 ${id}`
    this.pendingPermissions.delete(id)
    clearTimeout(entry.timer)
    await this.replyPermission(entry.sessionID, entry.id, allow ? "once" : "reject", entry.directory)
    return allow ? `已放行 ${id}` : `已拒绝 ${id}`
  }

  private async replyPermission(sessionID: string, permissionID: string, response: "once" | "always" | "reject", directory?: string): Promise<void> {
    try {
      await this.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID },
        body: { response },
        query: directory ? { directory } : undefined,
      })
      log("permission", `reply ${response} id=${permissionID} session=${sessionID}`)
    } catch (err) {
      warn("permission", `reply ${response} id=${permissionID} failed: ${String(err)}`)
    }
  }

  // ---------- terminal ----------

  private clientFor(serverUrl?: string): KiloClient {
    if (!serverUrl) return this.client
    const norm = serverUrl.replace(/\/+$/, "")
    if (norm === this.daemonUrl.replace(/\/+$/, "")) return this.client
    let c = this.wakeClients.get(norm)
    if (!c) {
      c = createKiloClient({ baseUrl: norm })
      this.wakeClients.set(norm, c)
    }
    return c
  }

  private async promptWake(sessionId: string, directory: string, messageID: string, text: string, serverUrl?: string): Promise<void> {
    const client = this.clientFor(serverUrl)
    try {
      await promptAsync(client, sessionId, directory, this.model(), messageID, text)
    } catch (err) {
      if (client === this.client) throw err
      warn("bridge", `wake via ${serverUrl} failed, retry via daemon: ${String(err)}`)
      await promptAsync(this.client, sessionId, directory, this.model(), messageID, text)
    }
  }

  /**
   * Deliver an injected message into a session and return the user-message id used (for reply routing).
   * In "tui" wake mode this goes through the attached TUI window (append-prompt + submit-prompt) so it
   * renders as a normal local turn instead of a server-side prompt_async that the TUI shows as QUEUED.
   */
  private async deliver(sessionId: string, directory: string, messageID: string, text: string, serverUrl?: string): Promise<string> {
    if (this.wakeMode === "tui") {
      const actual = await this.tuiDeliver(sessionId, directory, text)
      if (actual) return actual
      warn("bridge", `tui wake not confirmed for ${sessionId}; falling back to promptAsync`)
    }
    await this.promptWake(sessionId, directory, messageID, text, serverUrl)
    return messageID
  }

  /** Submit text via the attached TUI; returns the created user-message id, or null if no window handled it. */
  private async tuiDeliver(sessionId: string, directory: string, text: string): Promise<string | null> {
    const t0 = Date.now()
    try {
      await this.client.tui.appendPrompt({ body: { text }, query: { directory } })
      await this.client.tui.submitPrompt({ query: { directory } })
    } catch (err) {
      warn("bridge", `tui deliver failed: ${String(err)}`)
      return null
    }
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200))
      try {
        const msgs = await getMessages(this.client, sessionId, directory)
        let best: { id: string; created: number } | null = null
        for (const m of msgs) {
          const created = (m.info as { time?: { created?: number } }).time?.created ?? 0
          if (created < t0 || m.info.role !== "user") continue
          const body = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
          if (body === text && (!best || created > best.created)) best = { id: m.info.id, created }
        }
        if (best) return best.id
      } catch {
        // ignore transient read errors
      }
    }
    return null
  }

  private onTerminalDone(s: TerminalSession): void {
    const status = s.cancelled
      ? "cancelled"
      : `exited code=${s.exitCode ?? "null"}${s.signal ? ` signal=${s.signal}` : ""}`
    const tail = this.terminals.tail(s)
    const text = `[terminal ${s.id}] ${status}${s.truncated ? " (output truncated)" : ""}\nlast output:\n${tail || "(none)"}`
    log("terminal", `done id=${s.id} ${status} owner=${s.ownerSessionID ?? "-"} server=${s.ownerServerUrl ?? "-"}`)
    if (s.ownerSessionID) {
      const chatId = this.runtimes.get(s.ownerSessionID)?.lastChatId
      this.wakeSession(s.ownerSessionID, s.ownerDirectory ?? "", `msg_terminal_${s.id}_${Date.now().toString(36)}`, text, s.ownerServerUrl, chatId)
    }
  }

  private wakeSession(sessionId: string, directory: string, messageID: string, text: string, serverUrl?: string, chatId?: string): void {
    const rt = this.runtimes.get(sessionId)
    if (!rt) {
      void this.deliver(sessionId, directory, messageID, text, serverUrl).catch((err) =>
        warn("bridge", `wake ${sessionId} failed: ${String(err)}`),
      )
      return
    }
    if (!rt.busy && !rt.inflight && rt.queue.size === 0) {
      void this.deliverWake(rt, messageID, text, serverUrl, chatId)
      return
    }
    rt.wakes.push({ messageID, text, serverUrl, chatId })
    log("bridge", `wake queued for ${rt.name} (wakes=${rt.wakes.length})`)
  }

  private async deliverWake(rt: Runtime, messageID: string, text: string, serverUrl?: string, chatId?: string): Promise<void> {
    rt.busy = true
    if (chatId) rt.inflight = { injectedId: messageID, chatId, since: Date.now() }
    try {
      const actualId = await this.deliver(rt.sessionId, rt.directory, messageID, text, serverUrl)
      if (rt.inflight) rt.inflight.injectedId = actualId
      log("bridge", `woke ${rt.sessionId} (${actualId})`)
    } catch (err) {
      rt.busy = false
      rt.inflight = undefined
      warn("bridge", `wake failed: ${String(err)}`)
    }
  }

  // ---------- phone (agent <-> Kilo channel) ----------

  private ensurePhone(): PhoneManager {
    if (!this.phone) {
      if (!this.cfg.phone) throw new Error("phone not configured (config.phone)")
      this.phone = new PhoneManager(this.cfg.phone, (p) => this.onPhoneInbound(p))
    }
    return this.phone
  }

  private async phoneOpen(b: Record<string, unknown>): Promise<unknown> {
    const sessionID = String(b.sessionID ?? "")
    const directory = String(b.directory ?? "")
    if (!sessionID) throw new Error("sessionID required")
    const serverUrl = b.serverUrl != null ? String(b.serverUrl) : undefined
    this.phoneBound = { sessionID, directory, serverUrl }
    const url = await this.ensurePhone().open()
    return { ok: true, url, number: this.cfg.phone?.number }
  }

  private async phoneSend(b: Record<string, unknown>): Promise<unknown> {
    const to = String(b.to ?? "")
    const text = String(b.text ?? "")
    if (!to || !text) throw new Error("to and text required")
    await this.ensurePhone().send(to, text)
    return { ok: true }
  }

  private async phoneClose(): Promise<unknown> {
    if (this.phone) await this.phone.close()
    this.phoneBound = undefined
    return { ok: true }
  }

  private onPhoneInbound(p: PhoneInbound): void {
    const bound = this.phoneBound
    if (!bound) {
      warn("phone", "inbound with no bound session; dropping")
      return
    }
    const text = formatInbound(p)
    const mid = `msg_phone_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    log("phone", `inbound ${p.from} round=${p.round ?? "-"} -> ${bound.sessionID}`)
    // No auto-reply: inject only. Kilo decides whether to call phone_send.
    void this.deliver(bound.sessionID, bound.directory, mid, text, bound.serverUrl).catch((err) =>
      warn("phone", `inject failed: ${String(err)}`),
    )
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
        void this.deliver(rt.sessionId, rt.directory, `msg_timer_${t.id}`, wake).catch(() => {})
      }
      return
    }
    if (kind === "session") {
      void this.deliver(b, a, `msg_timer_${t.id}`, wake).catch(() => {})
      log("timer", `woke session ${b}: ${text}`)
      return
    }
    log("timer", `fired without a delivery channel: ${text}`)
  }
}
