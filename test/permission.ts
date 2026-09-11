import { matchesAllow, ruleMatches, type PermissionRule } from "../src/permission.ts"

let failures = 0
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`)
  if (!cond) failures++
}

const asked = (permission: string, patterns: string[]) => ({ permission, patterns })

check("empty rules deny", matchesAllow([], asked("bash", ["ls"])) === false)
check("undefined rules deny", matchesAllow(undefined, asked("bash", ["ls"])) === false)

const bashLs: PermissionRule = { permission: "bash", pattern: "ls*" }
check("exact glob match", ruleMatches(bashLs, asked("bash", ["ls -la"])) === true)
check("glob no match", ruleMatches(bashLs, asked("bash", ["rm -rf /"])) === false)
check("permission mismatch", ruleMatches(bashLs, asked("edit", ["ls"])) === false)

check("permission-only rule matches any pattern", ruleMatches({ permission: "bash" }, asked("bash", ["anything"])) === true)
check("pattern-only rule matches any permission", ruleMatches({ pattern: "git status*" }, asked("edit", ["git status"])) === true)
check("wildcard permission", ruleMatches({ permission: "*", pattern: "ls*" }, asked("write", ["ls"])) === true)
check("wildcard pattern", ruleMatches({ permission: "bash", pattern: "*" }, asked("bash", ["whatever"])) === true)
check("question mark glob", ruleMatches({ pattern: "git ?og" }, asked("bash", ["git log"])) === true)
check("regex chars are literal", ruleMatches({ pattern: "echo a.b" }, asked("bash", ["echo a.b"])) === true)
check("regex dot not wildcard", ruleMatches({ pattern: "echo a.b" }, asked("bash", ["echo axb"])) === false)

const rules: PermissionRule[] = [{ permission: "bash", pattern: "ls*" }, { permission: "bash", pattern: "git status*" }]
check("any-of rules hit", matchesAllow(rules, asked("bash", ["git status"])) === true)
check("any-of rules miss", matchesAllow(rules, asked("bash", ["git push"])) === false)

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
