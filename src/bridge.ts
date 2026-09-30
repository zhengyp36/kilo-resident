import { matchAccount, loadDaemon, type FeishuCreds } from "./config.ts"
import { makeKiloClient, createSession, listSessionIds, listSessions, getMessages, promptAsync, sessionStatus, sessionModel, parseModel, summarize, type Model, type SessionInfo } from "./kilo.ts"
import { createKiloClient, type KiloClient } from "@kilocode/sdk"
import { FeishuBot, type InboundMessage } from "./feishu.ts"
import { SessionQueue } from "./queue.ts"
import { TimerStore } from "./timer.ts"
import { ContextWatchStore } from "./context-watch.ts"
import { TerminalManager, type TerminalSession } from "./terminal.ts"
import { PhoneManager, formatInbound, type PhoneInbound } from "./phone.ts"
import { startHandoff, renderHandoffMessage, type HandoffResult } from "./handoff.ts"
import { matchesAllow } from "./permission.ts"
import { startControl, type ControlServer } from "./control.ts"
import { log, warn } from "./log.ts"
import { saveState } from "./state.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import type { Config, State, Trust, TimerRecord, ContextWatchRecord } from "./types.ts"

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
  timer?: NodeJS.Timeout
  /** True once the approval window elapsed without a human reply (tool call released). */
  expired: boolean
  /** How many times /retry re-drove this permission. */
  retryCount: number
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
  /** Snapshot from the last /sessions listing, so /pin <n> resolves to a stable id. */
  lastSessions?: SessionInfo[]
  /** Set while becameIdle is resolving/awaiting a reply, to avoid concurrent duplicate sends. */
  resolving?: boolean
  /** True while an auto hand-off is in flight; blocks inbound injection and idle re-entry. */
  handoffRunning?: boolean
  /** Threshold crossed but the session was busy; run the auto hand-off at the next idle. */
  pendingHandoff?: { tokens: number }
  /** Pin switch requested by a session-initiated `handoff`; applied once the current turn settles. */
  pendingSwitch?: string
}

/** One notification-type event awaiting a wake (terminal done, timer, phone). */
interface PendingWake {
  id: string
  text: string
  serverUrl?: string
  chatId?: string
}

/** Per-session merge buffer + dispatch state for notification-type events. */
interface InboxEntry {
  directory: string
  firstAt: number
  lastDispatchAt: number
  dispatching: boolean
  events: PendingWake[]
}

/** Wait this long after the first pending event before dispatching, to batch bursts. */
const NOTIFY_DEBOUNCE_MS = 1000
/** Dispatcher poll interval (idle gating fallback; session.idle also triggers a dispatch). */
const DISPATCH_INTERVAL_MS = 1000
/** Ignore session.idle right after a dispatch, while the server transitions to busy. */
const POST_DISPATCH_COOLDOWN_MS = 1500
/** A session stays "watched" (has an observable sink) this long after its last explicit interaction. */
const WATCH_TTL_MS = 60 * 60 * 1000

