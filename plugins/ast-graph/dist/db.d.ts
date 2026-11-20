import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
declare const DatabaseSync: typeof DatabaseSyncType;
type DatabaseSync = DatabaseSyncType;
import type { BlastRadiusResult, CompilerGraphBatch, FileOutlineResult, LineageResult, ShortestPathResult, SymbolNeighborhood, SymbolReferencesResult, SymbolSummary, TestsForChangeResult } from './types.js';
/**
 * Optional per-repo concept aliases, committed at `<repo>/ast-graph.config.json`:
 *   { "aliases": { "sanitizeDirective": ["sanitiseOutputText", "normaliseInput"] } }
 * Aliases only feed suggestions and fuzzy search; they never satisfy an exact symbol lookup.
 */
export declare const REPO_CONFIG_FILENAME = "ast-graph.config.json";
export declare function loadRepoQueryAliases(repoRoot: string): Record<string, string[]>;
export declare class AstGraphDatabase {
    readonly dbPath: string;
    readonly db: DatabaseSync;
    isClosed: boolean;
    constructor(dbPath: string, expectedWorkspaceRoot?: string);
    private queryAliasCache;
    /** Concept aliases from the bound repo's ast-graph.config.json (re-read when the file changes). */
    getQueryAliases(): Record<string, string[]>;
    getMeta(key: string): string | null;
    setMeta(key: string, value: string): void;
    deleteMeta(key: string): void;
    verifyRepoBinding(workspaceRoot: string): void;
    /** Empty every derived table (index rows, telemetry) while keeping the schema; forces a cold sync. */
    private resetDerivedData;
    /** Current on-disk schema version (stored in `PRAGMA user_version` and `meta.schema_version`). */
    static readonly SCHEMA_VERSION = 4;
    /** Derived index tables that are safe to drop and rebuild from source on a schema change. */
    private static readonly DERIVED_TABLES;
    /** Legacy derived tables/views dropped during schema upgrades (e.g. v3 `edges` table -> v4 `edges` view). */
    private static readonly LEGACY_DERIVED_OBJECTS;
    /** Set when the constructor discarded an outdated/foreign index; callers should run a full sync. */
    schemaRebuilt: {
        fromVersion: number;
        reason: string;
    } | null;
    /**
     * Bring an existing database file to SCHEMA_VERSION before CREATE TABLE IF NOT EXISTS runs.
     * The index is fully derived from source files, so the migration strategy for any older or
     * foreign layout (e.g. legacy forks with a `labels_json` column or v3 string-keyed `edges`)
     * is drop-and-resync rather than column-level ALTERs. A database written by a *newer* plugin
     * is refused with an actionable error.
     */
    private migrateSchema;
    /**
     * Fold the WAL back into the main database and truncate it. Called after every sync so the
     * `-wal` file does not grow unbounded (it reached >100MB on large monorepos). Best-effort: if a
     * reader in another process pins an old snapshot, SQLite checkpoints what it can and returns.
     */
    checkpointWal(): void;
    /**
     * Reclaims dead SQLite freelist pages, prunes orphaned intern entries, and compacts FTS5 segments
     * after heavy branch/file churn. Defaults to triggering when >= 4000 pages (~16MB) and >= 25%
     * of pages are free.
     */
    compactIfNeeded(options?: {
        force?: boolean;
        minFreePages?: number;
        minFreeRatio?: number;
    }): boolean;
    /** Remove unreferenced entries from symbol_ids and file_ids so intern tables stay bounded across churn. */
    private pruneOrphanedInternEntries;
    /**
     * Seeds an empty worktree database in-place from its parent repository's `ast.db` (~10ms via
     * deferred ATTACH SELECT, safe even while another process reads or writes the parent WAL),
     * skipping nested `.worktrees/` paths and leaving `last_git_head` unset so the next sync diffs
     * any files that diverged on the worktree branch.
     */
    seedFromParentDatabase(parentDbPath: string, targetWorkspaceRoot: string): boolean;
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
export {};
//# sourceMappingURL=db.d.ts.map