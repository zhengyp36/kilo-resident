// Unit test: Feishu rich-text (post) parsing + unsupported-type classification, no daemon needed.
import { rmSync, writeFileSync } from "node:fs"
import { FeishuBot, parsePostContent, type InboundMessage } from "../src/feishu.ts"

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

// ---------- parsePostContent ----------

// The exact shape Feishu produces for an auto-numbered list (each line its own paragraph of tags).
const listPost = {
  title: "",
  content: [
    [{ tag: "text", text: "1. ", style: [] }, { tag: "text", text: "体温正常", style: [] }],
    [{ tag: "text", text: "2. ", style: [] }, { tag: "text", text: "吞咽痛", style: [] }],
  ],
}
const list = parsePostContent(listPost)
check("list text keeps numbered lines", list.text === "1. 体温正常\n2. 吞咽痛", JSON.stringify(list.text))
check("list has no images", list.imageKeys.length === 0)

// Mixed tags across paragraphs, including an inline image.
const mixed = parsePostContent({
  title: "标题",
  content: [
    [
      { tag: "text", text: "看这里：" },
      { tag: "a", text: "链接", href: "https://x.test" },
      { tag: "at", user_id: "@_user_1", user_name: "Tom" },
    ],
    [{ tag: "img", image_key: "img_a" }],
    [{ tag: "code_block", language: "GO", text: "func main() {}" }],
    [{ tag: "emotion", emoji_type: "SMILE" }],
    [{ tag: "hr" }],
  ],
})
check("link renders text+href", mixed.text.includes("链接 (https://x.test)"), mixed.text)
check("mention renders user_name", mixed.text.includes("@Tom"), mixed.text)
check("code block renders fenced", mixed.text.includes("```GO\nfunc main() {}\n```"), mixed.text)
check("emotion renders code", mixed.text.includes("[SMILE]"), mixed.text)
check("hr renders divider", mixed.text.includes("---"), mixed.text)
check("title is prepended", mixed.text.startsWith("标题\n"), mixed.text)
check("inline image key captured", mixed.imageKeys.includes("img_a"), JSON.stringify(mixed.imageKeys))

// A mention with no name (receive events carry a serial user_id) must not double the "@".
const bareAt = parsePostContent({ content: [[{ tag: "at", user_id: "@_user_9" }]] })
check("bare mention not double-@", bareAt.text === "@_user_9", JSON.stringify(bareAt.text))

// Sending-shape wrapper ({zh_cn}) is unwrapped.
const wrapped = parsePostContent({ zh_cn: { title: "", content: [[{ tag: "text", text: "你好" }]] } })
check("locale wrapper unwrapped", wrapped.text === "你好", JSON.stringify(wrapped.text))

// content_v2 md tag is preferred over the simplified content tags.
const withMd = parsePostContent({
  title: "",
  content: [[{ tag: "text", text: "1. 简化版" }]],
  content_v2: [[{ tag: "md", text: "1. **原始**\n2. markdown" }]],
})
check("content_v2 md preferred", withMd.text === "1. **原始**\n2. markdown", JSON.stringify(withMd.text))

// Markdown image syntax is captured as an image key.
const mdImg = parsePostContent({ content_v2: [[{ tag: "md", text: "看图 ![a](img_v3_xyz)" }]] })
check("md image key captured", mdImg.imageKeys.includes("img_v3_xyz"), JSON.stringify(mdImg.imageKeys))
check("md image key de-duplicated", mdImg.imageKeys.length === 1)

// ---------- FeishuBot.handle: post with inline image + unsupported types ----------

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
  return new Promise<InboundMessage>((resolve) => {
    ;(bot as any).onMessage = (m: InboundMessage) => resolve(m)
    void (bot as any).handle(data)
  })
}

const { bot, calls } = makeBot()
const postMsg = await deliver(bot, {
  message: {
    chat_id: "c1",
    message_id: "om_p1",
    message_type: "post",
    content: JSON.stringify({
      title: "",
      content: [
        [{ tag: "text", text: "照片在这" }],
        [{ tag: "img", image_key: "img_p1" }],
      ],
    }),
  },
  sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
})
check("post message type preserved", postMsg.messageType === "post")
check("post text parsed", postMsg.text.includes("照片在这"), postMsg.text)
check("post inline image downloaded as image", calls.length === 1 && calls[0].type === "image" && calls[0].file_key === "img_p1")
check("post inline image attached", postMsg.attachments?.[0]?.kind === "image")
check("post has no unsupported flag", postMsg.unsupported === undefined)
if (postMsg.attachments?.[0]) rmSync(postMsg.attachments[0].path, { force: true })

const unsupported: [string, string][] = [
  ["audio", "语音"],
  ["media", "视频"],
  ["sticker", "表情包"],
  ["merge_forward", "合并转发的消息"],
]
for (const [type, label] of unsupported) {
  const b = makeBot().bot
  const m = await deliver(b, {
    message: { chat_id: "c1", message_id: `om_${type}`, message_type: type, content: JSON.stringify({ file_key: "k" }) },
    sender: { sender_type: "user", sender_id: {} },
  })
  check(`${type} classified unsupported=${label}`, m.unsupported === label, String(m.unsupported))
  check(`${type} carries message type`, m.messageType === type)
}

const textMsg = await deliver(makeBot().bot, {
  message: { chat_id: "c1", message_id: "om_t", message_type: "text", content: JSON.stringify({ text: "hi" }) },
  sender: { sender_type: "user", sender_id: {} },
})
check("text not flagged unsupported", textMsg.unsupported === undefined)
check("text message type preserved", textMsg.messageType === "text")

// An empty text message is ignored downstream, not answered with a confusing type warning.
const emptyText = await deliver(makeBot().bot, {
  message: { chat_id: "c1", message_id: "om_e", message_type: "text", content: JSON.stringify({ text: "   " }) },
  sender: { sender_type: "user", sender_id: {} },
})
check("empty text not flagged unsupported", emptyText.unsupported === undefined, String(emptyText.unsupported))

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
