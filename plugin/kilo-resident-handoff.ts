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

/**
 * Hand-off tool backed by the resident bridge. Starts a fresh Kilo session with a
 * title and first sentence, then confirms it is actually running (or already
 * finished its first turn).
 */
export const KiloResidentHandoff: Plugin = async ({ directory }) => {
  return {
    tool: {
      handoff: tool({
        description:
          "Start a fresh Kilo session with a title and first sentence and confirm it is running. The new session inherits this session's current model unless `model` ('providerID/modelID') overrides it. Use this at the end of a long session to hand off (e.g. context nearly full, or stepping away): write the handoff note first, then hand off with it as the first sentence and stop. The new session is a normal session you can attach to afterwards.",
        args: {
          title: tool.schema.string().describe("session title, e.g. '26/09/29-工程整理-3'"),
          message: tool.schema.string().describe("first sentence / prompt for the new session"),
          directory: tool.schema.string().optional().describe("directory to run in (defaults to this project)"),
          model: tool.schema.string().optional().describe("model for the new session as 'providerID/modelID'; defaults to the calling session's current model"),
          timeoutSec: tool.schema.number().optional().describe("seconds to wait for the session to report running (default 120)"),
        },
        execute: async (args, context) => {
          const j = await call("/handoff", {
            method: "POST",
            body: JSON.stringify({
              title: args.title,
              message: args.message,
              directory: args.directory ?? directory ?? context.directory,
              model: args.model,
              timeoutSec: args.timeoutSec,
              sessionID: context.sessionID,
            }),
          })
          const r = j.handoff as {
            ok: boolean
            title: string
            directory: string
            sessionID?: string
            state?: "running" | "completed"
            error?: string
          }
          if (!r.ok) return `handoff FAILED: ${r.error ?? "unknown"}${r.sessionID ? ` (session ${r.sessionID})` : ""}`
          return `handoff: ${r.state ?? "running"} ${r.sessionID} "${r.title}" (dir=${r.directory})`
        },
      }),
    },
  }
}
