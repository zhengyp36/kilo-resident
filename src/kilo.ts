import { createKiloClient } from "@kilocode/sdk"
import type { KiloClient, Message, Part } from "@kilocode/sdk"
import type { DaemonInfo } from "./config.ts"
import { warn } from "./log.ts"

export type Model = { providerID: string; modelID: string }
export type SessionMessage = { info: Message; parts: Part[] }

export function makeKiloClient(d: DaemonInfo): KiloClient {
  const auth = d.username
    ? { Authorization: `Basic ${Buffer.from(`${d.username}:${d.password ?? ""}`).toString("base64")}` }
    : undefined
  return createKiloClient({ baseUrl: d.url, headers: auth })
}

export async function createSession(client: KiloClient, directory: string, title: string): Promise<string> {
  const r = await client.session.create({ body: { title }, query: { directory } })
  return r.data!.id
}

export async function listSessionIds(client: KiloClient, directory: string): Promise<string[]> {
  const r = await client.session.list({ query: { directory } })
  return (r.data ?? []).map((s) => s.id)
}

export type SessionInfo = { id: string; title: string; created: number; updated: number }

export async function listSessions(client: KiloClient, directory: string): Promise<SessionInfo[]> {
  const r = await client.session.list({ query: { directory } })
  return (r.data ?? []).map((s) => ({ id: s.id, title: s.title, created: s.time.created, updated: s.time.updated }))
}

/** List a session's messages. `limit` keeps only the newest N (server-side tail). */
export async function getMessages(client: KiloClient, sessionId: string, directory: string, limit?: number): Promise<SessionMessage[]> {
  const r = await client.session.messages({
    path: { id: sessionId },
    query: { directory, ...(limit != null ? { limit } : {}) },
  })
  return r.data ?? []
}

/** Map of sessionID -> status for a directory. Idle sessions are simply absent. */
export async function sessionStatus(client: KiloClient, directory: string): Promise<Record<string, { type?: string }>> {
  const r = await client.session.status({ query: { directory } })
  return (r.data ?? {}) as Record<string, { type?: string }>
}

export async function promptAsync(
  client: KiloClient,
  sessionId: string,
  directory: string,
  model: Model | undefined,
  messageID: string,
  text: string,
): Promise<void> {
  await client.session.promptAsync({
    path: { id: sessionId },
    query: { directory },
    body: { ...(model ? { model } : {}), messageID, parts: [{ type: "text", text }] },
  })
}

/** Parse "providerID/modelID" (split on the first slash; modelID may itself contain slashes). */
export function parseModel(spec: string): Model | undefined {
  const s = spec.trim()
  const i = s.indexOf("/")
  if (i <= 0 || i >= s.length - 1) return undefined
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

/**
 * The model a session is currently using, best-effort. Prefers the latest user message's selected
 * model (the user's choice) and falls back to the latest assistant message's model. Only the tail
 * is read. Returns undefined (server default) on any failure so a hand-off can still proceed.
 */
export async function sessionModel(client: KiloClient, sessionId: string, directory: string): Promise<Model | undefined> {
  try {
    const msgs = await getMessages(client, sessionId, directory, 50)
    let fromAssistant: Model | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i].info as { model?: Model; providerID?: string; modelID?: string }
      if (info.model?.providerID && info.model.modelID) return { providerID: info.model.providerID, modelID: info.model.modelID }
      if (!fromAssistant && info.providerID && info.modelID) fromAssistant = { providerID: info.providerID, modelID: info.modelID }
    }
    return fromAssistant
  } catch (err) {
    warn("kilo", `sessionModel read failed for ${sessionId}: ${String(err)}`)
    return undefined
  }
}

export async function summarize(
  client: KiloClient,
  sessionId: string,
  directory: string,
  model: Model,
): Promise<void> {
  await client.session.summarize({
    path: { id: sessionId },
    query: { directory },
    body: { providerID: model.providerID, modelID: model.modelID },
  })
}
