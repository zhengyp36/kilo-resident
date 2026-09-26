// Integration test: session isolation at the bridge control API (terminals + timers).
// Requires: the bridge running (reads control.json). Uses opaque fake session ids.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

const A = "isoA_" + Date.now().toString(36)
const B = "isoB_" + Date.now().toString(36)
const DIRECTORY = "/tmp/kilo"

try {
  // ---- terminal isolation ----
  const open = await api("/terminal/open", { method: "POST", body: JSON.stringify({ cwd: DIRECTORY, sessionID: A, directory: DIRECTORY }) })
  const id = open.terminal.id
  check("A opens terminal", open.terminal.ok === true && Number.isInteger(id))

  const listB = await api(`/terminal?sessionID=${encodeURIComponent(B)}`)
  check("B list excludes A's terminal", !(listB.sessions ?? []).some((s: any) => s.id === id), JSON.stringify(listB.sessions))
  const listA = await api(`/terminal?sessionID=${encodeURIComponent(A)}`)
  check("A list includes own terminal", (listA.sessions ?? []).some((s: any) => s.id === id))

  const execB = await api("/terminal/exec", { method: "POST", body: JSON.stringify({ id, command: "echo hacked", sessionID: B }) })
  check("B exec denied", execB.terminal.ok === false && execB.terminal.reason === "not yours", JSON.stringify(execB.terminal))
  const obsB = await api("/terminal/observe", { method: "POST", body: JSON.stringify({ id, sessionID: B }) })
  check("B observe denied", obsB.terminal.ok === false && obsB.terminal.reason === "not yours", JSON.stringify(obsB.terminal))
  const cnlB = await api("/terminal/cancel", { method: "POST", body: JSON.stringify({ id, sessionID: B }) })
  check("B cancel denied", cnlB.terminal.ok === false && cnlB.terminal.reason === "not yours", JSON.stringify(cnlB.terminal))

  const execA = await api("/terminal/exec", { method: "POST", body: JSON.stringify({ id, command: "echo ok_A", sessionID: A }) })
  check("A exec ok", execA.terminal.ok === true && execA.terminal.started === true, JSON.stringify(execA.terminal))

  // ---- timer isolation ----
  const setA = await api("/timers", { method: "POST", body: JSON.stringify({ sessionID: A, directory: DIRECTORY, title: "iso-timer", delaySec: 3600 }) })
  const tid = setA.timer.id
  check("A sets timer", typeof tid === "string")

  const tlistB = await api(`/timers?sessionID=${encodeURIComponent(B)}`)
  check("B list excludes A's timer", !(tlistB.timers ?? []).some((t: any) => t.id === tid && t.status === "pending"), JSON.stringify(tlistB.timers))
  const tlistA = await api(`/timers?sessionID=${encodeURIComponent(A)}`)
  check("A list includes own timer", (tlistA.timers ?? []).some((t: any) => t.id === tid && t.status === "pending"))

  const tcancelB = await api("/timers/cancel", { method: "POST", body: JSON.stringify({ id: tid, sessionID: B }) })
  check("B cancel timer denied", tcancelB.timer === null, JSON.stringify(tcancelB))
  const still = await api(`/timers?sessionID=${encodeURIComponent(A)}`)
  check("timer still pending after B attempt", (still.timers ?? []).some((t: any) => t.id === tid && t.status === "pending"))

  const tcancelA = await api("/timers/cancel", { method: "POST", body: JSON.stringify({ id: tid, sessionID: A }) })
  check("A cancel timer ok", tcancelA.timer?.id === tid && tcancelA.timer?.status === "cancelled", JSON.stringify(tcancelA))

  await api("/terminal/close", { method: "POST", body: JSON.stringify({ id, sessionID: A }) })
} catch (err) {
  check("no exception", false, String(err))
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
