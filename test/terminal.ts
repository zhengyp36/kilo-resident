import { TerminalManager, type TerminalSession } from "../src/terminal.ts"
import { setTimeout as sleep } from "node:timers/promises"

const done: TerminalSession[] = []
const reminds: TerminalSession[] = []
const mgr = new TerminalManager({ defaultCwd: process.cwd(), onDone: (s) => done.push(s), onRemind: (s) => reminds.push(s) })
let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

const { id } = mgr.open({})
check("open returns id", id === 1)

const e1 = mgr.exec(id, "printf 'a\\n'; sleep 0.4; printf 'b\\n'")
check("exec starts", e1.ok && e1.started === true)

const e2 = mgr.exec(id, "echo nope")
check("exec busy rejected", !e2.ok && e2.reason === "busy")

await sleep(150)
const o1 = mgr.observe(id)
check("observe busy state", o1.state === "busy")
const first = o1.output ?? ""
check("observe has early output", first.includes("a"))

await sleep(600)
const o2 = mgr.observe(id, 0, 4096)
check("observe after done idle", o2.state === "idle")
check("observe exit code 0", o2.exitCode === 0)
check("observe incremental got b", (o2.output ?? "").includes("b"))
check("done fired once", done.length === 1, `count=${done.length}`)
check("done session id", done[0]?.id === id)

const e3 = mgr.exec(id, "sleep 30")
check("re-exec after idle", e3.ok === true)
check("list shows busy", mgr.list().find((s) => s.id === id)?.state === "busy")
const t0 = Date.now()
await mgr.cancel(id)
const dt = Date.now() - t0
check("cancel terminates quickly", dt < 3000, `${dt}ms`)
await sleep(100)
check("cancelled done fired", done.length === 2)
check("done marked cancelled", done[1]?.cancelled === true)
check("state idle after cancel", mgr.list().find((s) => s.id === id)?.state === "idle")

await mgr.close(id)
check("close sets exited", mgr.list().find((s) => s.id === id)?.state === "exited")
const e4 = mgr.exec(id, "echo x")
check("exec after close rejected", !e4.ok && e4.reason === "exited")

const { id: rid } = mgr.open({})
const e5 = mgr.exec(rid, "sleep 1", undefined, 0.2)
check("exec with reminder starts", e5.ok === true)
await sleep(400)
check("reminder fired once", reminds.length === 1, `count=${reminds.length}`)

const n1 = mgr.notify(rid, 0.2)
check("re-arm accepted", n1.ok === true && n1.afterSec === 0.2)
await sleep(400)
check("reminder fired twice", reminds.length === 2, `count=${reminds.length}`)

const n2 = mgr.notify(rid, 0)
check("cancel accepted", n2.ok === true && n2.afterSec === 0)
await sleep(300)
check("no reminder after cancel", reminds.length === 2, `count=${reminds.length}`)

await mgr.cancel(rid)
await sleep(100)
const n3 = mgr.notify(rid, 5)
check("notify rejected when idle", !n3.ok && n3.reason === "idle")

const e6 = mgr.exec(rid, "echo hi", undefined, 1)
check("short exec with reminder starts", e6.ok === true)
await sleep(1400)
check("finish clears pending reminder", reminds.length === 2, `count=${reminds.length}`)

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
