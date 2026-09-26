// Unit test: TerminalManager session isolation.
import { TerminalManager, type TerminalSession } from "../src/terminal.ts"
import { setTimeout as sleep } from "node:timers/promises"

const done: TerminalSession[] = []
const mgr = new TerminalManager({ defaultCwd: process.cwd(), onDone: (s) => done.push(s), onRemind: () => {} })
let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

const a = mgr.open({ sessionID: "sessA" })
check("A opens own terminal", a.ok && Number.isInteger(a.id))
const aId = a.id

check("B list empty", mgr.list("sessB").length === 0, JSON.stringify(mgr.list("sessB")))
check("A list has it", mgr.list("sessA").some((s) => s.id === aId))
check("legacy list (no caller) sees all", mgr.list().some((s) => s.id === aId))

const exB = mgr.exec(aId, "echo hacked", { sessionID: "sessB" })
check("B exec denied", !exB.ok && exB.reason === "not yours", JSON.stringify(exB))
const obB = mgr.observe(aId, undefined, undefined, "sessB")
check("B observe denied", !obB.ok && obB.reason === "not yours", JSON.stringify(obB))
const ntB = mgr.notify(aId, 1, "sessB")
check("B notify denied", !ntB.ok && ntB.reason === "not yours", JSON.stringify(ntB))
const cnB = await mgr.cancel(aId, "sessB")
check("B cancel denied", !cnB.ok && cnB.reason === "not yours", JSON.stringify(cnB))
const clB = await mgr.close(aId, "sessB")
check("B close denied", !clB.ok && clB.reason === "not yours", JSON.stringify(clB))

const exA = mgr.exec(aId, "echo hello", { sessionID: "sessA" })
check("A exec ok", exA.ok === true, JSON.stringify(exA))
await sleep(350)
const obA = mgr.observe(aId, undefined, undefined, "sessA")
check("A observe ok", obA.ok === true && String(obA.output).includes("hello"), JSON.stringify(obA.output))
check("done fired for A", done.length === 1 && done[0]?.ownerSessionID === "sessA")

// An unowned terminal opened by a non-session caller is claimable and then isolated.
const u = mgr.open({})
check("unowned visible to legacy", mgr.list().some((s) => s.id === u.id))
check("unowned hidden from A", !mgr.list("sessA").some((s) => s.id === u.id))
const claim = mgr.exec(u.id, "echo claimed", { sessionID: "sessB" })
check("B claims unowned terminal", claim.ok === true, JSON.stringify(claim))
check("claimed now visible to B", mgr.list("sessB").some((s) => s.id === u.id))
check("claimed hidden from A", !mgr.list("sessA").some((s) => s.id === u.id))

await mgr.cancel(aId, "sessA")
await mgr.close(aId, "sessA")
await mgr.cancel(u.id, "sessB")
await mgr.close(u.id, "sessB")

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
