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
  /** Raw Feishu message type (text/post/image/file/audio/media/sticker/...). */
  messageType?: string
  attachments?: InboundAttachment[]
  /** Set when an image/file message could not be downloaded, so the bridge can tell the sender. */
  attachmentsError?: string
  /** Human label for a type we cannot turn into session input (e.g. "语音"), so the bridge replies instead of dropping silently. */
  unsupported?: string
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

/** Feishu message types we can recognise but cannot turn into session input. */
export const UNSUPPORTED_TYPES: Record<string, string> = {
  audio: "语音",
  media: "视频",
  sticker: "表情包",
  merge_forward: "合并转发的消息",
  interactive: "卡片消息",
  share_chat: "群名片",
  share_user: "个人名片",
  location: "位置",
  video_chat: "视频通话",
  calendar: "日历消息",
  share_calendar_event: "日历消息",
  general_calendar: "日历消息",
  todo: "任务消息",
  vote: "投票消息",
  folder: "文件夹",
  system: "系统消息",
}

interface PostTag {
  tag?: string
  text?: string
  href?: string
  user_id?: string
  user_name?: string
  image_key?: string
  emoji_type?: string
  language?: string
}

/** Render one rich-text (post) node to plain text. Inline images are collected separately. */
function renderPostTag(n: PostTag): string {
  switch (n.tag) {
    case "text":
    case "md":
      return n.text ?? ""
    case "a":
      return n.href ? `${n.text ?? ""} (${n.href})` : (n.text ?? "")
    case "at": {
      // Receive events put a serial like "@_user_1" in user_id and the name in `mentions`; when the
      // name is absent, avoid doubling the "@" from the serial.
      const who = (n.user_name ?? "").trim() || (n.user_id ?? "").replace(/^@/, "")
      return who ? `@${who}` : "@"
    }
    case "emotion":
      return n.emoji_type ? `[${n.emoji_type}]` : "[表情]"
    case "hr":
      return "---"
    case "code_block":
      return "```" + (n.language ?? "") + "\n" + (n.text ?? "") + "\n```"
    case "media":
      return "[视频]"
    default:
      return n.text ?? ""
  }
}

/** Find a `md` tag inside a post paragraph list (only `content_v2` carries it). */
function findPostMd(paragraphs: unknown): string | undefined {
  if (!Array.isArray(paragraphs)) return undefined
  for (const para of paragraphs) {
    if (!Array.isArray(para)) continue
    for (const node of para) {
      const n = node as PostTag
      if (n?.tag === "md" && typeof n.text === "string" && n.text.trim()) return n.text
    }
  }
  return undefined
}

/**
 * Parse a Feishu rich-text (`post`) content object into plain text plus inline image keys.
 * Receive events use `{title, content}`; sending wraps content per-locale, so unwrap that too.
 * `content_v2` (when present) preserves the original Markdown in an `md` tag and is preferred.
 */
export function parsePostContent(root: unknown): { text: string; imageKeys: string[] } {
  const imageKeys: string[] = []
  let obj = root as
    | { title?: unknown; content?: unknown; content_v2?: unknown; zh_cn?: unknown; en_us?: unknown }
    | undefined
  if (obj && !Array.isArray(obj.content)) {
    const loc = (obj.zh_cn ?? obj.en_us) as typeof obj | undefined
    if (loc) obj = loc
  }
  const title = typeof obj?.title === "string" ? obj.title.trim() : ""
  const paragraphs = Array.isArray(obj?.content) ? (obj!.content as unknown[]) : []

  // Inline images can appear both as structured `img` tags and as `![alt](img_key)` in Markdown.
  for (const para of paragraphs) {
    if (!Array.isArray(para)) continue
    for (const node of para) {
      const n = node as PostTag
      if (n?.tag === "img" && typeof n.image_key === "string") imageKeys.push(n.image_key)
    }
  }

  const md = findPostMd(obj?.content_v2 ?? paragraphs) ?? findPostMd(paragraphs)
  let body: string
  if (md) {
    for (const m of md.matchAll(/!\[[^\]]*\]\((img_[^)]+)\)/g)) imageKeys.push(m[1])
    body = md
  } else {
    const lines: string[] = []
    for (const para of paragraphs) {
      if (!Array.isArray(para)) continue
      lines.push(para.map((node) => renderPostTag(node as PostTag)).join(""))
    }
    body = lines.join("\n")
  }
  const text = [title, body].filter((s) => s && s.trim()).join("\n")
  return { text, imageKeys: [...new Set(imageKeys)] }
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
    try {
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
      const mt = msg.message_type
      let text = typeof content.text === "string" ? content.text : ""
      const attachments: InboundAttachment[] = []
      let error: string | undefined
      let unsupported: string | undefined

      if (mt === "post") {
        const parsed = parsePostContent(content)
        text = parsed.text
        for (const key of parsed.imageKeys) {
          const path = await this.downloadResource(msg.message_id, key, "image")
          if (path) attachments.push({ kind: "image", path })
          else error = "图片接收失败，请重发或改用文字描述"
        }
      } else if (mt === "image" && typeof content.image_key === "string") {
        const path = await this.downloadResource(msg.message_id, content.image_key, "image")
        if (path) attachments.push({ kind: "image", path })
        else error = "图片接收失败，请重发或改用文字描述"
      } else if (mt === "file" && typeof content.file_key === "string") {
        const name = typeof content.file_name === "string" ? content.file_name : undefined
        const path = await this.downloadResource(msg.message_id, content.file_key, "file", name)
        if (path) attachments.push({ kind: "file", path, name })
        else error = "文件接收失败，请重发"
      } else if (!text.trim() && mt !== "text" && mt !== "post") {
        // Only classify inherently non-text types as unsupported; an empty text/post message is
        // just ignored (e.g. a recalled/edited artifact), not answered with a type warning.
        unsupported = UNSUPPORTED_TYPES[mt] ?? `该消息类型（${mt}）`
      }

      this.onMessage({
        chatId: msg.chat_id,
        messageId: msg.message_id,
        text,
        openId: ids?.open_id,
        userId: ids?.user_id,
        senderType: d?.sender?.sender_type,
        messageType: mt,
        ...(attachments.length ? { attachments } : {}),
        ...(error ? { attachmentsError: error } : {}),
        ...(unsupported ? { unsupported } : {}),
      })
    } catch (err) {
      warn("feishu", `handle failed bot=${this.name}: ${String(err)}`)
    }
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
      // Deterministic name: a redelivered event overwrites the same file instead of piling up copies.
      const safe = (s: string) => s.replace(/[^\w.-]/g, "_")
      const filePath = join(INBOX_DIR, `${safe(messageId)}_${safe(fileKey)}${ext}`)
      await res.writeFile(filePath)
      log("feishu", `saved ${type} ${fileKey} -> ${filePath}`)
      return filePath
    } catch (err) {
      warn("feishu", `download ${type} failed bot=${this.name}: ${String(err)}`)
      return undefined
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      const r = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
      })
      if (r.code !== 0) warn("feishu", `sendText failed bot=${this.name} code=${r.code} msg=${r.msg}`)
    } catch (err) {
      // Callers fire-and-forget (`void sendText`); never let a transport error become an
      // unhandled rejection that takes the bridge (and its acks) down.
      warn("feishu", `sendText threw bot=${this.name}: ${String(err)}`)
    }
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    try {
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
    } catch (err) {
      warn("feishu", `sendFile threw bot=${this.name}: ${String(err)}`)
    }
  }
}
