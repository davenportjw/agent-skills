import type { FileOutlineSymbol } from '../types.js';
/**
 * Universal fallback structural chunker for Markdown, YAML, JSON, TOML, or any unindexed workspace file.
 * Kept dependency-free (no `typescript` import) so read-only CLI/DB queries stay fast on cold start.
 * Guarantees that `ast_outline` never returns 0 symbols for a non-empty file on disk.
 */
export declare function buildFallbackStructuralOutline(relPath: string, content: string): {
    language: string;
    lineCount: number;
    symbols: FileOutlineSymbol[];
};
//# sourceMappingURL=fallback-outline.d.ts.map