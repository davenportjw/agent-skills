import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
/**
 * Candidate type identifiers in a Go expression or statement. String/rune literals are stripped,
 * selector members of local values (`r.Config`) are ignored, while package-qualified names
 * (`router.Proxy`) yield the bare type name. Callers resolve names against declared types only,
 * so builtins and locals never produce edges.
 */
export declare function goTypeIdentifiers(text: string, receiverVar?: string): {
    name: string;
    composite: boolean;
    typeContext: boolean;
}[];
export declare class GoCompilerAdapter implements CompilerAdapter {
    readonly name = "go";
    readonly languages: readonly ["go", "templ"];
    supportsFile(filePath: string): boolean;
    discoverGoFiles(workspaceRoot: string): string[];
    private detectGoModuleName;
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
//# sourceMappingURL=go-adapter.d.ts.map