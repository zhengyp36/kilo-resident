export interface PermissionRule {
  /** Permission kind to match, e.g. "bash". Omit or "*" matches any. */
  permission?: string
  /** Glob matched against each requested pattern/target. Omit or "*" matches any. */
  pattern?: string
}

export interface PermissionAsked {
  permission: string
  patterns: string[]
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

export function ruleMatches(rule: PermissionRule, asked: PermissionAsked): boolean {
  if (rule.permission && rule.permission !== "*" && rule.permission !== asked.permission) return false
  if (rule.pattern == null || rule.pattern === "*") return true
  const re = globToRegExp(rule.pattern)
  return asked.patterns.some((p) => re.test(p))
}

/** True when any allow rule matches the requested permission. Empty/undefined list denies. */
export function matchesAllow(rules: PermissionRule[] | undefined, asked: PermissionAsked): boolean {
  if (!rules || rules.length === 0) return false
  return rules.some((r) => ruleMatches(r, asked))
}
