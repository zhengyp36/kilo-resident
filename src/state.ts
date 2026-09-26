import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import type { State } from "./types.ts"

export function loadState(path: string): State {
  if (!existsSync(path)) return { sessions: {}, timers: [], contextWatches: [] }
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<State>
    return { sessions: s.sessions ?? {}, timers: s.timers ?? [], contextWatches: s.contextWatches ?? [], controlToken: s.controlToken }
  } catch {
    return { sessions: {}, timers: [], contextWatches: [] }
  }
}

export function saveState(path: string, state: State): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, path)
}
