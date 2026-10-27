import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
export declare class GoCompilerAdapter implements CompilerAdapter {
    readonly name = "go";
    readonly languages: readonly ["go", "templ"];
    supportsFile(filePath: string): boolean;
    discoverGoFiles(workspaceRoot: string): string[];
    private detectGoModuleName;
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
//# sourceMappingURL=go-adapter.d.ts.map