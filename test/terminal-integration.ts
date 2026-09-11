// Integration test: bridge control API -> terminal session -> completion wake.
// Requires: kilo serve on :4097 (kilo:kilo) and the bridge running.
import { createKiloClient } from "@kilocode/sdk"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const DIRECTORY = "/home/zhengyp/work/B/locus"
const MODEL = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
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

const session = await client.session.create({ body: { title: "terminal-itest" }, query: { directory: DIRECTORY } })
const sid = session.data!.id
console.log("session:", sid)

try {
  const open = await api("/terminal/open", { method: "POST", body: JSON.stringify({ cwd: DIRECTORY, sessionID: sid, directory: DIRECTORY }) })
  const id = open.terminal.id
  check("open", open.terminal.ok === true && Number.isInteger(id))

  const exec = await api("/terminal/exec", {
    method: "POST",
    body: JSON.stringify({ id, command: "for i in 1 2 3; do echo line$i; sleep 0.4; done", sessionID: sid, directory: DIRECTORY }),
  })
  check("exec started", exec.terminal.ok === true && exec.terminal.started === true)

  const busy = await api("/terminal/exec", { method: "POST", body: JSON.stringify({ id, command: "echo no", sessionID: sid, directory: DIRECTORY }) })
  check("busy rejected", busy.terminal.ok === false && busy.terminal.reason === "busy")

  await sleep(500)
  const mid = await api("/terminal/observe", { method: "POST", body: JSON.stringify({ id }) })
  check("observe busy", mid.terminal.state === "busy", JSON.stringify(mid.terminal.output))
  check("observe saw line1", String(mid.terminal.output).includes("line1"))

  await sleep(2000)
  const after = await api("/terminal/observe", { method: "POST", body: JSON.stringify({ id }) })
  check("observe idle+0", after.terminal.state === "idle" && after.terminal.exitCode === 0, JSON.stringify(after.terminal.output))

  const list = await api("/terminal")
  check("list contains session", list.sessions.some((s: { id: number }) => s.id === id))

  // completion wake: bridge injects a user message into the owner session
  await sleep(1500)
  const msgs = await client.session.messages({ path: { id: sid }, query: { directory: DIRECTORY } })
  const wake = (msgs.data ?? []).find((m) => m.info.role === "user" && (m.parts ?? []).some((p) => p.type === "text" && p.text.includes(`[terminal ${id}]`)))
  check("completion wake injected into session", !!wake, wake ? "" : "no [terminal] user message found")

  await api("/terminal/close", { method: "POST", body: JSON.stringify({ id }) })
} finally {
  await client.session.delete({ path: { id: sid }, query: { directory: DIRECTORY } }).catch(() => {})
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
