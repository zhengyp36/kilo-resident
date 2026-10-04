// Unit test (no daemon/network): receipt ack modes + unsupported-type hint routing.
import { mkdirSync } from "node:fs"
import { Bridge } from "../src/bridge.ts"
import { SessionQueue } from "../src/queue.ts"

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
  queue: new SessionQueue(600_000, () => {}),
}
bridge.byBot.set("TEST", rt)
bridge.runtimes.set("ses-1", rt)
bridge.inject = async () => {} // avoid touching the daemon

const inbound = (over: Record<string, unknown> = {}) => ({
  messageId: `m-${Math.random().toString(36).slice(2)}`,
  chatId: "c1",
  text: "hi",
  openId: "o1",
  messageType: "text",
  ...over,
})

// always: direct message gets an immediate "processing" ack.
{
  sent.length = 0
  rt.busy = false
  bridge.onInbound("TEST", inbound())
  check("always direct acks processing", sent.some((t) => t.includes("处理中")), JSON.stringify(sent))
}

// always: busy message gets a queued ack.
{
  sent.length = 0
  rt.busy = true
  rt.inflight = { injectedId: "x", chatId: "c1", since: Date.now() }
  bridge.onInbound("TEST", inbound())
  check("always queued acks queue depth", sent.some((t) => t.includes("前面还有")), JSON.stringify(sent))
  rt.busy = false
  rt.inflight = undefined
}

// unsupported type: hint, and no generic processing ack.
{
  sent.length = 0
  bridge.onInbound("TEST", inbound({ messageType: "audio", unsupported: "语音" }))
  check("unsupported acks with hint", sent.some((t) => t.includes("暂不支持语音")), JSON.stringify(sent))
  check("unsupported sends exactly one message", sent.length === 1, JSON.stringify(sent))
}

// off: silence.
{
  cfg.bots[0].ack = "off"
  sent.length = 0
  bridge.onInbound("TEST", inbound())
  check("off mode sends nothing", sent.length === 0, JSON.stringify(sent))
}

// delayed: quiet at first, then speaks up if no reply lands.
{
  cfg.bots[0].ack = "delayed"
  cfg.bots[0].ackDelayMs = 30
  sent.length = 0
  bridge.onInbound("TEST", inbound())
  check("delayed mode quiet immediately", sent.length === 0, JSON.stringify(sent))
  await sleep(60)
  check("delayed mode acks after the window", sent.some((t) => t.includes("正在处理")), JSON.stringify(sent))
}

// delayed: a real reply cancels the pending ack.
{
  cfg.bots[0].ack = "delayed"
  cfg.bots[0].ackDelayMs = 30
  sent.length = 0
  bridge.onInbound("TEST", inbound())
  bridge.clearAck(rt)
  await sleep(60)
  check("delayed ack cancelled by a reply", sent.length === 0, JSON.stringify(sent))
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
