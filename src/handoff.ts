import { setTimeout as sleep } from "node:timers/promises"
import type { KiloClient } from "@kilocode/sdk"
import { createSession, getMessages, promptAsync, sessionStatus } from "./kilo.ts"

export interface HandoffOptions {
  title: string
  message: string
  directory: string
  /** How long to wait for the new session to report running (default 120s). */
  timeoutMs?: number
  /** Poll interval while waiting (default 1.5s). */
  pollMs?: number
}

export interface HandoffResult {
  ok: boolean
  title: string
  directory: string
  sessionID?: string
  /** How the start was confirmed: "running" (busy now) or "completed" (first turn already done). */
  state?: "running" | "completed"
  error?: string
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 1_500

/** Default first sentence for an automatic rotation; tuned for the clinical-continuity workflow. */
export const DEFAULT_AUTO_HANDOFF_MESSAGE =
  "[自动交接] 上一个诊疗会话 {oldSession} 上下文已达 {tokens}K，现由你无缝接续。" +
  "请先读取本工程的 AGENTS.md、visitor/index.md 与当前来访者的 profile.md（唯一信息源），" +
  "再接续处理随后来自飞书的患者消息；不要向患者提及本次自动交接。"

/** Expand {placeholders} in an auto-hand-off first sentence. Unknown keys are left intact. */
export function renderHandoffMessage(
  template: string | undefined,
  vars: { oldSession: string; tokens: number; directory: string; title: string },
): string {
  const src = template?.trim() ? template : DEFAULT_AUTO_HANDOFF_MESSAGE
  return src.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key as keyof typeof vars]) : whole,
  )
}

function newMessageID(): string {
  return `msg_handoff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Start a fresh Kilo session in `directory` with a title and first sentence, then
 * confirm it actually started — running (busy) now, or already finished its first
 * turn. Same contract as `locus/tools/handoff.py`, without spawning `kilo run`.
 */
export async function startHandoff(client: KiloClient, opts: HandoffOptions): Promise<HandoffResult> {
  const title = opts.title.trim()
  const message = opts.message.trim()
  const directory = opts.directory.trim()
  const base = { title, directory }
  if (!title) return { ...base, ok: false, error: "title required" }
  if (!message) return { ...base, ok: false, error: "message required" }
  if (!directory) return { ...base, ok: false, error: "directory required" }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS

  const sessionID = await createSession(client, directory, title)
  const messageID = newMessageID()
  await promptAsync(client, sessionID, directory, undefined, messageID, message)

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await sessionStatus(client, directory)
    if (status[sessionID]) return { ok: true, sessionID, title, directory, state: "running" }
    const msgs = await getMessages(client, sessionID, directory)
    if (msgs.some((m) => m.info.role === "assistant" && m.info.parentID === messageID))
      return { ok: true, sessionID, title, directory, state: "completed" }
    if (Date.now() >= deadline) break
    await sleep(pollMs)
  }
  return {
    ...base,
    ok: false,
    sessionID,
    error: `session ${sessionID} did not start within ${Math.round(timeoutMs / 1000)}s`,
  }
}
