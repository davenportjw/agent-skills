/**
 * Lightweight, TypeScript-free candidate file matcher shared by the fast CLI freshness check.
 * Kept strictly aligned with the union of all 10 compiler adapters so the fast path never
 * misses a new/gitignored indexable file.
 */
export declare const FAST_SCAN_IGNORED_DIRS: Set<string>;
export declare function isIndexableCandidatePath(relOrAbsPath: string): boolean;
/**
 * Fast pure-Node filesystem scan (~2–4ms on typical repos) that checks whether every indexable
 * file on disk matches `tracked` (by presence and mtimeMs within 1ms) with no missing or extra
 * indexable files. Returns `false` (fail-safe) on any discrepancy or I/O error.
 */
export declare function isWorkspaceFilesystemClean(workspaceRoot: string, tracked: Map<string, {
    sha256: string;
    mtimeMs: number;
}>): boolean;
//# sourceMappingURL=candidate-files.d.ts.map