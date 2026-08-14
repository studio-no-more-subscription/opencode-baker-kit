import type { ResolvedConfig } from "./config"
import { isFullySafeProvider, isWhitelisted } from "./providers"

type WithParts = {
  info: { role?: string; providerID?: string; modelID?: string } & Record<string, unknown>
  parts: PartLike[]
}

type PartLike = {
  type?: string
  text?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

function reasoningTextSize(parts: PartLike[]): number {
  let total = 0
  for (const p of parts) {
    if (p.type === "reasoning") total += p.text?.length ?? 0
  }
  return total
}

export type EmbeddedThinkSplit = {
  text: string
  thinking: string
  stripped: boolean
}

const THINK_TAG_RE = /<think>([\s\S]*?)<\/think>/g

export function splitEmbeddedThink(text: string): EmbeddedThinkSplit {
  if (!text || text.indexOf("<think>") === -1) {
    return { text, thinking: "", stripped: false }
  }
  let thinking = ""
  const stripped = text.replace(THINK_TAG_RE, (_match, inner: string) => {
    thinking += inner
    return ""
  })
  return {
    text: stripped.replace(/^\s+/, "").replace(/\s+$/, ""),
    thinking: thinking.trim(),
    stripped: thinking.length > 0,
  }
}

export function stripEmbeddedThink(text: string): string {
  return splitEmbeddedThink(text).text
}

function lastAssistantIndex(msgs: WithParts[]): number {
  let idx = -1
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.info?.role === "assistant") idx = i
  }
  return idx
}

export type StripResult = {
  messages: WithParts[]
  savedChars: number
  keptReasoningChars: number
}

export function stripReasoning(
  messages: WithParts[],
  cfg: ResolvedConfig,
): StripResult {
  const lastIdx = lastAssistantIndex(messages)
  let saved = 0
  let kept = 0
  const out: WithParts[] = []

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.info?.role !== "assistant") {
      out.push(m)
      continue
    }
    if (i === lastIdx) {
      let keepTotal = 0
      for (const p of m.parts) if (p.type === "reasoning") keepTotal += p.text?.length ?? 0
      out.push(m)
      kept += keepTotal
      continue
    }

    const providerID = (m.info as any).providerID as string | undefined
    const apiNpm = (m.info as any).apiNpm as string | undefined

    const scopeOk = providerID ? isWhitelisted(providerID, cfg.providers) : true
    if (!scopeOk) {
      out.push(m)
      continue
    }

    const fullySafe = providerID ? isFullySafeProvider(providerID) : false
    const effectiveMode: "full-strip" | "keep-signature" =
      cfg.mode === "full-strip" || fullySafe ? "full-strip" : cfg.mode

    saved += reasoningTextSize(m.parts)
    const filtered = m.parts.filter((p) => {
      if (p.type !== "reasoning") return true
      if (effectiveMode === "full-strip") return false
      if (!p.metadata || Object.keys(p.metadata).length === 0) return false
      return true
    })
    out.push({ ...m, parts: filtered })
  }

  return { messages: out, savedChars: saved, keptReasoningChars: kept }
}

export type BakerProfile = {
  maxAssistantKeep: number
  stripToolOutputIfOversize: number
  collapseIdenticalToolResults: boolean
}

export const DEFAULT_BAKER_PROFILE: BakerProfile = {
  maxAssistantKeep: 1,
  stripToolOutputIfOversize: 8192,
  collapseIdenticalToolResults: true,
}

export function bakerOptimizedStrip(
  messages: WithParts[],
  cfg: ResolvedConfig,
  profile: BakerProfile = DEFAULT_BAKER_PROFILE,
): StripResult {
  const base = stripReasoning(messages, cfg)
  if (!cfg.bakerOptimized) return base

  const assistantIdxs: number[] = []
  for (let i = 0; i < base.messages.length; i++) {
    if (base.messages[i]?.info?.role === "assistant") assistantIdxs.push(i)
  }

  if (assistantIdxs.length <= profile.maxAssistantKeep) {
    return { ...base, messages: applyBakerToolTweaks(base.messages, profile) }
  }

  const keepSet = new Set(assistantIdxs.slice(-profile.maxAssistantKeep))
  const collapsed: WithParts[] = []
  for (let i = 0; i < base.messages.length; i++) {
    const m = base.messages[i]
    if (m.info?.role === "assistant" && !keepSet.has(i)) {
      collapsed.push({
        ...m,
        parts: m.parts.filter((p) => p.type !== "reasoning"),
      })
      continue
    }
    collapsed.push(m)
  }

  return {
    messages: applyBakerToolTweaks(collapsed, profile),
    savedChars: base.savedChars,
    keptReasoningChars: base.keptReasoningChars,
  }
}

function applyBakerToolTweaks(messages: WithParts[], profile: BakerProfile): WithParts[] {
  if (!profile.collapseIdenticalToolResults && profile.stripToolOutputIfOversize <= 0) {
    return messages
  }

  // seenResults intentionally spans the whole transform call (whole-session
  // dedupe): an identical tool output anywhere in the prompt collapses to a
  // "[dup of turn N]" stub, maximizing prompt-cache hits across the session.
  const seenResults = new Map<string, number>()
  return messages.map((m) => {
    if (!m.parts?.length) return m
    let mutated = false
    const newParts = m.parts.map((p) => {
      if (p.type !== "tool" && p.type !== "toolResult") return p
      const anyP = p as any
      const output = anyP.output ?? anyP.result ?? anyP.content
      if (typeof output !== "string") return p
      let nextOutput = output
      if (profile.stripToolOutputIfOversize > 0 && output.length > profile.stripToolOutputIfOversize) {
        const head = output.slice(0, 1024)
        const tail = output.slice(-512)
        nextOutput = `${head}\n…[${output.length - 1536} chars elided]…\n${tail}`
        mutated = true
      }
      if (profile.collapseIdenticalToolResults) {
        const dup = seenResults.get(nextOutput)
        if (dup !== undefined) {
          mutated = true
          return { ...anyP, output: `[dup of turn ${dup}] ${nextOutput.length} chars`, _collapsedFromDup: true }
        }
        seenResults.set(nextOutput, anyP.id ?? m.info?.id ?? "0")
      }
      if (nextOutput !== output) {
        mutated = true
        return { ...anyP, output: nextOutput }
      }
      return p
    })
    return mutated ? { ...m, parts: newParts } : m
  })
}
