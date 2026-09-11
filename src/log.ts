export function log(scope: string, ...args: unknown[]): void {
  const t = new Date().toISOString()
  console.log(`[${t}] [${scope}]`, ...args)
}

export function warn(scope: string, ...args: unknown[]): void {
  const t = new Date().toISOString()
  console.error(`[${t}] [${scope}]`, ...args)
}
