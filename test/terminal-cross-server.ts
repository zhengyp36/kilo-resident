// Integration test: a session on a DIFFERENT server (not the bridge daemon) still
// receives the terminal completion wake, because the plugin passes its serverUrl.
// Requires: kilo serve on :4097 (kilo:kilo) with the bridge, and :4098 (no auth).
import { createKiloClient } from "@kilocode/sdk"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const DIRECTORY = "/tmp/kilo"
const SERVER = "http://127.0.0.1:4098"
const client = createKiloClient({ baseUrl: SERVER })

const { url, token } = JSON.parse(readFileSync(join(homedir(), ".local", "state", "kilo-resident", "control.json"), "utf8"))
const api = async (path: string, init?: RequestInit): Promise<any> => {
  const r = await fetch(url + path, { ...init, headers: { "content-type": "application/json", "x-token": token, ...(init?.headers ?? {}) } })
  return r.json()
}

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

const session = await client.session.create({ body: { title: "cross-server" }, query: { directory: DIRECTORY } })
const sid = session.data!.id
console.log("session on", SERVER, ":", sid)

try {
  const open = await api("/terminal/open", { method: "POST", body: JSON.stringify({ cwd: DIRECTORY, sessionID: sid, directory: DIRECTORY, serverUrl: SERVER }) })
  const id = open.terminal.id
  const exec = await api("/terminal/exec", { method: "POST", body: JSON.stringify({ id, command: "echo CROSS_SERVER_DONE", sessionID: sid, directory: DIRECTORY, serverUrl: SERVER }) })
  check("exec started", exec.terminal.ok === true)

  let wake = null
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    const msgs = await client.session.messages({ path: { id: sid }, query: { directory: DIRECTORY } })
    wake = (msgs.data ?? []).find((m) => m.info.role === "user" && (m.parts ?? []).some((p) => p.type === "text" && p.text.includes("[terminal ")))
    if (wake) break
  }
  check("wake reached cross-server session", !!wake)
  if (wake) check("wake has output", wake.parts.some((p) => p.type === "text" && p.text.includes("CROSS_SERVER_DONE")))
  await api("/terminal/close", { method: "POST", body: JSON.stringify({ id }) })
} finally {
  await client.session.delete({ path: { id: sid }, query: { directory: DIRECTORY } }).catch(() => {})
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
