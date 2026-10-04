import type { PermissionRule } from "./permission.ts"
import type { PhoneConfig } from "./phone.ts"

export type Trust = "superuser" | "guest" | "deny"

export interface Account {
  open_id?: string
  user_id?: string
  name?: string
  trust: Trust
}

export interface AutoHandoffConfig {
  /** Context threshold in K tokens (default 120). */
  thresholdK?: number
  /** How long to wait for the hand-off session to report running (default 120s). */
  timeoutSec?: number
  /** Context delta to wait before retrying after a failed hand-off (default 20K). */
  retryDeltaK?: number
  /**
   * First sentence delivered to the new session. Placeholders: {oldSession}, {tokens} (K),
   * {directory}, {title}. Falls back to a clinical-continuity default.
   */
  message?: string
}

export interface BotConfig {
  /** Bot name in ~/.secrets/feishu.key */
  name: string
  /** Project directory mapped to this bot. */
  directory: string
  /** Pinned Kilo session id (optional; bridge persists one if empty). */
  session?: string
  /** Feishu chat to route approvals to before the human has messaged (proactive). */
  notifyChat?: string
  /**
   * Auto-rotate the bot's pinned session when a Feishu-bound session's context crosses the
   * threshold: start a fresh session, re-pin the bot to it, and carry queued messages over so
   * the Feishu chat stays continuous. Only applies to the Feishu-bound session of this bot.
   */
  autoHandoff?: AutoHandoffConfig
  /**
   * Receipt acknowledgement for accepted inbound messages: "always" replies immediately,
   * "delayed" only speaks up if no reply lands within ackDelayMs, "off" stays quiet. Default
   * "always". (Unsupported types and delivery errors are always reported regardless.)
   */
  ack?: "always" | "delayed" | "off"
  /** Delay before a "delayed" ack fires (default 5000ms). */
  ackDelayMs?: number
  /** Prefix each model reply with the answering model id (default true). */
  modelHeader?: boolean
}

export interface Config {
  model: { providerID: string; modelID: string }
  /** Whitelist of switchable models, each "providerID/modelID". Order fixes /models numbering. */
  models?: string[]
  daemon?: { url?: string; username?: string; password?: string }
  accounts: Account[]
  bots: BotConfig[]
  queue?: { maxWaitMs?: number; coalesceMs?: number }
  timers?: { maxActive?: number; minIntervalSec?: number }
  contextWatch?: { maxActive?: number; intervalSec?: number; minIntervalSec?: number }
  terminal?: { maxOutput?: number; defaultObserveLimit?: number }
  /** Command/tool whitelist for auto-approving permission.asked. Non-matching requests are forwarded to Feishu for manual approval. */
  permissions?: { allow?: PermissionRule[]; approvalTimeoutSec?: number; maxRetries?: number }
  control?: { port?: number; token?: string }
  /** Loopback wake delivery: "async" = server-side prompt_async (headless-safe); "tui" = submit via the attached TUI window so it renders as a normal turn. */
  wake?: { mode?: "async" | "tui" }
  /** Kilo's own phone (agent<->Kilo channel). Open on demand; nothing auto-replies. */
  phone?: PhoneConfig
}

export interface TimerRecord {
  id: string
  fireAt: number
  title: string
  notes?: string
  /** Where the timer was created: "feishu:<chatId>" or "window". */
  origin: string
  status: "pending" | "fired" | "cancelled" | "missed"
  createdAt: number
  firedAt?: number
}

export interface ContextWatchRecord {
  id: string
  sessionID: string
  directory: string
  /** Token threshold (absolute), not a percentage. */
  threshold: number
  /** Notification body the session supplied when starting the watch. */
  message: string
  intervalSec: number
  /** Same shape as TimerRecord.origin: "feishu:<bot>|<chatId>" or "session:<dir>|<sessionID>". */
  origin: string
  /** True when this watch was armed by bot config; crossing the threshold rotates the pinned session. */
  auto?: boolean
  status: "watching" | "fired" | "cancelled" | "closed"
  createdAt: number
  nextCheckAt: number
  lastCheckAt?: number
  lastTokens?: number
  firedAt?: number
}

export interface State {
  sessions: Record<string, string>
  timers: TimerRecord[]
  contextWatches: ContextWatchRecord[]
  controlToken?: string
}
