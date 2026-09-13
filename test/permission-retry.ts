// Integration test: a non-whitelisted permission.asked expires (released, not
// erased), then /retry re-drives the session and the model re-raises a NEW
// permission.asked. Requires: kilo serve on :4097 (kilo:kilo), deepseek model,
// and the bridge driven in-process with a stub Feishu channel.
import { createKiloClient } from "@kilocode/sdk"
import { mkdirSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Bridge } from "../src/bridge.ts"
import { SessionQueue } from "../src/queue.ts"

const DAEMON = process.env.KILO_DAEMON ?? "http://127.0.0.1:4097"
const DIR = "/tmp/kilo/perm-retry"
const MODEL = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
const auth = { Authorization: `Basic ${Buffer.from("kilo:kilo").toString("base64")}` }
const client = createKiloClient({ baseUrl: DAEMON, headers: auth })

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(250)
  }
  return fn()
}

mkdirSync(DIR, { recursive: true })
writeFileSync(`${DIR}/f`, "x")

const sent: { chatId: string; text: string }[] = []
const cfg: any = {
  model: MODEL,
  daemon: { url: DAEMON },
  accounts: [],
  bots: [],
  permissions: { allow: [], approvalTimeoutSec: 3, maxRetries: 3 },
  control: { port: 0, token: "x" },
  wake: { mode: "async" },
}
const state: any = { sessions: {}, timers: [] }
const bridge: any = new Bridge(cfg, state, "/tmp/kilo/perm-retry-state.json", new Map())

const session = await client.session.create({ body: { title: "perm-retry" }, query: { directory: DIR } })
const sid = session.data!.id
console.log("session:", sid)

const rt: any = {
  name: "TEST",
  directory: DIR,
  sessionId: sid,
  feishu: { sendText: async (chatId: string, text: string) => void sent.push({ chatId, text }) },
  busy: false,
  queue: new SessionQueue(600_000, () => {}),
  wakes: [],
  lastChatId: "chat-test",
}
bridge.runtimes.set(sid, rt)
bridge.byBot.set("TEST", rt)
void bridge.subscribeEvents(DIR)

try {
  client.session
    .prompt({
      path: { id: sid },
      query: { directory: DIR },
      body: {
        model: MODEL,
        parts: [{ type: "text", text: "Use the bash tool to run exactly: chmod 777 /tmp/kilo/perm-retry/f . Then reply with exactly DONE" }],
      },
    })
    .catch(() => {})

  check("first permission.asked", await waitFor(() => bridge.pendingPermissions.size > 0, 45_000))
  const id1 = [...bridge.pendingPermissions.keys()][0]
  console.log("first id:", id1)

  check("feishu asked notice", sent.some((s) => s.text.includes("需要审批")))
  check("expired after timeout", await waitFor(() => bridge.pendingPermissions.get(id1)?.expired === true, 15_000))
  check("record kept as expired", bridge.pendingPermissions.has(id1) === true)
  check("feishu release notice", sent.some((s) => s.text.includes("超时，已释放")))

  await bridge.handleCommand(rt, { messageId: "m-retry", chatId: "chat-test", text: `/retry ${id1}` })
  check("retry ack", sent.some((s) => s.text.includes("已请求重新发起")))

  check(
    "second permission.asked after retry",
    await waitFor(() => [...bridge.pendingPermissions.keys()].some((k) => k !== id1), 60_000),
  )
  const id2 = [...bridge.pendingPermissions.keys()].find((k) => k !== id1)
  console.log("second id:", id2)
} finally {
  await client.session.delete({ path: { id: sid }, query: { directory: DIR } }).catch(() => {})
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
