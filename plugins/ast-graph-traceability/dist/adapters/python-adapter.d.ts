import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
export declare function extractPythonSource(filePath: string, content: string, packageName?: string): CompilerGraphBatch;
export declare class PythonCompilerAdapter implements CompilerAdapter {
    readonly name = "python";
    readonly languages: readonly ["python"];
    supportsFile(filePath: string): boolean;
    discoverPythonFiles(workspaceRoot: string): string[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
//# sourceMappingURL=python-adapter.d.ts.map