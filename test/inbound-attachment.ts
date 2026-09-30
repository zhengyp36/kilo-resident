import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { FeishuBot, type InboundMessage } from "../src/feishu.ts"

let failures = 0
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`)
  if (!cond) failures++
}

function makeBot(): { bot: FeishuBot; calls: { type: string; file_key: string }[] } {
  const calls: { type: string; file_key: string }[] = []
  const bot = new FeishuBot({ name: "T", app_id: "x", app_secret: "y" }, () => {})
  ;(bot.client.im.messageResource as any).get = async (payload: { params: { type: string }; path: { file_key: string } }) => {
    calls.push({ type: payload.params.type, file_key: payload.path.file_key })
    return {
      headers: { "content-type": "image/png" },
      getReadableStream: () => null,
      writeFile: async (p: string) => writeFileSync(p, "PNG"),
    }
  }
  return { bot, calls }
}

async function deliver(bot: FeishuBot, data: unknown): Promise<InboundMessage> {
  const got = await new Promise<InboundMessage>((resolve) => {
    ;(bot as any).onMessage = (m: InboundMessage) => resolve(m)
    void (bot as any).handle(data)
  })
  return got
}

const imageData = {
  message: { chat_id: "c1", message_id: "om_1", message_type: "image", content: JSON.stringify({ image_key: "img_k1" }) },
  sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
}

const { bot, calls } = makeBot()
const msg = await deliver(bot, imageData)
const att = msg.attachments?.[0]
check("image downloaded with type=image", calls.length === 1 && calls[0].type === "image" && calls[0].file_key === "img_k1")
check("image attachment kind", att?.kind === "image")
check("image path has .png extension", !!att?.path.endsWith(".png"))
check("image written to disk", !!att && existsSync(att.path))
check("image content correct", !!att && readFileSync(att.path, "utf8") === "PNG")
check("image-only message has empty text", msg.text === "")
if (att) rmSync(att.path, { force: true })

const textMsg = await deliver(makeBot().bot, {
  message: { chat_id: "c1", message_id: "om_2", message_type: "text", content: JSON.stringify({ text: "hello" }) },
  sender: { sender_type: "user", sender_id: {} },
})
check("text message keeps text", textMsg.text === "hello")
check("text message has no attachments", textMsg.attachments === undefined)

const { bot: fileBot, calls: fileCalls } = makeBot()
const fileMsg = await deliver(fileBot, {
  message: {
    chat_id: "c1",
    message_id: "om_3",
    message_type: "file",
    content: JSON.stringify({ file_key: "file_k1", file_name: "report.pdf" }),
  },
  sender: { sender_type: "user", sender_id: {} },
})
const fileAtt = fileMsg.attachments?.[0]
check("file downloaded with type=file", fileCalls.length === 1 && fileCalls[0].type === "file")
check("file keeps original name", fileAtt?.kind === "file" && fileAtt?.name === "report.pdf")
check("file path has original extension", !!fileAtt?.path.endsWith(".pdf"))
if (fileAtt) rmSync(fileAtt.path, { force: true })

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
