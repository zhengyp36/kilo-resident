// Unit test (no daemon needed): /new and /pin refuse to switch sessions while a turn is in
// flight, so the in-flight reply is never silently dropped. Also covers switchSession mechanics.
import { mkdirSync } from "node:fs"
import { Bridge } from "../src/bridge.ts"

const DIR = "/tmp/kilo/switch-busy-guard"
mkdirSync(DIR, { recursive: true })

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

const cfg: any = {
  model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
  daemon: { url: "http://127.0.0.1:4097" },
  accounts: [],
  bots: [{ name: "TEST", directory: DIR }],
  permissions: { allow: [], approvalTimeoutSec: 300, maxRetries: 3 },
  control: { port: 0, token: "x" },
  wake: { mode: "async" },
}
const state: any = { sessions: { TEST: "ses-old" }, timers: [], contextWatches: [] }
const bridge: any = new Bridge(cfg, state, "/tmp/kilo/switch-busy-guard-state.json", new Map())

const sent: string[] = []
const mkRt = (busy: boolean): any => ({
  name: "TEST",
  directory: DIR,
  sessionId: "ses-old",
  feishu: { sendText: async (_chatId: string, text: string) => void sent.push(text) },
  busy,
  inflight: busy ? { injectedId: "msg_1", chatId: "chat-1", since: Date.now() } : undefined,
  chats: new Map(),
})
const msg = (text: string): any => ({ messageId: `m-${text}`, chatId: "chat-1", text, openId: "o1" })

// Busy: /new rejected before creating a session (no daemon needed on this path).
{
  const rt = mkRt(true)
  await bridge.handleCommand(rt, msg("/new"))
  check("/new busy replies busy", sent.at(-1)?.includes("正忙") === true, sent.at(-1))
  check("/new busy keeps session", rt.sessionId === "ses-old", rt.sessionId)
  check("/new busy keeps inflight", rt.inflight?.injectedId === "msg_1")
  check("/new busy does not re-pin state", state.sessions.TEST === "ses-old", String(state.sessions.TEST))
}

// Busy: /pin rejected before arg validation or any switch.
{
  const rt = mkRt(true)
  await bridge.handleCommand(rt, msg("/pin 1"))
  check("/pin busy replies busy", sent.at(-1)?.includes("正忙") === true, sent.at(-1))
  check("/pin busy keeps session", rt.sessionId === "ses-old", rt.sessionId)
  check("/pin busy keeps inflight", rt.inflight?.injectedId === "msg_1")
}

// switchSession still switches when invoked with a live inflight (defensive warn path);
// assert the state mechanics stay intact.
{
  const rt = mkRt(true)
  bridge.runtimes.set("ses-old", rt)
  const prev = bridge.switchSession(rt, "ses-new")
  check("switchSession returns previous id", prev === "ses-old", prev)
  check(
    "switchSession re-keys runtime",
    bridge.runtimes.get("ses-new") === rt && bridge.runtimes.get("ses-old") === undefined,
  )
  check("switchSession clears inflight/busy", rt.inflight === undefined && rt.busy === false)
  check("switchSession re-pins state", state.sessions.TEST === "ses-new", String(state.sessions.TEST))
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
