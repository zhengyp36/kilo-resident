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
 * Explicit, per-session context-length watch backed by the resident bridge. Start it when you want
 * to be told before the context gets too long; it checks on an interval and notifies once when the
 * threshold is crossed, then ends itself. Nothing is sent while under the threshold.
 */
export const KiloResidentContext: Plugin = async ({ directory }) => {
  return {
    tool: {
      start_context_watch: tool({
        description:
          "Start watching this session's context length. Checks every intervalSec; when the context exceeds thresholdK (K tokens), it notifies this session once with your message and stops. Nothing is sent while under the threshold. Use this to get a heads-up before compaction is needed.",
        args: {
          thresholdK: tool.schema.number().describe("threshold in K tokens, e.g. 200 means 200k"),
          message: tool.schema.string().describe("notification text delivered when the threshold is crossed"),
          intervalSec: tool.schema.number().optional().describe("check interval in seconds (default 60)"),
        },
        execute: async (args, context) => {
          const j = await call("/context-watches", {
            method: "POST",
            body: JSON.stringify({ sessionID: context.sessionID, directory, ...args }),
          })
          const w = j.watch as { id: string; threshold: number; intervalSec: number }
          return `Context watch ${w.id} started: every ${w.intervalSec}s, threshold ${Math.round(w.threshold / 1000)}k tokens.`
        },
      }),

      cancel_context_watch: tool({
        description: "Cancel a pending context watch by id.",
        args: { id: tool.schema.string().describe("watch id") },
        execute: async (args, context) => {
          const j = await call("/context-watches/cancel", {
            method: "POST",
            body: JSON.stringify({ id: args.id, sessionID: context.sessionID }),
          })
          const w = j.watch as { id: string } | null
          return w ? `Cancelled ${w.id}` : `No active context watch ${args.id}`
        },
      }),

      list_context_watches: tool({
        description: "List active context watches for this session.",
        args: {},
        execute: async (_args, context) => {
          const j = await call(`/context-watches?sessionID=${encodeURIComponent(context.sessionID)}`)
          const list = (j.watches ?? []).filter((w: { status: string }) => w.status === "watching")
          if (list.length === 0) return "No active context watches."
          return list
            .map((w: { id: string; threshold: number; intervalSec: number; lastTokens?: number; message: string }) => {
              const cur = w.lastTokens != null ? `${Math.round(w.lastTokens / 1000)}k` : "?"
              return `${w.id}  ${cur}/${Math.round(w.threshold / 1000)}k  every ${w.intervalSec}s  ${w.message}`
            })
            .join("\n")
        },
      }),
    },
  }
}
