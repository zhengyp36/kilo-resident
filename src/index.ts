import { configPath, loadConfig, loadFeishuCreds, statePath } from "./config.ts"
import { loadState } from "./state.ts"
import { Bridge } from "./bridge.ts"
import { log, warn } from "./log.ts"

async function main(): Promise<void> {
  const cfg = loadConfig()
  const creds = loadFeishuCreds()
  const sp = statePath()
  const state = loadState(sp)
  log("main", `config=${configPath()} state=${sp}`)
  const bridge = new Bridge(cfg, state, sp, creds)
  await bridge.start()

  const shutdown = () => {
    log("main", "shutting down")
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  warn("main", String(err?.stack ?? err))
  process.exit(1)
})
