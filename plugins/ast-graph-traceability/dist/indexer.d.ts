import { PythonCompilerAdapter } from './adapters/python-adapter.js';
import { TerraformCompilerAdapter } from './adapters/terraform-adapter.js';
import { TypeScriptCompilerAdapter } from './adapters/ts-adapter.js';
import type { AstGraphDatabase } from './db.js';
export interface SyncResult {
    mode: 'full' | 'incremental' | 'noop';
    durationMs: number;
    filesScanned: number;
    filesUpdated: number;
    filesDeleted: number;
    totals: {
        files: number;
        nodes: number;
        edges: number;
        diagnostics: number;
        packages: number;
    };
}
export declare class AstGraphIndexer {
    readonly workspaceRoot: string;
    readonly db: AstGraphDatabase;
    readonly tsAdapter: TypeScriptCompilerAdapter;
    readonly tfAdapter: TerraformCompilerAdapter;
    readonly pyAdapter: PythonCompilerAdapter;
    constructor(workspaceRoot: string, db: AstGraphDatabase);
    normalizeRelPath(filePath: string): string;
    discoverAllCandidateFiles(): string[];
    /**
     * Fast (<3ms) check comparing filesystem mtimeMs and SHA-256 against tracked files in SQLite.
     * Automatically incrementally re-indexes any modified/added/deleted files.
     */
    lazySyncIfDirty(options?: {
        targetFileHint?: string;
    }): SyncResult;
    private acquireSyncLock;
    syncWorkspace(options?: {
        full?: boolean;
        targetPaths?: string[];
        force?: boolean;
        exportSnapshots?: boolean;
    }): SyncResult;
    /**
     * Sub-30ms incremental single-file TypeScript AST parser & graph linker.
     * Uses ts.createSourceFile + the existing SQLite symbol table to resolve cross-file
     * calls, references, Zod schemas, Fastify routes, and Vitest test lineage without
     * re-parsing all of node_modules/@types.
     */
    private extractFastIncrementalTsBatch;
}
//# sourceMappingURL=indexer.d.ts.map