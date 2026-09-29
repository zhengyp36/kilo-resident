// Integration test: bridge control API -> handoff a fresh session and confirm it runs.
// Requires: kilo serve on :4097 (kilo:kilo) and the bridge running.
import { createKiloClient } from "@kilocode/sdk"
import { mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DIRECTORY = "/tmp/kilo/handoff-itest"
const auth = { Authorization: `Basic ${Buffer.from("kilo:kilo").toString("base64")}` }
const client = createKiloClient({ baseUrl: "http://127.0.0.1:4097", headers: auth })

const { url, token } = JSON.parse(readFileSync(join(homedir(), ".local", "state", "kilo-resident", "control.json"), "utf8"))
const api = async (path: string, init?: RequestInit): Promise<any> => {
  const r = await fetch(url + path, {
    ...init,
    headers: { "content-type": "application/json", "x-token": token, ...(init?.headers ?? {}) },
  })
  return r.json()
}

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

mkdirSync(DIRECTORY, { recursive: true })

const bad = await api("/handoff", {
  method: "POST",
  body: JSON.stringify({ title: "", message: "x", directory: DIRECTORY }),
})
check("missing title rejected", bad.handoff?.ok === false, JSON.stringify(bad.handoff))

const title = `handoff-itest-${Date.now().toString(36)}`
const res = await api("/handoff", {
  method: "POST",
  body: JSON.stringify({ title, message: "Reply with exactly: ok", directory: DIRECTORY, timeoutSec: 90 }),
})
const h = res.handoff ?? {}
check("handoff started", h.ok === true, JSON.stringify(h))
check("has session id", typeof h.sessionID === "string" && h.sessionID.startsWith("ses_"), h.sessionID)
check("state reported", h.state === "running" || h.state === "completed", h.state)

if (h.sessionID) {
  const list = await client.session.list({ query: { directory: DIRECTORY } })
  const found = (list.data ?? []).find((s) => s.id === h.sessionID)
  check("session exists in directory", !!found)
  check("session title matches", found?.title === title, found?.title)
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log("\nall handoff tests passed")
