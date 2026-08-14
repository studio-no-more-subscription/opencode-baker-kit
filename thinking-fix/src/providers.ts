export const SIGNATURE_AWARE_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "amazon-bedrock",
  "google-vertex-anthropic",
])

export const FULLY_STRIP_SAFE_PROVIDERS: ReadonlySet<string> = new Set([
  "deepseek",
  "minimax",
  "minimax-coding-plan",
  "minimax-cn",
  "minimax-cn-coding-plan",
  "openai",
  "azure",
  "xai",
  "groq",
  "cerebras",
])

function normalize(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "")
}

export function hasSignedReasoning(providerID: string, apiNpm?: string): boolean {
  if (SIGNATURE_AWARE_PROVIDERS.has(providerID)) return true
  return apiNpm === "@ai-sdk/anthropic"
}

export function isFullySafeProvider(providerID: string): boolean {
  if (FULLY_STRIP_SAFE_PROVIDERS.has(providerID)) return true
  const norm = normalize(providerID)
  for (const safe of FULLY_STRIP_SAFE_PROVIDERS) {
    if (normalize(safe) === norm) return true
  }
  return /^minimax(-coding-plan)?$/.test(norm)
}

export function isWhitelisted(providerID: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true
  return whitelist.includes(providerID)
}

export function isOpenAICompatible(apiNpm?: string): boolean {
  return apiNpm === "@ai-sdk/openai-compatible"
}
