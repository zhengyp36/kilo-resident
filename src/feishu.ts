import * as lark from "@larksuiteoapi/node-sdk"
import { createReadStream } from "node:fs"
import { basename } from "node:path"
import { log, warn } from "./log.ts"
import type { FeishuCreds } from "./config.ts"

export interface InboundMessage {
  chatId: string
  messageId: string
  text: string
  openId?: string
  userId?: string
  senderType?: string
}

export class FeishuBot {
  readonly client: lark.Client
  private readonly ws: lark.WSClient
  readonly name: string

  constructor(creds: FeishuCreds, private onMessage: (m: InboundMessage) => void) {
    this.name = creds.name
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

  private handle(data: unknown): void {
    const d = data as {
      message?: { chat_id: string; message_id: string; message_type: string; content: string }
      sender?: { sender_type?: string; sender_id?: { open_id?: string; user_id?: string } }
    }
    const msg = d?.message
    if (!msg) return
    const ids = d?.sender?.sender_id
    let text = ""
    try {
      text = (JSON.parse(msg.content ?? "{}") as { text?: string }).text ?? ""
    } catch {
      /* ignore */
    }
    this.onMessage({
      chatId: msg.chat_id,
      messageId: msg.message_id,
      text,
      openId: ids?.open_id,
      userId: ids?.user_id,
      senderType: d?.sender?.sender_type,
    })
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
