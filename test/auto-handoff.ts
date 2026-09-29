// Unit test: auto hand-off first-sentence rendering. No bridge/daemon required.
import { renderHandoffMessage, DEFAULT_AUTO_HANDOFF_MESSAGE } from "../src/handoff.ts"

let failures = 0
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " :: " + extra : ""}`)
  if (!cond) failures++
}

const vars = { oldSession: "ses_old", tokens: 120, directory: "/tmp/dir", title: "t" }

check("default used when template empty", renderHandoffMessage("", vars) === renderHandoffMessage(undefined, vars))
check("default has no leftover placeholders", !/\{\w+\}/.test(renderHandoffMessage(undefined, vars)))
check("default names the old session", renderHandoffMessage(undefined, vars).includes("ses_old"))
check("default states the token count", renderHandoffMessage(undefined, vars).includes("120K"))

const custom = "rotate {oldSession} at {tokens}K in {directory} ({title})"
check("custom template expands all keys", renderHandoffMessage(custom, vars) === "rotate ses_old at 120K in /tmp/dir (t)")
check("custom template keeps unknown keys", renderHandoffMessage("hi {nope}", vars) === "hi {nope}")
check("default constant is itself a valid template", renderHandoffMessage(DEFAULT_AUTO_HANDOFF_MESSAGE, vars).includes("ses_old"))

if (failures > 0) {
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log("\nall auto-handoff tests passed")
