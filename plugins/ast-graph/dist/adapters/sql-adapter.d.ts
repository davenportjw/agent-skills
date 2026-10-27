import type { CompilerAdapter, CompilerGraphBatch } from '../types.js';
export declare class SqlCompilerAdapter implements CompilerAdapter {
    readonly name = "sql-ddl";
    readonly languages: readonly ["sql"];
    supportsFile(filePath: string): boolean;
    discoverSqlFiles(workspaceRoot: string): string[];
    extract(workspaceRoot: string, targetFiles?: string[]): CompilerGraphBatch;
}
//# sourceMappingURL=sql-adapter.d.ts.map