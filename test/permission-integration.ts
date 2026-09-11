// Integration test: bridge auto-approves a whitelisted permission.asked.
// Requires: kilo serve on :4097 (kilo:kilo) and the bridge running with a
// config whose permissions.allow includes { permission:"bash", pattern:"chmod 777 *" }.
import { createKiloClient } from "@kilocode/sdk"
import { writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

const DIRECTORY = "/home/zhengyp/work/B/locus"
const MODEL = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
const auth = { Authorization: `Basic ${Buffer.from("kilo:kilo").toString("base64")}` }
const client = createKiloClient({ baseUrl: "http://127.0.0.1:4097", headers: auth })

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

const events: any[] = []
const sub = await client.event.subscribe({ query: { directory: DIRECTORY } })
;(async () => {
  for await (const ev of sub.stream) events.push(ev)
})()

writeFileSync("/tmp/kilo/perm-test", "x")
const session = await client.session.create({ body: { title: "perm-itest" }, query: { directory: DIRECTORY } })
const sid = session.data!.id
console.log("session:", sid)

try {
  const prompt = client.session
    .prompt({
      path: { id: sid },
      query: { directory: DIRECTORY },
      body: { model: MODEL, parts: [{ type: "text", text: "Use the bash tool to run exactly: chmod 777 /tmp/kilo/perm-test . Then reply with exactly: DONE" }] },
    })
    .catch((e) => ({ error: String(e).slice(0, 200) }))
  const r: any = await Promise.race([prompt, sleep(30000).then(() => ({ timeout: true }))])
  check("prompt completed without hanging", !r.timeout && !r.error, r.error ?? "")

  await sleep(500)
  const asked = events.find((e) => e.type === "permission.asked")
  check("permission.asked received", !!asked)
  const replied = events.find((e) => e.type === "permission.replied")
  check("permission.replied received", !!replied, replied ? JSON.stringify(replied.properties) : "none")
  check("auto reply was once", replied?.properties?.reply === "once")
} finally {
  await client.session.delete({ path: { id: sid }, query: { directory: DIRECTORY } }).catch(() => {})
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
