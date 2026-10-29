import type { CompilerAdapter, CompilerGraphBatch, EdgeKind, NodeKind } from '../types.js';
interface RawRustNode {
    id: string;
    kind: NodeKind;
    name: string;
    qualifiedName: string;
    filePath: string;
    language: string;
    startLine: number;
    endLine: number;
    signature: string;
    returnType?: string;
    exported: boolean;
}
interface RawRustEdge {
    sourceId: string;
    targetId: string;
    kind: EdgeKind;
    filePath: string;
    line: number;
    confidence: number;
    evidence?: string;
}
/**
 * Counts brace delta on a single line of Rust code, safely skipping:
 * - `//` line comments and block comments
 * - Standard `"..."` strings and raw strings (`r"..."`, `r#"..."#`)
 * - Character literals (`'x'`, `'\n'`) WITHOUT getting confused by lifetime annotations (`'a`, `'static`)
 */
export declare function countRustBracesLine(line: string, inBlockComment: boolean, rawStringHashes: number): {
    delta: number;
    inBlockComment: boolean;
    rawStringHashes: number;
};
export declare class RustCompilerAdapter implements CompilerAdapter {
    readonly name = "scip-rust";
    readonly languages: readonly ["rust"];
    supportsFile(filePath: string): boolean;
    discoverRustFiles(workspaceRoot: string): string[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
    parseRustFile(relPath: string, content: string): {
        nodes: RawRustNode[];
        edges: RawRustEdge[];
    };
    private extractFnCalls;
}
export {};
//# sourceMappingURL=rust-adapter.d.ts.map