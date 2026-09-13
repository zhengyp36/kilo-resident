// Unit test (no daemon needed): permission.asked with no human DM yet routes the
// approval notice to the bot's configured notifyChat instead of a lastChatId.
import { mkdirSync } from "node:fs"
import { Bridge } from "../src/bridge.ts"
import { SessionQueue } from "../src/queue.ts"

const DIR = "/tmp/kilo/perm-notify"
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
  bots: [{ name: "TEST", directory: DIR, notifyChat: "chat-notify" }],
  permissions: { allow: [], approvalTimeoutSec: 300, maxRetries: 3 },
  control: { port: 0, token: "x" },
  wake: { mode: "async" },
}
const state: any = { sessions: {}, timers: [] }
const bridge: any = new Bridge(cfg, state, "/tmp/kilo/perm-notify-state.json", new Map())

const sent: { chatId: string; text: string }[] = []
const botRt: any = {
  name: "TEST",
  directory: DIR,
  sessionId: "ses-notify",
  feishu: { sendText: async (chatId: string, text: string) => void sent.push({ chatId, text }) },
  busy: false,
  queue: new SessionQueue(600_000, () => {}),
  wakes: [],
  // lastChatId intentionally absent: the human has not DM'd this bot.
}
bridge.byBot.set("TEST", botRt)

bridge.onPermissionAsked(
  { id: "perm-1", sessionID: "ses-notify", permission: "bash", patterns: ["rm -rf /tmp/x"] },
  DIR,
)

check("notice sent", sent.length === 1, `sent=${sent.length}`)
check("routed to notifyChat", sent[0]?.chatId === "chat-notify", `chatId=${sent[0]?.chatId}`)
check("notice text", !!sent[0]?.text.includes("需要审批"), sent[0]?.text ?? "")
check("pending recorded", bridge.pendingPermissions.has("perm-1"))

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
