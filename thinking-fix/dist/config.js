export const DEFAULTS = {
    mode: "keep-signature",
    providers: [],
    logSavings: false,
    bakerOptimized: false,
};
export function resolveConfig(input) {
    if (!input || typeof input !== "object")
        return DEFAULTS;
    const c = input;
    const mode = c.mode === "full-strip" ? "full-strip" : "keep-signature";
    const providers = Array.isArray(c.providers)
        ? c.providers.filter((p) => typeof p === "string")
        : [];
    const logSavings = Boolean(c.logSavings);
    const bakerOptimized = Boolean(c.bakerOptimized);
    return { mode, providers, logSavings, bakerOptimized };
}
export function configFromOpencode(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const obj = raw;
    if (obj["opencode-reasoning-stripper"] && typeof obj["opencode-reasoning-stripper"] === "object") {
        return obj["opencode-reasoning-stripper"];
    }
    if (obj.plugin && typeof obj.plugin === "object") {
        const p = obj.plugin;
        if (p["opencode-reasoning-stripper"] && typeof p["opencode-reasoning-stripper"] === "object") {
            return p["opencode-reasoning-stripper"];
        }
    }
    return undefined;
}
