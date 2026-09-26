import type { PermissionRule } from "./permission.ts"
import type { PhoneConfig } from "./phone.ts"

export type Trust = "superuser" | "guest" | "deny"

export interface Account {
  open_id?: string
  user_id?: string
  name?: string
  trust: Trust
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
}

export interface Config {
  model: { providerID: string; modelID: string }
  daemon?: { url?: string; username?: string; password?: string }
  accounts: Account[]
  bots: BotConfig[]
  queue?: { maxWaitMs?: number }
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
