import type { Plugin } from "@kilocode/plugin"
import { tool } from "@kilocode/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONTROL_FILE = join(homedir(), ".local", "state", "kilo-resident", "control.json")

function control(): { url: string; token: string } | null {
  try {
    return JSON.parse(readFileSync(CONTROL_FILE, "utf8")) as { url: string; token: string }
  } catch {
    return null
  }
}

async function call(path: string, init?: RequestInit): Promise<any> {
  const c = control()
  if (!c) throw new Error("kilo-resident bridge is not running")
  const r = await fetch(c.url + path, {
    ...init,
    headers: { "content-type": "application/json", "x-token": c.token, ...(init?.headers ?? {}) },
  })
  const j = await r.json()
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `http ${r.status}`)
  return j
}

function fmtObserve(t: any): string {
  const head = `terminal ${t.id}  state=${t.state}  cwd=${t.cwd}${t.command ? `  cmd=${t.command}` : ""}  exit=${t.exitCode ?? "-"}  cursor=${t.cursor}${t.truncated ? "  [truncated]" : ""}`
  const out = (t.output ?? "").toString()
  return out.trim() ? `${head}\n---\n${out}` : `${head}\n---\n(no new output)`
}

/**
 * Terminal tools backed by the resident bridge's loopback control API.
 * Non-blocking subprocess sessions: open / exec / observe / cancel / list / close.
 * The session is woken with the completion event when a command exits.
 */
export const KiloResidentTerminal: Plugin = async ({ serverUrl }) => {
  const server = String(serverUrl)
  return {
    tool: {
      terminal_open: tool({
        description:
          "Open a terminal session and return its id. Sessions are non-blocking shell contexts; exec a command, then observe/cancel it. Default cwd is the current project directory.",
        args: {
          cwd: tool.schema.string().optional().describe("working directory for the session (defaults to the project directory)"),
        },
        execute: async (args, context) => {
          const j = await call("/terminal/open", {
            method: "POST",
            body: JSON.stringify({ cwd: args.cwd ?? context.directory, sessionID: context.sessionID, directory: context.directory, serverUrl: server }),
          })
          const t = j.terminal as { ok: boolean; id: number; cwd: string; reason?: string }
          if (!t.ok) return `open failed: ${t.reason}`
          return `terminal ${t.id} opened (cwd=${t.cwd})`
        },
      }),

      terminal_exec: tool({
        description:
          "Run a shell command in a terminal session (non-blocking, returns immediately). Errors if the session is busy or exited. You will be woken when the command finishes.",
        args: {
          id: tool.schema.number().describe("terminal session id"),
          command: tool.schema.string().describe("shell command to run"),
        },
        execute: async (args, context) => {
          const j = await call("/terminal/exec", {
            method: "POST",
            body: JSON.stringify({ id: args.id, command: args.command, sessionID: context.sessionID, directory: context.directory, serverUrl: server }),
          })
          const t = j.terminal as { ok: boolean; id: number; reason?: string }
          if (!t.ok) return `exec rejected: ${t.reason}`
          return `terminal ${t.id} started (non-blocking); observe it or wait for the completion wake.`
        },
      }),

      terminal_observe: tool({
        description:
          "Read a terminal session's output. Without offset, returns output since the last read (cursor) and advances it. With offset, returns history from that byte offset.",
        args: {
          id: tool.schema.number().describe("terminal session id"),
          offset: tool.schema.number().optional().describe("byte offset to read history from (omit to read new output)"),
          limit: tool.schema.number().optional().describe("max bytes to read"),
        },
        execute: async (args) => {
          const j = await call("/terminal/observe", {
            method: "POST",
            body: JSON.stringify({ id: args.id, offset: args.offset, limit: args.limit }),
          })
          const t = j.terminal as any
          if (!t.ok) return `observe failed: ${t.reason}`
          return fmtObserve(t)
        },
      }),

      terminal_cancel: tool({
        description: "Cancel the command currently running in a terminal session (SIGTERM to the process group, then SIGKILL). Fires the completion event.",
        args: { id: tool.schema.number().describe("terminal session id") },
        execute: async (args) => {
          const j = await call("/terminal/cancel", { method: "POST", body: JSON.stringify({ id: args.id }) })
          const t = j.terminal as { ok: boolean; id: number; state: string; reason?: string }
          if (!t.ok) return `cancel failed: ${t.reason}`
          return `terminal ${t.id} state=${t.state}`
        },
      }),

      terminal_list: tool({
        description: "List terminal sessions and their state.",
        args: {},
        execute: async () => {
          const j = await call("/terminal")
          const list = (j.sessions ?? []) as any[]
          if (list.length === 0) return "No terminal sessions."
          return list
            .map((t) => `terminal ${t.id}  state=${t.state}  cwd=${t.cwd}  exit=${t.exitCode ?? "-"}${t.command ? `  cmd=${t.command}` : ""}`)
            .join("\n")
        },
      }),

      terminal_close: tool({
        description: "Close a terminal session (cancels first if busy).",
        args: { id: tool.schema.number().describe("terminal session id") },
        execute: async (args) => {
          const j = await call("/terminal/close", { method: "POST", body: JSON.stringify({ id: args.id }) })
          const t = j.terminal as { ok: boolean; id: number; state: string; reason?: string }
          if (!t.ok) return `close failed: ${t.reason}`
          return `terminal ${t.id} closed`
        },
      }),
    },
  }
}
