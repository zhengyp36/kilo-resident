import { createKiloClient } from "@kilocode/sdk"
import type { KiloClient, Message, Part } from "@kilocode/sdk"
import type { DaemonInfo } from "./config.ts"

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

export async function getMessages(client: KiloClient, sessionId: string, directory: string): Promise<SessionMessage[]> {
  const r = await client.session.messages({ path: { id: sessionId }, query: { directory } })
  return r.data ?? []
}

export async function promptAsync(
  client: KiloClient,
  sessionId: string,
  directory: string,
  model: Model,
  messageID: string,
  text: string,
): Promise<void> {
  await client.session.promptAsync({
    path: { id: sessionId },
    query: { directory },
    body: { model, messageID, parts: [{ type: "text", text }] },
  })
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