/** Render an inbound message into the text injected into the session, appending any saved attachments as local paths. */
function composeInboundText(msg: InboundMessage): string {
  const parts: string[] = []
  const body = msg.text.trim()
  if (body) parts.push(body)
  for (const a of msg.attachments ?? []) {
    const label = a.kind === "image" ? "图片" : "文件"
    parts.push(`[${label}附件已保存: ${a.path}${a.name ? ` (${a.name})` : ""}]`)
  }
  return parts.join("\n")
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
  private readonly contextWatches: ContextWatchStore
  private readonly terminals: TerminalManager
  private readonly seenEvents = new Set<string>()
  private readonly seenInbound = new Set<string>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly inbox = new Map<string, InboxEntry>()
  private readonly statusCache = new Map<string, { at: number; busy: boolean }>()
  private readonly watched = new Map<string, { directory: string; at: number }>()
  private dispatchTimer?: NodeJS.Timeout
  private dispatchRunning = false
  private readonly cfg: Config
  private readonly state: State
  private readonly stateFile: string
  private readonly creds: Map<string, FeishuCreds>
  private control?: ControlServer
  private phone?: PhoneManager
  private phoneBound?: { sessionID: string; directory: string; serverUrl?: string }

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
    this.daemonUrl = daemon.url

    this.timers = new TimerStore(state.timers, (t, missed) => this.onTimerFire(t, missed), {
      maxActive: cfg.timers?.maxActive ?? 20,
      minIntervalSec: cfg.timers?.minIntervalSec ?? 10,
      persist: () => saveState(this.stateFile, this.state),
    })

    this.contextWatches = new ContextWatchStore(
      state.contextWatches,
      (w, tokens) => this.onContextFire(w, tokens),
      (w) => this.probeContext(w),
      {
        maxActive: cfg.contextWatch?.maxActive ?? 10,
        defaultIntervalSec: cfg.contextWatch?.intervalSec ?? 60,
        minIntervalSec: cfg.contextWatch?.minIntervalSec ?? 15,
        persist: () => saveState(this.stateFile, this.state),
      },
    )

    this.terminals = new TerminalManager({
      defaultCwd: process.cwd(),
      maxOutput: cfg.terminal?.maxOutput,
      defaultObserveLimit: cfg.terminal?.defaultObserveLimit,
      onDone: (s) => this.onTerminalDone(s),
      onRemind: (s) => this.onTerminalRemind(s),
    })
  }

  listTimers(sessionID?: string) {
    // Identified sessions see only their own timers; unidentified (legacy) callers see everything.
    if (sessionID === undefined) return this.timers.list()
    return this.timers.list().filter((t) => this.timerOwner(t) === sessionID)
  }

  setTimer(input: { fireAt: number; title: string; notes?: string; origin: string }) {
    return this.timers.set(input)
  }

  cancelTimer(id: string, sessionID?: string) {
    if (sessionID) {
      const t = this.timers.list().find((x) => x.id === id && x.status === "pending")
      if (t && this.timerOwner(t) !== sessionID) return null
    }
    return this.timers.cancel(id)
  }

  listContextWatches(sessionID?: string) {
    // Identified sessions see only their own watches; unidentified (legacy) callers see everything.
    if (sessionID === undefined) return this.contextWatches.list()
    return this.contextWatches.list().filter((w) => this.watchOwner(w) === sessionID)
  }

  cancelContextWatch(id: string, sessionID?: string) {
    if (sessionID) {
      const w = this.contextWatches.list().find((x) => x.id === id && x.status === "watching")
      if (w && this.watchOwner(w) !== sessionID) return null
    }
    return this.contextWatches.cancel(id)
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

  /** Session that owns a timer, derived from its origin (session timers) or bot binding (feishu timers). */
  private timerOwner(t: TimerRecord): string | undefined {
    return this.originOwner(t.origin)
  }

  private watchOwner(w: ContextWatchRecord): string | undefined {
    return this.originOwner(w.origin)
  }

  private originOwner(origin: string): string | undefined {
    const [kind, a, b] = String(origin ?? "").split("|")
    if (kind === "session") return b
    if (kind === "feishu") return this.byBot.get(a)?.sessionId
    return undefined
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
    this.markWatched(
      body.sessionID != null ? String(body.sessionID) : undefined,
      body.directory != null ? String(body.directory) : undefined,
    )
    return this.timers.set({
      fireAt,
      title,
      notes: body.notes != null ? String(body.notes) : undefined,
      origin: this.originFor(String(body.sessionID ?? ""), body.directory != null ? String(body.directory) : undefined),
    })
  }

  private setContextWatchFromSession(body: Record<string, unknown>): ContextWatchRecord {
    const sessionID = String(body.sessionID ?? "")
    if (!sessionID || sessionID === "undefined" || sessionID === "null") throw new Error("sessionID required")
    const message = String(body.message ?? "").trim()
    if (!message) throw new Error("message required")
    const thresholdK = Number(body.thresholdK ?? body.threshold ?? NaN)
    if (!Number.isFinite(thresholdK) || thresholdK <= 0) throw new Error("thresholdK required (in K tokens)")
    const directory = body.directory != null ? String(body.directory) : ""
    this.markWatched(sessionID, directory)
    return this.contextWatches.set({
      sessionID,
      directory,
      threshold: Math.round(thresholdK * 1000),
      message,
      intervalSec: body.intervalSec != null ? Number(body.intervalSec) : undefined,
      origin: this.originFor(sessionID, directory),
    })
  }

  private async handoffFromSession(body: Record<string, unknown>): Promise<HandoffResult> {
    const sessionID = body.sessionID != null ? String(body.sessionID) : undefined
    const explicit = body.directory != null ? String(body.directory).trim() : ""
    const rt = sessionID ? this.runtimes.get(sessionID) : undefined
    const directory = explicit || rt?.directory || ""
    // Model: an explicit body.model wins; otherwise inherit the calling session's current model.
    // Fall back to undefined (server default) when the caller has no message carrying a model yet.
    const raw = body.model != null ? String(body.model).trim() : ""
    const requested = raw ? parseModel(raw) : undefined
    if (raw && !requested) warn("handoff", `ignoring unparseable model "${raw}" (expected providerID/modelID)`)
    const model = requested ?? (sessionID ? await sessionModel(this.client, sessionID, rt?.directory ?? directory) : undefined)
    const r = await startHandoff(this.client, {
      title: String(body.title ?? ""),
      message: String(body.message ?? body.text ?? ""),
      directory,
      model,
      timeoutMs: body.timeoutSec != null ? Number(body.timeoutSec) * 1000 : undefined,
    })
    if (r.ok && r.sessionID && rt) {
      // Re-pin the bot to the new session. If a turn is still in flight, defer the switch so the
      // reply for the current Feishu message still routes to the old session first.
      if (rt.busy || rt.resolving || rt.inflight) {
        rt.pendingSwitch = r.sessionID
        log("handoff", `deferred pin switch ${rt.name} -> ${r.sessionID} until idle`)
      } else {
        this.switchSession(rt, r.sessionID, { keepQueue: true })
        this.armAutoWatch(rt)
        log("handoff", `pinned ${rt.name} -> ${r.sessionID}`)
      }
    }
    return r
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
      this.markWatched(sessionId, bot.directory)
      this.armAutoWatch(rt)
      feishu.start()
      log("bridge", `bot ${bot.name} dir=${bot.directory} session=${sessionId}`)
    }

    const dirs = new Set([...this.byBot.values()].map((r) => r.directory))
    for (const dir of dirs) void this.subscribeEvents(dir)
    this.timers.start()
    this.contextWatches.start()
    // Drop auto watches left over from a previous run whose session is no longer the pinned one.
    for (const w of this.contextWatches.list()) {
      if (w.status === "watching" && w.auto && !this.runtimes.has(w.sessionID)) this.contextWatches.cancel(w.id)
    }

    const port = this.cfg.control?.port ?? 4180
    const token = this.ensureToken()
    this.control = startControl(port, token, {
      list: (body) => this.listTimers(body.sessionID != null ? String(body.sessionID) : undefined),
      set: (body) => this.setTimerFromSession(body),
      cancel: (id, sessionID) => this.cancelTimer(id, sessionID),
      contextWatch: {
        list: (body) => this.listContextWatches(body.sessionID != null ? String(body.sessionID) : undefined),
        set: (body) => this.setContextWatchFromSession(body),
        cancel: (id, sessionID) => this.cancelContextWatch(id, sessionID),
      },
      terminal: {
        open: (b) => {
          this.markWatched(b.sessionID != null ? String(b.sessionID) : undefined, b.directory != null ? String(b.directory) : undefined)
          return this.terminals.open({
            cwd: b.cwd != null ? String(b.cwd) : undefined,
            sessionID: b.sessionID != null ? String(b.sessionID) : undefined,
            directory: b.directory != null ? String(b.directory) : undefined,
            serverUrl: b.serverUrl != null ? String(b.serverUrl) : undefined,
          })
        },
        exec: (b) => {
          this.markWatched(b.sessionID != null ? String(b.sessionID) : undefined, b.directory != null ? String(b.directory) : undefined)
          return this.terminals.exec(
            b.id,
            String(b.command ?? ""),
            {
              sessionID: b.sessionID != null ? String(b.sessionID) : undefined,
              directory: b.directory != null ? String(b.directory) : undefined,
              serverUrl: b.serverUrl != null ? String(b.serverUrl) : undefined,
            },
            b.notifyAfterSec != null ? Number(b.notifyAfterSec) : undefined,
          )
        },
        observe: (b) => {
          this.markWatched(b.sessionID != null ? String(b.sessionID) : undefined, b.directory != null ? String(b.directory) : undefined)
          return this.terminals.observe(
            b.id,
            b.offset != null ? Number(b.offset) : undefined,
            b.limit != null ? Number(b.limit) : undefined,
            b.sessionID != null ? String(b.sessionID) : undefined,
          )
        },
        notify: (b) => {
          this.markWatched(b.sessionID != null ? String(b.sessionID) : undefined, b.directory != null ? String(b.directory) : undefined)
          return this.terminals.notify(b.id, b.afterSec, b.sessionID != null ? String(b.sessionID) : undefined)
        },
        cancel: (b) => {
          this.markWatched(b.sessionID != null ? String(b.sessionID) : undefined, b.directory != null ? String(b.directory) : undefined)
          return this.terminals.cancel(b.id, b.sessionID != null ? String(b.sessionID) : undefined)
        },
        list: (b) => this.terminals.list(b.sessionID != null ? String(b.sessionID) : undefined),
        close: (b) => {
          this.markWatched(b.sessionID != null ? String(b.sessionID) : undefined, b.directory != null ? String(b.directory) : undefined)
          return this.terminals.close(b.id, b.sessionID != null ? String(b.sessionID) : undefined)
        },
      },
      phone: {
        open: (b) => this.phoneOpen(b),
        send: (b) => this.phoneSend(b),
        status: () => this.phone?.status() ?? { running: false },
        close: () => this.phoneClose(),
      },
      handoff: (b) => this.handoffFromSession(b),
    })
    this.writeControlFile(port, token)

    if (this.cfg.wake?.mode === "tui") {
      warn("bridge", "wake.mode=tui is deprecated and ignored: wakes are session-scoped (prompt_async) now")
    }
    this.dispatchTimer = setInterval(() => void this.dispatchTick(), DISPATCH_INTERVAL_MS)
    this.dispatchTimer.unref?.()

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

  /**
   * Point a runtime at a session id (used by /new, /pin and hand-off). Returns the previous id.
   * With `keepQueue`, pending Feishu messages stay queued so a hand-off can flush them into the
   * new session (continuous chat); otherwise the queue is dropped (/new, /pin).
   * Callers must switch only at a turn boundary (commands reject while busy); a live inflight
   * here means a regression — log it loudly instead of dropping the reply silently.
   */
  private switchSession(rt: Runtime, id: string, opts?: { keepQueue?: boolean }): string {
    const old = rt.sessionId
    if (rt.inflight) warn("bridge", `switch ${rt.name} mid-turn: dropping in-flight reply ${rt.inflight.injectedId} (chat=${rt.inflight.chatId})`)
    if (old !== id) this.runtimes.delete(old)
    this.state.sessions[rt.name] = id
    saveState(this.stateFile, this.state)
    rt.sessionId = id
    rt.inflight = undefined
    rt.busy = false
    if (!opts?.keepQueue) rt.queue.clear()
    this.inbox.delete(old)
    this.contextWatches.removeBySession(old)
    this.runtimes.set(id, rt)
    return old
  }

  /** Arm the per-bot context watch that rotates the pinned session when the threshold is crossed. */
  private armAutoWatch(rt: Runtime): void {
    const ah = this.cfg.bots.find((b) => b.name === rt.name)?.autoHandoff
    if (!ah) return
    if (this.contextWatches.list().some((w) => w.status === "watching" && w.auto && w.sessionID === rt.sessionId)) return
    const thresholdK = ah.thresholdK ?? 120
    this.contextWatches.set({
      sessionID: rt.sessionId,
      directory: rt.directory,
      threshold: Math.round(thresholdK * 1000),
      message: `上下文已达 ${thresholdK}K，自动续接会话`,
      origin: `session|${rt.directory}|${rt.sessionId}`,
      auto: true,
    })
    log("handoff", `armed auto watch for ${rt.name} session=${rt.sessionId} threshold=${thresholdK}K`)
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
    this.markWatched(rt.sessionId, rt.directory)
    const attachmentCount = msg.attachments?.length ?? 0
    if (msg.attachmentsError) {
      log("bridge", `attachment receive failed from=${acc.name ?? "?"}: ${msg.attachmentsError}`)
      void rt.feishu.sendText(msg.chatId, `[系统] ${msg.attachmentsError}`)
    }
    if (!msg.text.trim() && attachmentCount === 0) {
      log("bridge", "ignore empty or non-text message")
      return
    }
    if (attachmentCount === 0 && msg.text.trimStart().startsWith("/")) {
      void this.handleCommand(rt, msg)
      return
    }
    const suffix = attachmentCount ? ` (+${attachmentCount} attachment)` : ""
    log("bridge", `inbound bot=${botName} from=${acc.name ?? "?"} chat=${msg.chatId}: ${msg.text.slice(0, 80)}${suffix}`)
    this.submit(rt, { ...msg, text: composeInboundText(msg), trust: acc.trust })
  }

  private async handleCommand(rt: Runtime, msg: InboundMessage): Promise<void> {
    const [cmd, ...rest] = msg.text.trim().slice(1).split(/\s+/)
    const arg = rest.join(" ").trim()
    const reply = (t: string) => rt.feishu.sendText(msg.chatId, t)
    log("bridge", `command /${cmd} ${arg}`)
    try {
      switch (cmd) {
        case "new": {
          if (rt.busy || rt.inflight) {
            await reply("当前正忙，等这轮结束再切")
            break
          }
          const id = await createSession(this.client, rt.directory, "resident")
          const old = this.switchSession(rt, id)
          this.armAutoWatch(rt)
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
          if (rt.busy || rt.inflight) {
            await reply("当前正忙，等这轮结束再切")
            break
          }
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
          this.armAutoWatch(rt)
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
          const all = [...this.pendingPermissions.values()]
          const active = all.filter((p) => !p.expired)
          const expired = all.filter((p) => p.expired)
          if (all.length === 0) {
            await reply("没有待审批的权限请求")
            break
          }
          const fmt = (p: PendingPermission) => `${p.id}  ${p.permission}  ${p.patterns.join(", ") || "-"}`
          const parts: string[] = []
          if (active.length) parts.push("待审批:\n" + active.map(fmt).join("\n"))
          if (expired.length) parts.push("已超时释放（可 /retry）:\n" + expired.map(fmt).join("\n"))
          await reply(parts.join("\n\n"))
          break
        }
        case "retry": {
          if (!arg) {
            await reply("用法: /retry <审批 id>\n先发 /pending 查看 id")
            break
          }
          const entry = this.pendingPermissions.get(arg)
          if (!entry) {
            await reply(`未找到审批 ${arg}`)
            break
          }
          const max = this.cfg.permissions?.maxRetries ?? 3
          entry.retryCount += 1
          const text =
            `[审批重试] 审批 ${entry.id} 未执行${entry.expired ? "（已超时释放）" : ""}。` +
            `请重新发起该操作：${entry.permission} ${entry.patterns.join(", ") || "-"}。` +
            `如需授权会再发审批给你。`
          const warning = entry.retryCount > max ? `\n注意: 已重发 ${entry.retryCount} 次，超过建议上限 ${max}` : ""
          await reply(`已请求重新发起 ${entry.id}（第 ${entry.retryCount} 次）${warning}`)
          this.wakeSession(entry.sessionID, entry.directory, `msg_retry_${entry.id}_${Date.now().toString(36)}`, text, undefined, entry.chatId)
          log("permission", `retry ${entry.permission} id=${entry.id} count=${entry.retryCount}`)
          break
        }
        case "help":
        default:
          await reply(
            "命令:\n/new 新会话\n/sessions 列会话\n/pin <编号> 切换会话\n/compact 压缩上下文\n/timers 列 timer\n/timer <分钟后> <标题> 设 timer\n/cancel <id> 取消 timer\n/pending 列待审批\n/allow <id> 放行审批\n/deny <id> 拒绝审批\n/retry <id> 重新发起审批\n/help 帮助",
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
    } else if (e.type === "session.deleted") {
      const info = props.info as { id?: string } | undefined
      const sid = String(info?.id ?? "")
      if (sid) this.contextWatches.removeBySession(sid)
    } else if (e.type === "permission.replied") {
      const requestID = String(props.requestID ?? props.permissionID ?? "")
      const entry = this.pendingPermissions.get(requestID)
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = undefined
        if (!entry.expired) this.pendingPermissions.delete(requestID)
      }
    }
  }

  private async becameIdle(sessionId: string): Promise<void> {
    const rt = this.runtimes.get(sessionId)
    if (rt && !rt.handoffRunning && !rt.resolving && (rt.busy || rt.inflight)) {
      rt.resolving = true
      try {
        if (rt.inflight) {
          const settled = await this.resolveReply(rt, rt.inflight)
          if (!settled && Date.now() - rt.inflight.since < 600_000) return // turn still generating; wait for the next idle
          if (!settled) warn("bridge", `giving up on reply for ${rt.inflight.injectedId} after 10min`)
          rt.inflight = undefined
        }
        rt.busy = false
        // A session-initiated hand-off requested a pin switch: apply it now that the reply is out.
        if (rt.pendingSwitch) {
          const target = rt.pendingSwitch
          rt.pendingSwitch = undefined
          this.switchSession(rt, target, { keepQueue: true })
          this.armAutoWatch(rt)
          log("handoff", `applied deferred pin switch ${rt.name} -> ${target}`)
        }
        // A context watch crossed the threshold while busy: rotate now, at the turn boundary.
        if (rt.pendingHandoff) {
          const p = rt.pendingHandoff
          rt.pendingHandoff = undefined
          await this.autoHandoff(rt, p.tokens)
        }
        rt.queue.dropExpired()
        const next = rt.queue.shift()
        if (next) {
          await this.inject(rt, next)
          return
        }
      } finally {
        rt.resolving = false
      }
    }
    // idle is the strongest signal: dispatch any pending notifications without waiting for the debounce
    await this.tryDispatch(sessionId, true)
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
    const botCfg = this.cfg.bots.find((b) => b.directory === directory)
    const chatId = rt?.lastChatId ?? botCfg?.notifyChat
    const botName = rt?.name ?? botCfg?.name
    if (!chatId || !botName) {
      warn("permission", `no feishu channel for ${permission} id=${id} session=${sessionID}; left pending`)
      return
    }
    const timeoutSec = this.cfg.permissions?.approvalTimeoutSec ?? 300
    const entry: PendingPermission = {
      id, sessionID, directory, permission, patterns, chatId, botName,
      createdAt: Date.now(), expired: false, retryCount: 0,
    }
    entry.timer = setTimeout(() => this.expirePermission(id), timeoutSec * 1000)
    entry.timer.unref?.()
    this.pendingPermissions.set(id, entry)
    const text = `[Kilo] 需要审批\nid: ${id}\n权限: ${permission}\n目标: ${patterns.join(", ") || "-"}\n回复 /allow ${id} 或 /deny ${id}（${timeoutSec}s 后自动释放，可用 /retry ${id} 重新发起）`
    log("permission", `ask ${permission} id=${id} -> feishu ${chatId}`)
    void (rt?.feishu ?? this.byBot.get(botName)?.feishu)?.sendText(chatId, text)
  }

  /**
   * The approval window elapsed. Release the tool call (SDK only allows once/always/reject,
   * so we reply reject) but keep the record, marked expired, so the human can later /retry it.
   */
  private expirePermission(id: string): void {
    const entry = this.pendingPermissions.get(id)
    if (!entry || entry.expired) return
    entry.expired = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    void this.replyPermission(entry.sessionID, entry.id, "reject", entry.directory)
    const bot = this.byBot.get(entry.botName)
    if (bot) void bot.feishu.sendText(entry.chatId, `审批 ${entry.id} 超时，已释放（未执行）。发 /retry ${entry.id} 可让我重新发起。`)
    log("permission", `expired ${entry.permission} id=${entry.id}`)
  }

  private async resolvePermission(id: string, allow: boolean): Promise<string> {
    const entry = this.pendingPermissions.get(id)
    if (!entry) return `未找到待审批 ${id}`
    if (entry.expired) return `审批 ${id} 已超时释放；发 /retry ${id} 让我重新发起`
    this.pendingPermissions.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
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
      // No explicit model: use the session's own model, so the bridge never pins a stale model id.
      await promptAsync(client, sessionId, directory, undefined, messageID, text)
    } catch (err) {
      if (client === this.client) throw err
      warn("bridge", `wake via ${serverUrl} failed, retry via daemon: ${String(err)}`)
      await promptAsync(this.client, sessionId, directory, undefined, messageID, text)
    }
  }

  /**
   * Deliver an injected message into a session and return the user-message id used (for reply routing).
   * Session-scoped only: `prompt_async` targets one sessionID and is headless-safe. The TUI channel
   * (`/tui/*`) is global broadcast and must not be used for wakes.
   */
  private async deliver(sessionId: string, directory: string, messageID: string, text: string, serverUrl?: string): Promise<string> {
    await this.promptWake(sessionId, directory, messageID, text, serverUrl)
    return messageID
  }

  private onTerminalDone(s: TerminalSession): void {
    const status = s.cancelled
      ? "cancelled"
      : `exited code=${s.exitCode ?? "null"}${s.signal ? ` signal=${s.signal}` : ""}`
    // Pointer only: the payload stays in the terminal buffer and is pulled back with terminal_observe.
    const text = `[terminal ${s.id}] ${status}${s.truncated ? " (output truncated)" : ""} — output via terminal_observe ${s.id}`
    log("terminal", `done id=${s.id} ${status} owner=${s.ownerSessionID ?? "-"} server=${s.ownerServerUrl ?? "-"}`)
    if (s.ownerSessionID) {
      const chatId = this.runtimes.get(s.ownerSessionID)?.lastChatId
      this.wakeSession(s.ownerSessionID, s.ownerDirectory ?? "", `msg_terminal_${s.id}_${Date.now().toString(36)}`, text, s.ownerServerUrl, chatId)
    }
  }

  private onTerminalRemind(s: TerminalSession): void {
    const elapsed = Math.max(0, Math.round((Date.now() - (s.startedAt ?? Date.now())) / 1000))
    const text = `[terminal ${s.id}] still running (elapsed ${elapsed}s) — observe via terminal_observe ${s.id}`
    log("terminal", `reminder id=${s.id} elapsed=${elapsed}s owner=${s.ownerSessionID ?? "-"}`)
    if (s.ownerSessionID) {
      const chatId = this.runtimes.get(s.ownerSessionID)?.lastChatId
      this.wakeSession(s.ownerSessionID, s.ownerDirectory ?? "", `msg_terminal_${s.id}_r_${Date.now().toString(36)}`, text, s.ownerServerUrl, chatId)
    }
  }

  /**
   * Queue a notification-type event (terminal done, timer, phone) for a session. Events for the same
   * session are merged into one turn and dispatched only when the session is idle (see the dispatcher).
   */
  private wakeSession(
    sessionId: string,
    directory: string,
    messageID: string,
    text: string,
    serverUrl?: string,
    chatId?: string,
  ): void {
    let entry = this.inbox.get(sessionId)
    if (!entry) {
      entry = { directory, firstAt: Date.now(), lastDispatchAt: 0, dispatching: false, events: [] }
      this.inbox.set(sessionId, entry)
    }
    if (directory) entry.directory = directory
    entry.events.push({ id: messageID, text, serverUrl, chatId })
    log("dispatch", `queued for ${sessionId} (pending=${entry.events.length})`)
    void this.tryDispatch(sessionId, false)
  }

  /** Record that a session was interacted with directly (tool call / phone / timer set), i.e. it has an observer. */
  private markWatched(sessionId?: string, directory?: string): void {
    if (!sessionId || sessionId === "undefined" || sessionId === "null") return
    const prev = this.watched.get(sessionId)
    this.watched.set(sessionId, { directory: directory ?? prev?.directory ?? "", at: Date.now() })
  }

  private isWatched(sessionId: string): boolean {
    const w = this.watched.get(sessionId)
    if (!w) return false
    if (Date.now() - w.at > WATCH_TTL_MS) {
      this.watched.delete(sessionId)
      return false
    }
    return true
  }

  /** Poll-driven fallback; session.idle triggers an immediate dispatch instead of waiting for this. */
  private async dispatchTick(): Promise<void> {
    if (this.dispatchRunning) return
    this.dispatchRunning = true
    try {
      for (const [sessionId, entry] of this.inbox) {
        if (entry.events.length === 0) continue
        await this.tryDispatch(sessionId, false)
      }
      const now = Date.now()
      for (const [sessionId, entry] of this.inbox) {
        if (entry.events.length === 0 && now - entry.lastDispatchAt > 300_000) this.inbox.delete(sessionId)
      }
    } finally {
      this.dispatchRunning = false
    }
  }

  /**
   * Dispatch pending events for one session if it is idle. Gated on: debounce window, idle (from the
   * event stream for known runtimes, or /session/status for ad-hoc sessions), and no delivery in flight.
   */
  private async tryDispatch(sessionId: string, idleTriggered: boolean): Promise<void> {
    const entry = this.inbox.get(sessionId)
    if (!entry || entry.dispatching || entry.events.length === 0) return
    if (!idleTriggered && Date.now() - entry.firstAt < NOTIFY_DEBOUNCE_MS) return
    if (Date.now() - entry.lastDispatchAt < POST_DISPATCH_COOLDOWN_MS) return
    // Claim the batch synchronously, before any await, so concurrent callers cannot splice the same
    // events (the status check below yields).
    entry.dispatching = true
    try {
      const rt = this.runtimes.get(sessionId)
      if (rt) {
        if (rt.resolving || rt.busy || rt.inflight || rt.queue.size > 0) return
      } else if (await this.sessionBusy(sessionId, entry.directory)) {
        return
      }
      const batch = entry.events.splice(0, entry.events.length)
      if (batch.length === 0) return
      entry.lastDispatchAt = Date.now()
      await this.dispatchBatch(sessionId, entry.directory, batch)
    } finally {
      entry.dispatching = false
    }
  }

  private async sessionBusy(sessionId: string, directory: string): Promise<boolean> {
    const cached = this.statusCache.get(sessionId)
    if (cached && Date.now() - cached.at < 900) return cached.busy
    try {
      const status = await sessionStatus(this.client, directory)
      const type = status[sessionId]?.type
      const busy = type === "busy" || type === "retry"
      this.statusCache.set(sessionId, { at: Date.now(), busy })
      return busy
    } catch (err) {
      warn("dispatch", `status check failed for ${sessionId}: ${String(err)}`)
      return false
    }
  }

  private async dispatchBatch(sessionId: string, directory: string, batch: PendingWake[]): Promise<void> {
    const chatId = batch.find((b) => b.chatId)?.chatId
    const serverUrl = batch.find((b) => b.serverUrl)?.serverUrl
    const sink = Boolean(chatId) || this.isWatched(sessionId)
    const body = batch.map((b) => b.text).join("\n\n")
    const text = batch.length === 1 ? body : `[${batch.length} 条待处理事件]\n\n${body}`

    if (!sink) {
      log("dispatch", `no sink for ${sessionId}; suppressing ${batch.length} event(s)`)
      this.notifyYz(`[kilo-resident] 会话 ${sessionId} 无观察出口，已压住 ${batch.length} 条事件：\n${body.slice(0, 500)}`)
      return
    }

    const messageID = batch[0].id
    const rt = this.runtimes.get(sessionId)
    if (!rt) {
      try {
        await this.deliver(sessionId, directory, messageID, text, serverUrl)
        log("dispatch", `woke ${sessionId} with ${batch.length} event(s)`)
      } catch (err) {
        warn("dispatch", `wake failed for ${sessionId}: ${String(err)}`)
      }
      return
    }
    rt.busy = true
    if (chatId) rt.inflight = { injectedId: messageID, chatId, since: Date.now() }
    try {
      const actualId = await this.deliver(rt.sessionId, rt.directory, messageID, text, serverUrl)
      if (rt.inflight) rt.inflight.injectedId = actualId
      log("dispatch", `woke ${rt.sessionId} (${actualId}) with ${batch.length} event(s)`)
    } catch (err) {
      rt.busy = false
      rt.inflight = undefined
      warn("dispatch", `wake failed for ${rt.sessionId}: ${String(err)}`)
    }
  }

  /** Notify YZ on Feishu when a session has no observable sink (AC4). */
  private notifyYz(text: string): void {
    const bot = this.cfg.bots.find((b) => b.notifyChat) ?? this.cfg.bots[0]
    const rt = bot ? this.byBot.get(bot.name) : undefined
    const chat = rt?.lastChatId ?? bot?.notifyChat
    if (!rt || !chat) {
      warn("dispatch", `cannot notify YZ (no feishu chat): ${text}`)
      return
    }
    void rt.feishu.sendText(chat, text)
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
    this.markWatched(sessionID, directory)
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
    this.wakeSession(bound.sessionID, bound.directory, mid, text, bound.serverUrl)
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
      if (rt) this.wakeSession(rt.sessionId, rt.directory, `msg_timer_${t.id}`, wake, undefined, b)
      return
    }
    if (kind === "session") {
      this.wakeSession(b, a, `msg_timer_${t.id}`, wake)
      log("timer", `queued wake for session ${b}: ${text}`)
      return
    }
    log("timer", `fired without a delivery channel: ${text}`)
  }

  // ---------- context watches ----------

  /** Current context usage of a session: latest non-zero assistant token total (see tools/ctx.py). */
  private async probeContext(w: ContextWatchRecord): Promise<number> {
    const msgs = await getMessages(this.client, w.sessionID, w.directory)
    const from = Math.max(0, msgs.length - 10)
    for (let i = msgs.length - 1; i >= from; i--) {
      const info = msgs[i].info as { role?: string; tokens?: { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number } } }
      if (info?.role !== "assistant" || !info.tokens) continue
      const t = info.tokens
      const total = t.total ?? (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0)
      if (total) return total
    }
    return 0
  }

  private onContextFire(w: ContextWatchRecord, tokens: number): void {
    const k = (n: number) => `${Math.round(n / 1000)}k`
    if (w.auto) {
      this.requestAutoHandoff(w, tokens)
      return
    }
    const text = `[context] ${w.message}\n(${k(tokens)}/${k(w.threshold)})`
    const wake = `[context ${w.id}] ${w.message} (${k(tokens)}/${k(w.threshold)})`
    const [kind, a, b] = w.origin.split("|")

    if (kind === "feishu") {
      const rt = this.byBot.get(a)
      if (rt && b) void rt.feishu.sendText(b, text)
      else log("context", `fired but bot ${a} not found: ${text}`)
      if (rt) this.wakeSession(rt.sessionId, rt.directory, `msg_context_${w.id}`, wake, undefined, b)
      return
    }
    if (kind === "session") {
      this.wakeSession(b, a, `msg_context_${w.id}`, wake)
      log("context", `queued wake for session ${b}: ${text}`)
      return
    }
    log("context", `fired without a delivery channel: ${text}`)
  }

  /**
   * A bot's auto watch crossed the threshold: rotate the pinned session so the Feishu chat keeps
   * going in a fresh session. Ignored (and cancelled) if the watched session is no longer the
   * bot's pinned one; deferred to the turn boundary if a turn is in flight.
   */
  private requestAutoHandoff(w: ContextWatchRecord, tokens: number): void {
    const k = Math.round(tokens / 1000)
    const rt = this.runtimes.get(w.sessionID)
    if (!rt || rt.sessionId !== w.sessionID) {
      log("handoff", `auto watch for stale session ${w.sessionID} at ${k}k; cancelled`)
      this.contextWatches.cancel(w.id)
      return
    }
    if (rt.busy || rt.resolving || rt.inflight || rt.queue.size > 0) {
      rt.pendingHandoff = { tokens }
      log("handoff", `auto hand-off deferred until idle for ${rt.name} at ${k}k`)
      return
    }
    void this.autoHandoff(rt, tokens)
  }

  /**
   * Start a fresh session for a runtime, re-pin the bot to it and carry the pending queue over so
   * the Feishu chat stays continuous. Runs at a turn boundary (never mid-turn).
   */
  private async autoHandoff(rt: Runtime, tokens: number): Promise<void> {
    const ah = this.cfg.bots.find((b) => b.name === rt.name)?.autoHandoff
    if (!ah || rt.handoffRunning) return
    rt.handoffRunning = true
    rt.busy = true
    const old = rt.sessionId
    const k = Math.round(tokens / 1000)
    const title = `${rt.name} ${new Date().toISOString().slice(5, 16).replace("T", " ")}`
    const message = renderHandoffMessage(ah.message, { oldSession: old, tokens: k, directory: rt.directory, title })
    log("handoff", `auto hand-off ${rt.name} ${old} at ${k}k -> new session`)
    try {
      const model = await sessionModel(this.client, old, rt.directory)
      const r = await startHandoff(this.client, {
        title,
        message,
        directory: rt.directory,
        model,
        timeoutMs: ah.timeoutSec != null ? ah.timeoutSec * 1000 : undefined,
      })
      if (!r.ok || !r.sessionID) {
        warn("handoff", `auto hand-off failed for ${rt.name}: ${r.error ?? "unknown"}`)
        rt.handoffRunning = false
        rt.busy = false
        if (rt.lastChatId) void rt.feishu.sendText(rt.lastChatId, `[系统] 自动续接未成功（${r.error ?? "unknown"}），会话继续。`)
        this.notifyYz(`[kilo-resident] 自动交接失败 bot=${rt.name} session=${old}: ${r.error ?? "unknown"}`)
        this.rearmAfterFailure(rt, tokens, ah.retryDeltaK ?? 20)
        return
      }
      const prev = this.switchSession(rt, r.sessionID, { keepQueue: true })
      this.armAutoWatch(rt)
      log("handoff", `auto hand-off done ${rt.name}: ${prev} -> ${r.sessionID}`)
    } catch (err) {
      warn("handoff", `auto hand-off threw for ${rt.name}: ${String(err)}`)
      rt.busy = false
      rt.handoffRunning = false
      this.rearmAfterFailure(rt, tokens, ah.retryDeltaK ?? 20)
      return
    }
    rt.handoffRunning = false
  }

  /** After a failed rotation, wait for the context to grow a bit more before trying again. */
  private rearmAfterFailure(rt: Runtime, tokens: number, deltaK: number): void {
    this.contextWatches.set({
      sessionID: rt.sessionId,
      directory: rt.directory,
      threshold: tokens + Math.max(1, deltaK) * 1000,
      message: "上下文已超阈值，重试自动续接",
      origin: `session|${rt.directory}|${rt.sessionId}`,
      auto: true,
    })
  }
}
