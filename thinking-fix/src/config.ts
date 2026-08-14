export type StripMode = "full-strip" | "keep-signature"

export type PluginConfig = {
  mode?: StripMode
  providers?: string[]
  logSavings?: boolean
  bakerOptimized?: boolean
}

export type ResolvedConfig = {
  mode: StripMode
  providers: string[]
  logSavings: boolean
  bakerOptimized: boolean
}

export const DEFAULTS: ResolvedConfig = {
  mode: "keep-signature",
  providers: [],
  logSavings: false,
  bakerOptimized: false,
}

export function resolveConfig(input: unknown): ResolvedConfig {
  if (!input || typeof input !== "object") return DEFAULTS
  const c = input as Partial<PluginConfig>

  const mode: StripMode = c.mode === "full-strip" ? "full-strip" : "keep-signature"
  const providers = Array.isArray(c.providers)
    ? c.providers.filter((p): p is string => typeof p === "string")
    : []
  const logSavings = Boolean(c.logSavings)
  const bakerOptimized = Boolean(c.bakerOptimized)

  return { mode, providers, logSavings, bakerOptimized }
}

export function configFromOpencode(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>

  if (obj["opencode-reasoning-stripper"] && typeof obj["opencode-reasoning-stripper"] === "object") {
    return obj["opencode-reasoning-stripper"]
  }

  if (obj.plugin && typeof obj.plugin === "object") {
    const p = obj.plugin as Record<string, unknown>
    if (p["opencode-reasoning-stripper"] && typeof p["opencode-reasoning-stripper"] === "object") {
      return p["opencode-reasoning-stripper"]
    }
  }

  const provider = obj.provider
  if (provider && typeof provider === "object") {
    const entry = (provider as Record<string, unknown>)["opencode-reasoning-stripper"]
    if (entry && typeof entry === "object") {
      const opts = (entry as Record<string, unknown>).options
      if (opts && typeof opts === "object") return opts
      return entry
    }
  }

  return undefined
}
