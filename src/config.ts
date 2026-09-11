import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Account, Config } from "./types.ts"

const HOME = homedir()

export const FEISHU_KEY = join(HOME, ".secrets", "feishu.key")
export const DAEMON_JSON = join(HOME, ".local", "state", "kilo", "daemon.json")
export const DEFAULT_CONFIG = join(import.meta.dirname, "..", "config.json")
export const DEFAULT_STATE = join(import.meta.dirname, "..", "state.json")

export interface FeishuCreds {
  name: string
  app_id: string
  app_secret: string
}

export function loadFeishuCreds(): Map<string, FeishuCreds> {
  const raw = JSON.parse(readFileSync(FEISHU_KEY, "utf8")) as { bots?: FeishuCreds[] }
  const out = new Map<string, FeishuCreds>()
  for (const b of raw.bots ?? []) out.set(b.name, b)
  return out
}

export interface DaemonInfo {
  url: string
  username?: string
  password?: string
}

export function loadDaemon(): DaemonInfo | null {
  if (!existsSync(DAEMON_JSON)) return null
  const d = JSON.parse(readFileSync(DAEMON_JSON, "utf8")) as DaemonInfo
  return d.url ? d : null
}

export function configPath(): string {
  return process.env.KILO_RESIDENT_CONFIG ?? DEFAULT_CONFIG
}

export function statePath(): string {
  return process.env.KILO_RESIDENT_STATE ?? DEFAULT_STATE
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) throw new Error(`config not found: ${path} (copy config.example.json)`)
  const cfg = JSON.parse(readFileSync(path, "utf8")) as Config
  if (!cfg.model?.providerID || !cfg.model?.modelID) throw new Error("config.model.{providerID,modelID} required")
  if (!Array.isArray(cfg.bots) || cfg.bots.length === 0) throw new Error("config.bots required")
  cfg.accounts ??= []
  return cfg
}

export function matchAccount(accounts: Account[], ids: { open_id?: string; user_id?: string }): Account | null {
  for (const a of accounts) {
    if (a.open_id && ids.open_id && a.open_id === ids.open_id) return a
    if (a.user_id && ids.user_id && a.user_id === ids.user_id) return a
  }
  return null
}
