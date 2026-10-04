// Unit test (no daemon/network): per-chat coalescing queue + batch receipt signals.
import { mkdirSync } from "node:fs"
import { Bridge } from "../src/bridge.ts"

const DIR = "/tmp/kilo/inbound-ack"
mkdirSync(DIR, { recursive: true })

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cfg: any = {
  model: { providerID: "deepseek", modelID: "deepseek-flash" },
  daemon: { url: "http://127.0.0.1:4097" },
  accounts: [{ open_id: "o1", name: "YZ", trust: "superuser" }],
  bots: [{ name: "TEST", directory: DIR, ack: "always" }],
  queue: { maxWaitMs: 600_000, coalesceMs: 15 },
  permissions: { allow: [], approvalTimeoutSec: 300, maxRetries: 3 },
  control: { port: 0, token: "x" },
  wake: { mode: "async" },
}
const state: any = { sessions: { TEST: "ses-1" }, timers: [], contextWatches: [] }
const bridge: any = new Bridge(cfg, state, "/tmp/kilo/inbound-ack-state.json", new Map())

const sent: string[] = []
const rt: any = {
  name: "TEST",
  directory: DIR,
  sessionId: "ses-1",
  feishu: { sendText: async (_c: string, t: string) => void sent.push(t) },
  busy: false,
  chats: new Map(),
}
bridge.byBot.set("TEST", rt)
bridge.runtimes.set("ses-1", rt)

const delivered: string[] = []
bridge.deliver = async (_s: string, _d: string, _m: string, text: string) => {
  delivered.push(text)
  return _m
}

const inbound = (over: Record<string, unknown> = {}) => ({
  messageId: `m-${Math.random().toString(36).slice(2)}`,
  chatId: "c1",
  text: "hi",
  openId: "o1",
  messageType: "text",
  ...over,
})

const reset = () => {
  sent.length = 0
  delivered.length = 0
  rt.busy = false
  rt.inflight = undefined
}

// Coalescing: two same-chat messages within the linger window merge into one prompt.
{
  reset()
  bridge.onInbound("TEST", inbound({ text: "one" }))
  bridge.onInbound("TEST", inbound({ text: "two" }))
  check("coalescing is quiet before the linger", sent.length === 0, JSON.stringify(sent))
  await sleep(60)
  check("merged into one delivery", delivered.length === 1, JSON.stringify(delivered))
  check("merged text keeps both", delivered[0]?.includes("one") && delivered[0]?.includes("two"), delivered[0])
  check("batch start signal", sent.some((t) => t.includes("开始处理")), JSON.stringify(sent))
}

// Busy: the quiet batch reports it is queued, and does not inject yet.
{
  reset()
  rt.busy = true
  rt.inflight = { injectedId: "x", chatId: "c1", since: Date.now() }
  bridge.onInbound("TEST", inbound({ chatId: "c2", text: "while busy" }))
  await sleep(60)
  check("queued signal while busy", sent.some((t) => t.includes("已排队")), JSON.stringify(sent))
  check("busy batch not delivered yet", delivered.length === 0, JSON.stringify(delivered))
  reset()
}

// Different chats never merge.
{
  reset()
  bridge.onInbound("TEST", inbound({ chatId: "cA", text: "A" }))
  bridge.onInbound("TEST", inbound({ chatId: "cB", text: "B" }))
  await sleep(60)
  check(
    "first chat delivered alone",
    delivered.length === 1 && delivered[0].includes("A") && !delivered[0].includes("B"),
    JSON.stringify(delivered),
  )
  check("second chat queued separately", (rt.chats.get("cB")?.queue.size ?? 0) === 1, JSON.stringify([...rt.chats.keys()]))
  rt.busy = false
  rt.inflight = undefined
  rt.chats.get("cB").ready = true
  await bridge.drainChat(rt, rt.chats.get("cB"))
  check("second chat delivered after", delivered.length === 2 && delivered[1].includes("B"), JSON.stringify(delivered))
}

// off: no receipt signals, but still delivered.
{
  reset()
  cfg.bots[0].ack = "off"
  bridge.onInbound("TEST", inbound({ chatId: "cOff", text: "x" }))
  await sleep(60)
  check("off sends no receipt", sent.length === 0, JSON.stringify(sent))
  check("off still delivers", delivered.length === 1, JSON.stringify(delivered))
  cfg.bots[0].ack = "always"
}

// delayed: only speaks up when the batch has to wait.
{
  reset()
  cfg.bots[0].ack = "delayed"
  cfg.bots[0].ackDelayMs = 20
  rt.busy = true
  rt.inflight = { injectedId: "y", chatId: "c1", since: Date.now() }
  bridge.onInbound("TEST", inbound({ chatId: "cDelay", text: "slow" }))
  await sleep(60)
  check("delayed speaks when queued", sent.some((t) => t.includes("已排队")), JSON.stringify(sent))
  cfg.bots[0].ack = "always"
  reset()
}

// unsupported type: single hint, nothing queued.
{
  reset()
  bridge.onInbound("TEST", inbound({ messageType: "audio", unsupported: "语音" }))
  check("unsupported acks with hint", sent.some((t) => t.includes("暂不支持语音")), JSON.stringify(sent))
  check("unsupported sends exactly one message", sent.length === 1, JSON.stringify(sent))
  check("unsupported not delivered", delivered.length === 0, JSON.stringify(delivered))
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
