// Unit test (no daemon): canonical /models list ordering, /models switch, and the reply model header.
import { mkdirSync } from "node:fs"
import { Bridge } from "../src/bridge.ts"
import { buildModelList, formatModelHeader, modelKey, renderModelList } from "../src/models.ts"

const DIR = "/tmp/kilo/model-switch"
mkdirSync(DIR, { recursive: true })

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

const WHITELIST = ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro", "moonshotai-cn/kimi-k3"]
const deepseek = (mid: string): { providerID: string; modelID: string } => {
  return { providerID: "deepseek", modelID: mid }
}

// buildModelList: fixed whitelist order, current appended only when not whitelisted.
{
  const list = buildModelList(WHITELIST, { providerID: "moonshotai-cn", modelID: "kimi-k2.6" })
  check("whitelist order fixed", modelKey(list[0]) === "deepseek/deepseek-flash" && modelKey(list[2]) === "moonshotai-cn/kimi-k3")
  check("current appended at end", modelKey(list[3]) === "moonshotai-cn/kimi-k2.6")
  const inList = buildModelList(WHITELIST, deepseek("deepseek-v4-pro"))
  check("current in whitelist not duplicated", inList.length === 3 && modelKey(inList[1]) === "deepseek/deepseek-v4-pro")
  check("no current -> whitelist only", buildModelList(WHITELIST, undefined).length === 3)
  const filtered = buildModelList(["bad", "no-slash", "deepseek/deepseek-flash"], undefined)
  check("invalid specs skipped", filtered.length === 1 && modelKey(filtered[0]) === "deepseek/deepseek-flash")
}

// Header + listing formatting.
{
  check("header format", formatModelHeader(deepseek("deepseek-flash")) === "▸ deepseek/deepseek-flash\n")
  check("header empty without model", formatModelHeader(undefined) === "")
  const list = buildModelList(WHITELIST, deepseek("deepseek-flash"))
  const text = renderModelList(list, deepseek("deepseek-flash"), undefined)
  check("render marks current", text.includes("（当前）") && text.includes("1. deepseek/deepseek-flash"), text)
  const pending = renderModelList(list, undefined, deepseek("deepseek-v4-pro"))
  check("render marks pending", pending.includes("下一条消息生效"), pending)
}

const newBridge = (over: Record<string, unknown> = {}) => {
  const cfg: any = {
    model: { providerID: "deepseek", modelID: "deepseek-flash" },
    models: WHITELIST,
    daemon: { url: "http://127.0.0.1:4097" },
    accounts: [],
    bots: [{ name: "TEST", directory: DIR }],
    queue: { maxWaitMs: 600_000, coalesceMs: 15 },
    control: { port: 0, token: "x" },
    wake: { mode: "async" },
    ...over,
  }
  const bridge: any = new Bridge(cfg, { sessions: { TEST: "ses-1" }, timers: [], contextWatches: [] }, `${DIR}/state.json`, new Map())
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
  return { bridge, rt, sent }
}

// /models: list, then switch by canonical index; out-of-range rejected.
{
  const { bridge, rt, sent } = newBridge()
  bridge.client = { session: { messages: async () => ({ data: [] }) } }
  await bridge.handleCommand(rt, { chatId: "c", text: "/models", openId: "o1" })
  check("models list shows whitelist", sent.at(-1)?.includes("deepseek/deepseek-v4-pro") === true, sent.at(-1))
  await bridge.handleCommand(rt, { chatId: "c", text: "/models 2", openId: "o1" })
  check("switch sets pending-model", modelKey(rt.pendingModel) === "deepseek/deepseek-v4-pro", JSON.stringify(rt.pendingModel))
  await bridge.handleCommand(rt, { chatId: "c", text: "/models 9", openId: "o1" })
  check("out-of-range rejected", sent.at(-1)?.includes("超出范围") === true, sent.at(-1))
}

// resolveReply prefixes the answering model, and the toggle can disable it.
{
  const { bridge, rt, sent } = newBridge()
  rt.busy = true
  rt.inflight = { injectedId: "msg-1", chatId: "c", since: Date.now() }
  bridge.client = {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", parentID: "msg-1", providerID: "deepseek", modelID: "deepseek-v4-pro", time: { created: 1, completed: 2 } },
            parts: [{ type: "text", text: "hello", time: {} }],
          },
        ],
      }),
    },
  }
  const settled = await bridge.resolveReply(rt, rt.inflight)
  check("resolveReply settled", settled === true)
  check("header prefixed", sent[0] === "▸ deepseek/deepseek-v4-pro\nhello", JSON.stringify(sent))

  bridge.cfg.bots[0].modelHeader = false
  sent.length = 0
  await bridge.resolveReply(rt, rt.inflight)
  check("header can be disabled", sent[0] === "hello", JSON.stringify(sent))
}

// /new (Feishu) defaults the fresh session to the first whitelisted model.
{
  const { bridge, rt, sent } = newBridge()
  bridge.client = { session: { create: async () => ({ data: { id: "ses-2" } }) } }
  await bridge.handleCommand(rt, { chatId: "c", text: "/new", openId: "o1" })
  check("/new re-pins to the new session", rt.sessionId === "ses-2", rt.sessionId)
  const key = rt.pendingModel ? modelKey(rt.pendingModel) : "?"
  check("/new defaults to first whitelist model", key === "deepseek/deepseek-flash", key)
  check("/new reply names the model", sent.at(-1)?.includes("deepseek/deepseek-flash") === true, sent.at(-1))
}

// Empty whitelist: /new keeps the old behavior (no override -> server default).
{
  const { bridge, rt } = newBridge({ models: [] })
  bridge.client = { session: { create: async () => ({ data: { id: "ses-3" } }) } }
  await bridge.handleCommand(rt, { chatId: "c", text: "/new", openId: "o1" })
  check("/new empty whitelist keeps server default", rt.pendingModel === undefined, JSON.stringify(rt.pendingModel))
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
