import type { CompilerAdapter, CompilerGraphBatch, EdgeKind, NodeKind } from '../types.js';
interface GraphNodeRecord {
    id: string;
    kind: NodeKind;
    name: string;
    qualifiedName: string;
    filePath: string;
    language: PolyglotLanguage;
    startLine: number;
    endLine: number;
    signature: string;
    returnType?: string;
    exported: boolean;
}
interface GraphEdgeRecord {
    sourceId: string;
    targetId: string;
    kind: EdgeKind;
    filePath: string;
    line: number;
    confidence: number;
    evidence?: string;
}
export type PolyglotLanguage = 'java' | 'kotlin' | 'csharp' | 'ruby' | 'elixir' | 'php' | 'cpp' | 'swift' | 'zig' | 'wasm';
interface BraceScanState {
    inBlockComment: boolean;
    inRawString: boolean;
    heredocEnd: string;
}
/**
 * Counts brace delta on a single line across C-family / JVM / PHP / Swift / Zig languages,
 * skipping line and block comments, PHP `#` comments (excluding `#[Attr]`), standard strings,
 * verbatim strings (`@"..."`), triple-quoted raw strings (`"""..."""`), and PHP heredocs (`<<<EOF`).
 */
export declare function countPolyglotBracesLine(line: string, state: BraceScanState, lang: PolyglotLanguage): {
    delta: number;
    state: BraceScanState;
};
export declare function detectPolyglotLanguage(filePath: string): PolyglotLanguage | null;
export declare class PolyglotCompilerAdapter implements CompilerAdapter {
    readonly name = "scip-polyglot";
    readonly languages: readonly ["java", "kotlin", "csharp", "ruby", "elixir", "php", "cpp", "swift", "zig", "wasm"];
    supportsFile(filePath: string): boolean;
    discoverPolyglotFiles(workspaceRoot: string): string[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
    parseFile(relPath: string, content: string, lang: PolyglotLanguage): {
        nodes: GraphNodeRecord[];
        edges: GraphEdgeRecord[];
    };
    private createFileNode;
    private parseJava;
    private parseKotlin;
    private parseCSharp;
    private parseRuby;
    private parseElixir;
    private parsePhp;
    private parseCpp;
    private parseSwift;
    private parseZig;
    private parseWasm;
}
export {};
//# sourceMappingURL=polyglot-adapter.d.ts.map