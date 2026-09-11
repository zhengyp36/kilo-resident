import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { log } from "./log.ts"

export interface TerminalHandlers {
  open(body: Record<string, unknown>): unknown
  exec(body: Record<string, unknown>): unknown
  observe(body: Record<string, unknown>): unknown
  cancel(body: Record<string, unknown>): unknown
  list(): unknown
  close(body: Record<string, unknown>): unknown
}

export interface ControlHandlers {
  list(): unknown
  set(body: Record<string, unknown>): unknown
  cancel(id: string): unknown
  terminal?: TerminalHandlers
}

export interface ControlServer {
  url: string
  close(): void
}

function send(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json" })
  res.end(JSON.stringify(data))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Loopback-only control API for the resident bridge (timers). */
export function startControl(port: number, token: string, h: ControlHandlers): ControlServer {
  const server = createServer((req, res) => {
    void handle(req, res, token, h)
  })
  server.listen(port, "127.0.0.1", () => log("control", `listening on http://127.0.0.1:${port}`))
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, token: string, h: ControlHandlers): Promise<void> {
  if (req.headers["x-token"] !== token) {
    send(res, 401, { error: "unauthorized" })
    return
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  try {
    if (req.method === "GET" && url.pathname === "/timers") {
      send(res, 200, { timers: h.list() })
      return
    }
    if (req.method === "POST" && url.pathname === "/timers") {
      const body = await readBody(req)
      send(res, 200, { timer: h.set(body) })
      return
    }
    if (req.method === "POST" && url.pathname === "/timers/cancel") {
      const body = await readBody(req)
      send(res, 200, { timer: h.cancel(String(body.id ?? "")) })
      return
    }
    if (h.terminal) {
      const t = h.terminal
      if (req.method === "GET" && url.pathname === "/terminal") {
        send(res, 200, { sessions: await t.list() })
        return
      }
      if (req.method === "POST" && url.pathname.startsWith("/terminal/")) {
        const body = await readBody(req)
        const op = url.pathname.slice("/terminal/".length)
        if (op === "open") return send(res, 200, { terminal: await t.open(body) })
        if (op === "exec") return send(res, 200, { terminal: await t.exec(body) })
        if (op === "observe") return send(res, 200, { terminal: await t.observe(body) })
        if (op === "cancel") return send(res, 200, { terminal: await t.cancel(body) })
        if (op === "close") return send(res, 200, { terminal: await t.close(body) })
        send(res, 404, { error: `unknown terminal op: ${op}` })
        return
      }
    }
    send(res, 404, { error: "not found" })
  } catch (err) {
    send(res, 400, { error: String(err) })
  }
}
