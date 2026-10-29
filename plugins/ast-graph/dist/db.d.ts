import { DatabaseSync } from 'node:sqlite';
import type { BlastRadiusResult, CompilerGraphBatch, FileOutlineResult, LineageResult, ShortestPathResult, SymbolNeighborhood, SymbolReferencesResult, SymbolSummary, TestsForChangeResult } from './types.js';
export declare class AstGraphDatabase {
    readonly dbPath: string;
    readonly db: DatabaseSync;
    constructor(dbPath: string, expectedWorkspaceRoot?: string);
    getMeta(key: string): string | null;
    setMeta(key: string, value: string): void;
    verifyRepoBinding(workspaceRoot: string): void;
    private initializeSchema;
    close(): void;
    getTrackedFilesMap(): Map<string, {
        sha256: string;
        mtimeMs: number;
    }>;
    removeDeletedFiles(existingFilePaths: Set<string>): number;
    applyBatch(batch: CompilerGraphBatch, clearExistingForFiles?: boolean): void;
    recordSyncRun(params: {
        durationMs: number;
        mode: string;
        filesScanned: number;
        filesUpdated: number;
    }): void;
    recordQueryTelemetry(queryType: string, target: string, latencyMs: number, resultCount: number): void;
    getCounts(): {
        files: number;
        nodes: number;
        edges: number;
        diagnostics: number;
        packages: number;
    };
    private mapNodeRow;
    private normalizeFilePathQuery;
    private getFileChildSymbols;
    private getFileSymbolIds;
    private expandFileMatches;
    resolveTargetSymbols(target: string, limit?: number, options?: {
        exactOnly?: boolean;
    }): SymbolSummary[];
    private normalizeKindFilter;
    /** Distinct node kinds with counts, used to explain zero-result `kind` filters. */
    listKindCounts(limit?: number): Array<{
        kind: string;
        count: number;
    }>;
    searchSymbols(query: string, rawKind?: string, limit?: number): SymbolSummary[];
    suggestClosestSymbols(query: string, limit?: number): SymbolSummary[];
    getFileOutline(filePathQuery: string, options?: {
        filter?: string;
        kind?: string;
        exportedOnly?: boolean;
        limit?: number;
    }): FileOutlineResult;
    private mapEdgeRows;
    getSymbolNeighborhood(symbolIdOrName: string, options?: {
        limit?: number;
    }): SymbolNeighborhood;
    /**
     * Look up all read, write, and call sites for a symbol, class property, interface field, or Zod schema field.
     * Separates mutations (WRITES_PROPERTY) from reads/calls (READS_PROPERTY, REFERENCES, CALLS).
     */
    getSymbolReferences(symbolIdOrName: string, options?: {
        limit?: number;
    }): SymbolReferencesResult;
    getBlastRadius(target: string, maxHops?: number): BlastRadiusResult;
    private formatTestCommand;
    getTestsForChange(target: string): TestsForChangeResult;
    getCrossLayerLineage(target: string): LineageResult;
    findShortestPath(fromTarget: string, toTarget: string, maxHops?: number): ShortestPathResult;
    exportGraph(outputDir: string): {
        cypherPath: string;
        jsonlPath: string;
        nodesExported: number;
        edgesExported: number;
    };
}
//# sourceMappingURL=db.d.ts.map