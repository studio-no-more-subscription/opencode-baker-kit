export const SIGNATURE_AWARE_PROVIDERS = new Set([
    "anthropic",
    "amazon-bedrock",
    "google-vertex-anthropic",
]);
export const FULLY_STRIP_SAFE_PROVIDERS = new Set([
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
]);
function normalize(id) {
    return id.toLowerCase().replace(/[^a-z0-9-]/g, "");
}
export function hasSignedReasoning(providerID, apiNpm) {
    if (SIGNATURE_AWARE_PROVIDERS.has(providerID))
        return true;
    return apiNpm === "@ai-sdk/anthropic";
}
export function isFullySafeProvider(providerID) {
    if (FULLY_STRIP_SAFE_PROVIDERS.has(providerID))
        return true;
    const norm = normalize(providerID);
    for (const safe of FULLY_STRIP_SAFE_PROVIDERS) {
        if (normalize(safe) === norm)
            return true;
    }
    return /^minimax(-coding-plan)?$/.test(norm);
}
export function isWhitelisted(providerID, whitelist) {
    if (whitelist.length === 0)
        return true;
    return whitelist.includes(providerID);
}
export function isOpenAICompatible(apiNpm) {
    return apiNpm === "@ai-sdk/openai-compatible";
}
