import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
interface WorkspacePkgInfo {
    name: string;
    version: string;
    relDir: string;
    absDir: string;
    entryRelPath: string;
}
export declare class TypeScriptCompilerAdapter implements CompilerAdapter {
    readonly name = "typescript";
    readonly languages: readonly ["typescript", "javascript"];
    supportsFile(filePath: string): boolean;
    discoverWorkspacePackages(workspaceRoot: string): WorkspacePkgInfo[];
    discoverAllSourceFiles(workspaceRoot: string): string[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
export {};
//# sourceMappingURL=ts-adapter.d.ts.map