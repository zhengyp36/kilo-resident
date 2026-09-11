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
}

export interface Config {
  model: { providerID: string; modelID: string }
  daemon?: { url?: string; username?: string; password?: string }
  accounts: Account[]
  bots: BotConfig[]
  queue?: { maxWaitMs?: number }
  timers?: { maxActive?: number; minIntervalSec?: number }
  control?: { port?: number; token?: string }
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

export interface State {
  sessions: Record<string, string>
  timers: TimerRecord[]
  controlToken?: string
}
