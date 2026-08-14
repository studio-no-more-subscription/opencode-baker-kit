export type StripMode = "full-strip" | "keep-signature";
export type PluginConfig = {
    mode?: StripMode;
    providers?: string[];
    logSavings?: boolean;
    bakerOptimized?: boolean;
};
export type ResolvedConfig = {
    mode: StripMode;
    providers: string[];
    logSavings: boolean;
    bakerOptimized: boolean;
};
export declare const DEFAULTS: ResolvedConfig;
export declare function resolveConfig(input: unknown): ResolvedConfig;
export declare function configFromOpencode(raw: unknown): unknown;
