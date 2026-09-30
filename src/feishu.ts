import * as lark from "@larksuiteoapi/node-sdk"
import { createReadStream, mkdirSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { homedir } from "node:os"
import { log, warn } from "./log.ts"
import type { FeishuCreds } from "./config.ts"

export interface InboundAttachment {
  kind: "image" | "file"
  path: string
  name?: string
}

export interface InboundMessage {
  chatId: string
  messageId: string
  text: string
  openId?: string
  userId?: string
  senderType?: string
  attachments?: InboundAttachment[]
}

const INBOX_DIR = join(homedir(), ".local", "state", "kilo-resident", "inbox")

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
}

/** Best-effort extension from a resource response's content-type header. */
function extFromHeader(headers: unknown): string {
  const h = headers as Record<string, string> | undefined
  const ct = (h?.["content-type"] ?? h?.["Content-Type"] ?? "").split(";")[0].trim().toLowerCase()
  return MIME_EXT[ct] ?? ""
}

export class FeishuBot {
  readonly client: lark.Client
  private readonly ws: lark.WSClient
  readonly name: string
  private readonly onMessage: (m: InboundMessage) => void

  constructor(creds: FeishuCreds, onMessage: (m: InboundMessage) => void) {
    this.name = creds.name
    this.onMessage = onMessage
    this.client = new lark.Client({ appId: creds.app_id, appSecret: creds.app_secret })
    this.ws = new lark.WSClient({
      appId: creds.app_id,
      appSecret: creds.app_secret,
      loggerLevel: lark.LoggerLevel.warn,
    })
  }

  start(): void {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => this.handle(data),
    })
    this.ws.start({ eventDispatcher: dispatcher })
    log("feishu", `bot ${this.name} ws started`)
  }

  private async handle(data: unknown): Promise<void> {
    const d = data as {
      message?: { chat_id: string; message_id: string; message_type: string; content: string }
      sender?: { sender_type?: string; sender_id?: { open_id?: string; user_id?: string } }
    }
    const msg = d?.message
    if (!msg) return
    const ids = d?.sender?.sender_id
    let content: Record<string, unknown> = {}
    try {
      content = JSON.parse(msg.content ?? "{}") as Record<string, unknown>
    } catch {
      /* ignore */
    }
    const text = typeof content.text === "string" ? content.text : ""
    const attachments = await this.fetchAttachments(msg, content)
    this.onMessage({
      chatId: msg.chat_id,
      messageId: msg.message_id,
      text,
      openId: ids?.open_id,
      userId: ids?.user_id,
      senderType: d?.sender?.sender_type,
      ...(attachments.length ? { attachments } : {}),
    })
  }

  /** Download image/file resources carried by a message into the local inbox. */
  private async fetchAttachments(
    msg: { message_id: string; message_type: string },
    content: Record<string, unknown>,
  ): Promise<InboundAttachment[]> {
    const out: InboundAttachment[] = []
    if (msg.message_type === "image" && typeof content.image_key === "string") {
      const path = await this.downloadResource(msg.message_id, content.image_key, "image")
      if (path) out.push({ kind: "image", path })
    } else if (msg.message_type === "file" && typeof content.file_key === "string") {
      const name = typeof content.file_name === "string" ? content.file_name : undefined
      const path = await this.downloadResource(msg.message_id, content.file_key, "file", name)
      if (path) out.push({ kind: "file", path, name })
    }
    return out
  }

  private async downloadResource(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    name?: string,
  ): Promise<string | undefined> {
    try {
      const res = await this.client.im.messageResource.get({
        params: { type },
        path: { message_id: messageId, file_key: fileKey },
      })
      const ext = (name ? extname(name) : "") || extFromHeader(res.headers) || (type === "image" ? ".jpg" : ".bin")
      mkdirSync(INBOX_DIR, { recursive: true })
      const filePath = join(INBOX_DIR, `${Date.now().toString(36)}_${messageId.replace(/[^\w.-]/g, "_")}${ext}`)
      await res.writeFile(filePath)
      log("feishu", `saved ${type} ${fileKey} -> ${filePath}`)
      return filePath
    } catch (err) {
      warn("feishu", `download ${type} failed bot=${this.name}: ${String(err)}`)
      return undefined
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const r = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    })
    if (r.code !== 0) warn("feishu", `sendText failed bot=${this.name} code=${r.code} msg=${r.msg}`)
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    const up = await this.client.im.file.create({
      data: { file_type: "stream", file_name: basename(filePath), file: createReadStream(filePath) },
    })
    const fileKey = up?.file_key
    if (!fileKey) {
      warn("feishu", `file upload failed bot=${this.name}: ${JSON.stringify(up)}`)
      return
    }
    const r = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "file", content: JSON.stringify({ file_key: fileKey }) },
    })
    if (r.code !== 0) warn("feishu", `sendFile failed bot=${this.name} code=${r.code} msg=${r.msg}`)
  }
}
