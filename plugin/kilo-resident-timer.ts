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

/** Timer tools backed by the resident bridge's loopback control API. */
export const KiloResidentTimer: Plugin = async ({ directory }) => {
  return {
    tool: {
      set_timer: tool({
        description:
          "Set a wall-clock timer (alarm). It fires at the given delay or absolute time, notifies the user on their channel, and wakes this session with the title/notes. Use this for reminders and for 'come back later'.",
        args: {
          title: tool.schema.string().describe("short reason for the timer; shown when it fires"),
          notes: tool.schema.string().optional().describe("optional extra context"),
          delaySec: tool.schema.number().optional().describe("fire after this many seconds"),
          at: tool.schema.string().optional().describe("absolute ISO-8601 wall-clock time to fire"),
        },
        execute: async (args, context) => {
          const j = await call("/timers", {
            method: "POST",
            body: JSON.stringify({ sessionID: context.sessionID, directory, ...args }),
          })
          const t = j.timer as { id: string; fireAt: number; title: string }
          return `Timer ${t.id} set for ${new Date(t.fireAt).toLocaleString()} — ${t.title}`
        },
      }),

      cancel_timer: tool({
        description: "Cancel a pending timer by id.",
        args: { id: tool.schema.string().describe("timer id") },
        execute: async (args) => {
          const j = await call("/timers/cancel", { method: "POST", body: JSON.stringify({ id: args.id }) })
          const t = j.timer as { id: string } | null
          return t ? `Cancelled ${t.id}` : `No pending timer ${args.id}`
        },
      }),

      list_timers: tool({
        description: "List pending timers.",
        args: {},
        execute: async () => {
          const j = await call("/timers")
          const list = (j.timers ?? []).filter((t: { status: string }) => t.status === "pending")
          if (list.length === 0) return "No pending timers."
          return list
            .map((t: { id: string; fireAt: number; title: string }) => `${t.id}  ${new Date(t.fireAt).toLocaleString()}  ${t.title}`)
            .join("\n")
        },
      }),
    },
  }
}
