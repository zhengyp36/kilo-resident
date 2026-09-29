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
