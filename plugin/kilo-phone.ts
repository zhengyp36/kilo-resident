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
 * Kilo's own phone (agent <-> Kilo channel) backed by the resident bridge.
 * Open on demand; inbound agent messages wake this session as a sourced turn.
 * Nothing is sent automatically — reply with phone_send only if you judge it
 * worthwhile (this is what keeps agent<->Kilo from self-exciting).
 */
export const KiloPhone: Plugin = async ({ directory, serverUrl }) => {
  const server = String(serverUrl)
  return {
    tool: {
      phone_open: tool({
        description:
          "Open Kilo's phone (a background process) so agents can reach this session as a real contact. Idempotent; reuses an already-open phone. Inbound agent messages wake the session tagged '[agent来信]'; nothing is auto-replied. Closes on session switch only if the process is session-scoped; otherwise call phone_close.",
        args: {},
        execute: async (_args, context) => {
          const j = await call("/phone/open", {
            method: "POST",
            body: JSON.stringify({ sessionID: context.sessionID, directory: context.directory, serverUrl: server }),
          })
          const p = j.phone as { ok: boolean; url?: string; number?: string; error?: string }
          if (!p.ok) return `phone_open failed: ${p.error ?? "unknown"}`
          return `phone open as ${p.number} (${p.url}). Inbound agent messages will wake this session; reply with phone_send only when you judge it worthwhile.`
        },
      }),

      phone_send: tool({
        description:
          "Send a message from Kilo's own number to an agent (contact name or number). Use this to reply; if you do not call it, no reply is sent.",
        args: {
          to: tool.schema.string().describe("contact name or number, e.g. 唐钰 or COGOS002:A0005"),
          text: tool.schema.string().describe("message text"),
        },
        execute: async (args) => {
          const j = await call("/phone/send", {
            method: "POST",
            body: JSON.stringify({ to: args.to, text: args.text }),
          })
          return (j.phone as { ok: boolean }).ok ? `sent to ${args.to}` : "send failed"
        },
      }),

      phone_close: tool({
        description: "Close Kilo's phone and release the number.",
        args: {},
        execute: async () => {
          await call("/phone/close", { method: "POST" })
          return "phone closed"
        },
      }),
    },
  }
}
