import type { ResolvedConfig } from "./config";
type WithParts = {
    info: {
        role?: string;
        providerID?: string;
        modelID?: string;
    } & Record<string, unknown>;
    parts: PartLike[];
};
type PartLike = {
    type?: string;
    text?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
};
export type EmbeddedThinkSplit = {
    text: string;
    thinking: string;
    stripped: boolean;
};
export declare function splitEmbeddedThink(text: string): EmbeddedThinkSplit;
export declare function stripEmbeddedThink(text: string): string;
export type StripResult = {
    messages: WithParts[];
    savedChars: number;
    keptReasoningChars: number;
};
export declare function stripReasoning(messages: WithParts[], cfg: ResolvedConfig): StripResult;
export type BakerProfile = {
    maxAssistantKeep: number;
    stripToolOutputIfOversize: number;
    collapseIdenticalToolResults: boolean;
};
export declare const DEFAULT_BAKER_PROFILE: BakerProfile;
export declare function bakerOptimizedStrip(messages: WithParts[], cfg: ResolvedConfig, profile?: BakerProfile): StripResult;
export {};
