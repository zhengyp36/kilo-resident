import { PhoneManager, formatInbound } from "../src/phone.ts"
import { setTimeout as sleep } from "node:timers/promises"

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

check(
  "formatInbound normal",
  formatInbound({ source: "agent", from: "COGOS002:A0005", content: "hi", round: 2 }) ===
    "[agent来信] COGOS002:A0005 · 第 2 轮：hi",
  formatInbound({ source: "agent", from: "COGOS002:A0005", content: "hi", round: 2 }),
)
check(
  "formatInbound paused",
  formatInbound({ source: "agent", from: "X", content: "hi", round: 6, paused: true, note: "stop" }).includes("已达上限"),
)

const got: any[] = []
const mgr = new PhoneManager(
  { number: "COGOS002:A0006", dataDir: "/tmp/kilo-phone-test", cogosDir: "/tmp" },
  (p) => got.push(p),
)
const url = await mgr.startSink()
check("sink endpoint is loopback", url.startsWith("http://127.0.0.1:"), url)

const r = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ source: "agent", from: "COGOS002:A0005", content: "yo", round: 1 }),
})
check("sink accepts post", r.status === 200)
await sleep(50)
check("inbound delivered", got.length === 1 && got[0].content === "yo", `count=${got.length}`)

check("status not running before open", mgr.status().running === false)
await mgr.close()
check("close clears endpoint", mgr.sinkEndpoint === "")

if (failures > 0) {
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log("\nall phone tests passed")
