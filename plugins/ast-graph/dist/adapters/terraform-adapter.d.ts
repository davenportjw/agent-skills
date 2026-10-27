import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
export declare class TerraformCompilerAdapter implements CompilerAdapter {
    readonly name = "terraform";
    readonly languages: readonly ["terraform"];
    supportsFile(filePath: string): boolean;
    discoverTfFiles(workspaceRoot: string): string[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
//# sourceMappingURL=terraform-adapter.d.ts.map