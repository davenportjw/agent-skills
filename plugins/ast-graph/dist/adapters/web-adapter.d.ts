import type { CompilerAdapter, CompilerGraphBatch, FileOutlineSymbol, GraphEdgeRecord, GraphNodeRecord } from '../types.js';
export declare class WebCompilerAdapter implements CompilerAdapter {
    readonly name = "web-composite";
    readonly languages: readonly ["html", "css"];
    supportsFile(filePath: string): boolean;
    discoverWebFiles(workspaceRoot: string): string[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
    /**
     * Demultiplexes a composite HTML / Jinja2 / Vue / Svelte / Astro document into:
     * 1. Structural DOM & template landmarks (<section>, <dialog>, <template>, <form>, {% block %}, id="...")
     * 2. Embedded <style> blocks -> delegated to indexStylesheetRegion with exact line offset preservation
     * 3. Embedded <script> blocks -> delegated to TypeScript AST parser (ts.createSourceFile) with newline padding
     *    so functions, classes, event handlers, fetch('/api/...') CALLS_ROUTE edges, and WebMCP tools have exact host line numbers.
     */
    private indexCompositeWebDocument;
    /**
     * Delegates an embedded <script> region to TypeScript's AST parser with leading newline padding
     * so all extracted functions, classes, event listeners, fetch() CALLS_ROUTE edges, and WebMCP
     * tools carry exact 1-based line numbers from the host composite document.
     */
    private indexEmbeddedScriptAst;
    /**
     * Hierarchical CSS / Stylesheet structural parser.
     * Extracts:
     * - Section banner comments (/* === Section === *\/) spanning until the next banner
     * - At-rule containers (@media, @layer, @keyframes, @container, @supports)
     * - :root / theme custom property groups (--* tokens)
     * - Grouped or multi-line top-level component rule blocks so a 2,400-line stylesheet
     *   produces clean, navigable outline spans.
     */
    indexStylesheetRegion(params: {
        content: string;
        baseLineOffset: number;
        relPath: string;
        pkgName: string;
        fileId: string;
        addNode: (n: GraphNodeRecord) => void;
        addEdge: (e: GraphEdgeRecord) => void;
    }): void;
}
/**
 * Universal fallback structural chunker for Markdown, YAML, JSON, TOML, or any unindexed workspace file.
 * Guarantees that `ast_outline` never returns 0 symbols for a non-empty file on disk.
 */
export declare function buildFallbackStructuralOutline(relPath: string, content: string): {
    language: string;
    lineCount: number;
    symbols: FileOutlineSymbol[];
};
//# sourceMappingURL=web-adapter.d.ts.map