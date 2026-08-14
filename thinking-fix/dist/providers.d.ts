export declare const SIGNATURE_AWARE_PROVIDERS: ReadonlySet<string>;
export declare const FULLY_STRIP_SAFE_PROVIDERS: ReadonlySet<string>;
export declare function hasSignedReasoning(providerID: string, apiNpm?: string): boolean;
export declare function isFullySafeProvider(providerID: string): boolean;
export declare function isWhitelisted(providerID: string, whitelist: string[]): boolean;
export declare function isOpenAICompatible(apiNpm?: string): boolean;
