import { parseModel, type Model, type ProviderCatalog } from "./kilo.ts"
import { warn } from "./log.ts"

/** Stable "providerID/modelID" key. */
export function modelKey(m: Model): string {
  return `${m.providerID}/${m.modelID}`
}

/**
 * Canonical /models list: whitelist in its configured order (deduped, invalid specs skipped),
 * then the current model appended at the end when it is not already whitelisted.
 */
export function buildModelList(whitelist: string[] | undefined, current?: Model): Model[] {
  const list: Model[] = []
  const seen = new Set<string>()
  for (const spec of whitelist ?? []) {
    const m = parseModel(spec)
    if (!m) {
      warn("models", `skipping invalid model spec "${spec}" (expected providerID/modelID)`)
      continue
    }
    const key = modelKey(m)
    if (seen.has(key)) continue
    seen.add(key)
    list.push(m)
  }
  if (current && !seen.has(modelKey(current))) list.push(current)
  return list
}

/** One-line prefix identifying the answering model, or "" when unknown. */
export function formatModelHeader(model?: Model): string {
  return model?.providerID && model.modelID ? `▸ ${modelKey(model)}\n` : ""
}

/** Render the /models listing; `current` and `pending` are marked, unavailable providers flagged. */
export function renderModelList(list: Model[], current?: Model, pending?: Model, catalog?: ProviderCatalog): string {
  const currentKey = current ? modelKey(current) : undefined
  const pendingKey = pending ? modelKey(pending) : undefined
  const lines = list.map((m, i) => {
    const key = modelKey(m)
    const name = catalog?.labels.get(key)
    const marks: string[] = []
    if (key === currentKey) marks.push("当前")
    if (key === pendingKey) marks.push("下一条消息生效")
    if (catalog?.available && !catalog.connected.has(m.providerID)) marks.push("不可用")
    const label = name && name !== m.modelID ? `  ${name}` : ""
    const mark = marks.length ? `  （${marks.join("，")}）` : ""
    return ` ${key === currentKey ? ">" : " "} ${i + 1}. ${key}${label}${mark}`
  })
  return `模型（/models <编号> 切换，切换对其后消息立即生效）:\n${lines.join("\n")}`
}
