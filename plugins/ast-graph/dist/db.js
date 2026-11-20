import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning, ...args) => {
    const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (msg.includes('SQLite is an experimental feature'))
        return;
    return origEmitWarning(warning, ...args);
});
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { buildFallbackStructuralOutline } from './adapters/fallback-outline.js';
import { canonicalizeWorkspaceRoot, computeRepoId } from './assessor.js';
/**
 * Optional per-repo concept aliases, committed at `<repo>/ast-graph.config.json`:
 *   { "aliases": { "sanitizeDirective": ["sanitiseOutputText", "normaliseInput"] } }
 * Aliases only feed suggestions and fuzzy search; they never satisfy an exact symbol lookup.
 */
export const REPO_CONFIG_FILENAME = 'ast-graph.config.json';
export function loadRepoQueryAliases(repoRoot) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, REPO_CONFIG_FILENAME), 'utf8'));
        const out = {};
        for (const [key, value] of Object.entries(raw.aliases ?? {})) {
            if (Array.isArray(value)) {
                const names = value.filter((v) => typeof v === 'string' && v.trim().length > 0);
                if (names.length > 0)
                    out[key] = names;
            }
        }
        return out;
    }
    catch {
        return {};
    }
}
export class AstGraphDatabase {
    dbPath;
    db;
    isClosed = false;
    constructor(dbPath, expectedWorkspaceRoot) {
        this.dbPath = dbPath === ':memory:' ? ':memory:' : path.resolve(dbPath);
        if (this.dbPath !== ':memory:') {
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        }
        this.db = new DatabaseSync(this.dbPath, {
            open: true,
            enableForeignKeyConstraints: true,
            timeout: 5000,
        });
        this.initializeSchema();
        if (expectedWorkspaceRoot) {
            this.verifyRepoBinding(expectedWorkspaceRoot);
        }
    }
    queryAliasCache = null;
    /** Concept aliases from the bound repo's ast-graph.config.json (re-read when the file changes). */
    getQueryAliases() {
        const root = this.getMeta('canonical_root');
        if (!root)
            return {};
        let mtimeMs = -1;
        try {
            mtimeMs = fs.statSync(path.join(root, REPO_CONFIG_FILENAME)).mtimeMs;
        }
        catch {
            mtimeMs = -1;
        }
        if (!this.queryAliasCache || this.queryAliasCache.mtimeMs !== mtimeMs) {
            this.queryAliasCache = { mtimeMs, aliases: mtimeMs < 0 ? {} : loadRepoQueryAliases(root) };
        }
        return this.queryAliasCache.aliases;
    }
    getMeta(key) {
        const row = this.db
            .prepare('SELECT value FROM meta WHERE key = ?')
            .get(key);
        return row?.value ?? null;
    }
    setMeta(key, value) {
        this.db
            .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, value);
    }
    deleteMeta(key) {
        this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    }
    verifyRepoBinding(workspaceRoot) {
        const canonicalRoot = canonicalizeWorkspaceRoot(workspaceRoot);
        const expectedRepoId = computeRepoId(canonicalRoot);
        let isOwnIndexDir = this.dbPath === ':memory:';
        if (this.dbPath !== ':memory:') {
            const canonicalDbDir = canonicalizeWorkspaceRoot(path.dirname(this.dbPath));
            const rel = path.relative(canonicalRoot, canonicalDbDir);
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                throw new Error(`TAMPER_GUARD: Database path "${this.dbPath}" resides outside target repository "${canonicalRoot}". Cross-repository AST GraphDB access is forbidden.`);
            }
            isOwnIndexDir = canonicalDbDir === path.join(canonicalRoot, '.ast-graph');
        }
        const storedRepoId = this.getMeta('repo_id');
        const storedRoot = this.getMeta('canonical_root');
        const mismatch = (storedRepoId && storedRepoId !== expectedRepoId) || (storedRoot && storedRoot !== canonicalRoot);
        if (mismatch) {
            if (!isOwnIndexDir) {
                throw new Error(`TAMPER_GUARD: Database binding mismatch (stored repo_id="${storedRepoId}", root="${storedRoot}"; expected repo_id="${expectedRepoId}" for "${canonicalRoot}"). Refusing to open cross-project database.`);
            }
            // The database sits in this repo's own `.ast-graph/` but was stamped for another path: the
            // checkout or worktree was moved/renamed/copied. The index is derived data, so rebind and
            // clear it; the next query triggers a full re-sync instead of failing hard.
            this.resetDerivedData(`rebound from "${storedRoot ?? storedRepoId}" to "${canonicalRoot}"`);
            this.setMeta('repo_id', expectedRepoId);
            this.setMeta('canonical_root', canonicalRoot);
            return;
        }
        if (!storedRepoId || !storedRoot) {
            this.setMeta('repo_id', expectedRepoId);
            this.setMeta('canonical_root', canonicalRoot);
        }
    }
    /** Empty every derived table (index rows, telemetry) while keeping the schema; forces a cold sync. */
    resetDerivedData(reason) {
        this.db.exec('PRAGMA foreign_keys = OFF;');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const table of AstGraphDatabase.DERIVED_TABLES) {
                this.db.exec(`DELETE FROM "${table}";`);
            }
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
        finally {
            this.db.exec('PRAGMA foreign_keys = ON;');
        }
        this.schemaRebuilt = { fromVersion: AstGraphDatabase.SCHEMA_VERSION, reason };
    }
    /** Current on-disk schema version (stored in `PRAGMA user_version` and `meta.schema_version`). */
    static SCHEMA_VERSION = 4;
    /** Derived index tables that are safe to drop and rebuild from source on a schema change. */
    static DERIVED_TABLES = [
        'nodes_fts',
        'node_labels',
        'edge_rows',
        'symbol_ids',
        'file_ids',
        'edge_kinds',
        'diagnostics',
        'nodes',
        'files',
        'sync_runs',
        'query_telemetry',
    ];
    /** Legacy derived tables/views dropped during schema upgrades (e.g. v3 `edges` table -> v4 `edges` view). */
    static LEGACY_DERIVED_OBJECTS = ['edges'];
    /** Set when the constructor discarded an outdated/foreign index; callers should run a full sync. */
    schemaRebuilt = null;
    /**
     * Bring an existing database file to SCHEMA_VERSION before CREATE TABLE IF NOT EXISTS runs.
     * The index is fully derived from source files, so the migration strategy for any older or
     * foreign layout (e.g. legacy forks with a `labels_json` column or v3 string-keyed `edges`)
     * is drop-and-resync rather than column-level ALTERs. A database written by a *newer* plugin
     * is refused with an actionable error.
     */
    migrateSchema() {
        const userVersion = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
        if (userVersion === AstGraphDatabase.SCHEMA_VERSION)
            return;
        if (userVersion > AstGraphDatabase.SCHEMA_VERSION) {
            throw new Error(`SCHEMA_TOO_NEW: ${this.dbPath} was written by a newer ast-graph (schema v${userVersion}, this build supports v${AstGraphDatabase.SCHEMA_VERSION}). ` +
                'Upgrade the plugin, or delete the .ast-graph/ directory to rebuild with this version.');
        }
        const existingRows = this.db
            .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view')")
            .all();
        const existingTypes = new Map(existingRows.map((r) => [r.name, r.type]));
        const dropCandidates = [
            ...AstGraphDatabase.LEGACY_DERIVED_OBJECTS,
            ...AstGraphDatabase.DERIVED_TABLES,
        ];
        const stale = dropCandidates.filter((name) => existingTypes.has(name));
        if (stale.length === 0)
            return; // fresh database
        this.db.exec('PRAGMA foreign_keys = OFF;');
        for (const name of stale) {
            if (existingTypes.get(name) === 'view') {
                this.db.exec(`DROP VIEW IF EXISTS "${name}";`);
            }
            else {
                this.db.exec(`DROP TABLE IF EXISTS "${name}";`);
            }
        }
        if (existingTypes.get('meta') === 'table') {
            const metaCols = this.db.prepare('PRAGMA table_info(meta)').all().map((c) => c.name);
            if (!metaCols.includes('key') || !metaCols.includes('value')) {
                this.db.exec('DROP TABLE meta;');
            }
        }
        this.db.exec('PRAGMA foreign_keys = ON;');
        // Immediately reclaim freed pages on disk when upgrading from bloated legacy schemas (e.g. v3 -> v4).
        if (this.dbPath !== ':memory:') {
            try {
                this.db.exec('VACUUM;');
                this.checkpointWal();
            }
            catch {
                // Best-effort; compactIfNeeded will reclaim later if another reader holds a lock.
            }
        }
        this.schemaRebuilt = {
            fromVersion: userVersion,
            reason: `schema v${userVersion} -> v${AstGraphDatabase.SCHEMA_VERSION}: dropped ${stale.length} derived objects; full re-sync required`,
        };
    }
    /**
     * Fold the WAL back into the main database and truncate it. Called after every sync so the
     * `-wal` file does not grow unbounded (it reached >100MB on large monorepos). Best-effort: if a
     * reader in another process pins an old snapshot, SQLite checkpoints what it can and returns.
     */
    checkpointWal() {
        try {
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        }
        catch {
            // Busy readers are fine; the next sync retries.
        }
    }
    /**
     * Reclaims dead SQLite freelist pages, prunes orphaned intern entries, and compacts FTS5 segments
     * after heavy branch/file churn. Defaults to triggering when >= 4000 pages (~16MB) and >= 25%
     * of pages are free.
     */
    compactIfNeeded(options) {
        if (this.dbPath === ':memory:')
            return false;
        const minFreePages = options?.minFreePages ?? 4000;
        const minFreeRatio = options?.minFreeRatio ?? 0.25;
        try {
            const freeRow = this.db.prepare('PRAGMA freelist_count').get();
            const pageRow = this.db.prepare('PRAGMA page_count').get();
            const freePages = freeRow?.freelist_count ?? 0;
            const totalPages = pageRow?.page_count ?? 0;
            const shouldCompact = options?.force === true ||
                (totalPages > 0 && freePages >= minFreePages && freePages / totalPages >= minFreeRatio);
            if (!shouldCompact)
                return false;
            this.pruneOrphanedInternEntries();
            this.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('optimize');");
            this.db.exec('VACUUM;');
            this.checkpointWal();
            return true;
        }
        catch {
            return false;
        }
    }
    /** Remove unreferenced entries from symbol_ids and file_ids so intern tables stay bounded across churn. */
    pruneOrphanedInternEntries() {
        this.db.exec(`
      DELETE FROM symbol_ids
      WHERE sid NOT IN (SELECT src_sid FROM edge_rows UNION SELECT dst_sid FROM edge_rows)
        AND id NOT IN (SELECT id FROM nodes);
      DELETE FROM file_ids
      WHERE fid NOT IN (SELECT fid FROM edge_rows)
        AND file_path NOT IN (SELECT file_path FROM files);
    `);
    }
    /**
     * Seeds an empty worktree database in-place from its parent repository's `ast.db` (~10ms via
     * deferred ATTACH SELECT, safe even while another process reads or writes the parent WAL),
     * skipping nested `.worktrees/` paths and leaving `last_git_head` unset so the next sync diffs
     * any files that diverged on the worktree branch.
     */
    seedFromParentDatabase(parentDbPath, targetWorkspaceRoot) {
        if (this.dbPath === ':memory:')
            return false;
        const resolvedParent = path.resolve(parentDbPath);
        if (resolvedParent === this.dbPath || !fs.existsSync(resolvedParent))
            return false;
        if (this.getCounts().files > 0)
            return false;
        const canonicalTarget = canonicalizeWorkspaceRoot(targetWorkspaceRoot);
        let attached = false;
        try {
            this.db.prepare('ATTACH DATABASE ? AS seed_parent').run(resolvedParent);
            attached = true;
            const uvRow = this.db.prepare('PRAGMA seed_parent.user_version').get();
            if (uvRow?.user_version !== AstGraphDatabase.SCHEMA_VERSION) {
                return false;
            }
            const parentCount = this.db.prepare('SELECT COUNT(*) as c FROM seed_parent.files').get()?.c ?? 0;
            if (parentCount === 0) {
                return false;
            }
            // Use a deferred BEGIN (not BEGIN IMMEDIATE) so SQLite only acquires a read snapshot on
            // seed_parent while taking a write lock exclusively on `main`.
            this.db.exec('BEGIN');
            try {
                // Clear any leftover intern rows (e.g. after removeDeletedFiles emptied `files` without
                // compacting) so parent integer IDs (fid/kid/sid) map 1:1 with zero ID collisions.
                this.db.exec(`
          DELETE FROM edge_rows;
          DELETE FROM symbol_ids;
          DELETE FROM file_ids;
          DELETE FROM edge_kinds;
          INSERT OR IGNORE INTO files
            SELECT * FROM seed_parent.files
            WHERE file_path NOT LIKE '.worktrees/%' AND file_path NOT LIKE '%/.worktrees/%';
          INSERT OR IGNORE INTO nodes
            SELECT * FROM seed_parent.nodes
            WHERE file_path NOT LIKE '.worktrees/%' AND file_path NOT LIKE '%/.worktrees/%';
          INSERT OR IGNORE INTO node_labels
            SELECT nl.node_id, nl.label
            FROM seed_parent.node_labels nl
            INNER JOIN nodes n ON n.id = nl.node_id;
          INSERT OR IGNORE INTO file_ids (fid, file_path)
            SELECT fid, file_path FROM seed_parent.file_ids
            WHERE file_path NOT LIKE '.worktrees/%' AND file_path NOT LIKE '%/.worktrees/%';
          INSERT OR IGNORE INTO edge_kinds (kid, kind)
            SELECT kid, kind FROM seed_parent.edge_kinds;
          INSERT OR IGNORE INTO symbol_ids (sid, id)
            SELECT sid, id FROM seed_parent.symbol_ids;
          INSERT OR IGNORE INTO edge_rows (src_sid, kid, dst_sid, fid, line, col, weight, properties_json)
            SELECT er.src_sid, er.kid, er.dst_sid, er.fid, er.line, er.col, er.weight, er.properties_json
            FROM seed_parent.edge_rows er
            INNER JOIN file_ids f ON f.fid = er.fid;
          INSERT OR IGNORE INTO diagnostics (file_path, enclosing_symbol_id, compiler, severity, code, message, line, col)
            SELECT file_path, enclosing_symbol_id, compiler, severity, code, message, line, col
            FROM seed_parent.diagnostics
            WHERE file_path NOT LIKE '.worktrees/%' AND file_path NOT LIKE '%/.worktrees/%';
          INSERT INTO nodes_fts(id, name, qualified_name, signature, docstring, package_name, file_path)
            SELECT id, name, qualified_name, signature, docstring, package_name, file_path
            FROM nodes;
        `);
                this.setMeta('repo_id', computeRepoId(canonicalTarget));
                this.setMeta('canonical_root', canonicalTarget);
                this.deleteMeta('last_git_head');
                this.db.exec('COMMIT');
            }
            catch (innerErr) {
                try {
                    this.db.exec('ROLLBACK');
                }
                catch {
                    // ignore rollback error
                }
                throw innerErr;
            }
            return true;
        }
        catch {
            return false;
        }
        finally {
            if (attached) {
                try {
                    this.db.exec('DETACH DATABASE seed_parent');
                }
                catch {
                    // ignore detach error
                }
            }
            this.checkpointWal();
        }
    }
    initializeSchema() {
        this.migrateSchema();
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      PRAGMA journal_size_limit = 67108864;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS files (
        file_path TEXT PRIMARY KEY,
        package_name TEXT NOT NULL,
        language TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        package_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        start_col INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        end_col INTEGER NOT NULL,
        signature TEXT NOT NULL,
        docstring TEXT NOT NULL,
        exported INTEGER NOT NULL,
        complexity INTEGER NOT NULL,
        properties_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS node_labels (
        node_id TEXT NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY (node_id, label),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS symbol_ids (
        sid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS file_ids (
        fid INTEGER PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS edge_kinds (
        kid INTEGER PRIMARY KEY,
        kind TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS edge_rows (
        src_sid INTEGER NOT NULL,
        kid INTEGER NOT NULL,
        dst_sid INTEGER NOT NULL,
        fid INTEGER NOT NULL,
        line INTEGER NOT NULL,
        col INTEGER NOT NULL,
        weight REAL NOT NULL,
        properties_json TEXT NOT NULL,
        PRIMARY KEY (src_sid, kid, dst_sid, fid, line)
      ) WITHOUT ROWID, STRICT;

      CREATE VIEW IF NOT EXISTS edges AS
        SELECT
          s.id AS src_id,
          d.id AS dst_id,
          k.kind AS kind,
          f.file_path AS file_path,
          e.line AS line,
          e.col AS col,
          e.weight AS weight,
          CASE WHEN e.properties_json = '' THEN '{}' ELSE e.properties_json END AS properties_json
        FROM edge_rows e
        JOIN symbol_ids s ON s.sid = e.src_sid
        JOIN edge_kinds k ON k.kid = e.kid
        JOIN symbol_ids d ON d.sid = e.dst_sid
        JOIN file_ids f ON f.fid = e.fid;

      CREATE TABLE IF NOT EXISTS diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        enclosing_symbol_id TEXT,
        compiler TEXT NOT NULL,
        severity TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        line INTEGER NOT NULL,
        col INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        mode TEXT NOT NULL,
        files_scanned INTEGER NOT NULL,
        files_updated INTEGER NOT NULL,
        nodes_count INTEGER NOT NULL,
        edges_count INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS query_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        executed_at TEXT NOT NULL,
        query_type TEXT NOT NULL,
        target TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        result_count INTEGER NOT NULL
      ) STRICT;

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        id UNINDEXED,
        name,
        qualified_name,
        signature,
        docstring,
        package_name,
        file_path
      );

      CREATE INDEX IF NOT EXISTS idx_edge_rows_reverse ON edge_rows(dst_sid, kid, src_sid);
      CREATE INDEX IF NOT EXISTS idx_edge_rows_kind ON edge_rows(kid);
      CREATE INDEX IF NOT EXISTS idx_edge_rows_file ON edge_rows(fid);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind, name);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_qualified ON nodes(qualified_name);
    `);
        this.db.exec(`PRAGMA user_version = ${AstGraphDatabase.SCHEMA_VERSION};`);
        this.setMeta('schema_version', String(AstGraphDatabase.SCHEMA_VERSION));
    }
    close() {
        if (this.isClosed)
            return;
        this.isClosed = true;
        this.db.close();
    }
    getTrackedFilesMap() {
        const stmt = this.db.prepare('SELECT file_path, sha256, mtime_ms FROM files');
        const rows = stmt.all();
        const map = new Map();
        for (const r of rows) {
            map.set(r.file_path, { sha256: r.sha256, mtimeMs: r.mtime_ms });
        }
        return map;
    }
    removeDeletedFiles(existingFilePaths) {
        const tracked = this.getTrackedFilesMap();
        const toDelete = [];
        for (const filePath of tracked.keys()) {
            if (!existingFilePaths.has(filePath)) {
                toDelete.push(filePath);
            }
        }
        if (toDelete.length === 0)
            return 0;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const delFts = this.db.prepare('DELETE FROM nodes_fts WHERE file_path = ?');
            const delLabels = this.db.prepare('DELETE FROM node_labels WHERE node_id IN (SELECT id FROM nodes WHERE file_path = ?)');
            const delNodes = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
            const delEdges = this.db.prepare('DELETE FROM edge_rows WHERE fid IN (SELECT fid FROM file_ids WHERE file_path = ?)');
            const delDiags = this.db.prepare('DELETE FROM diagnostics WHERE file_path = ?');
            const delFile = this.db.prepare('DELETE FROM files WHERE file_path = ?');
            for (const fp of toDelete) {
                delFts.run(fp);
                delLabels.run(fp);
                delNodes.run(fp);
                delEdges.run(fp);
                delDiags.run(fp);
                delFile.run(fp);
            }
            // Also clean up any dangling edges whose src node was removed
            this.db.exec(`
        DELETE FROM edge_rows
        WHERE src_sid IN (
          SELECT s.sid FROM symbol_ids s
          WHERE s.id NOT LIKE 'scip-endpoint %'
            AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = s.id)
        )
      `);
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
        return toDelete.length;
    }
    applyBatch(batch, clearExistingForFiles = true) {
        const nowIso = new Date().toISOString();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (clearExistingForFiles && batch.files.length > 0) {
                const delFts = this.db.prepare('DELETE FROM nodes_fts WHERE file_path = ?');
                const delLabels = this.db.prepare('DELETE FROM node_labels WHERE node_id IN (SELECT id FROM nodes WHERE file_path = ?)');
                const delNodes = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
                const delEdges = this.db.prepare('DELETE FROM edge_rows WHERE fid IN (SELECT fid FROM file_ids WHERE file_path = ?)');
                const delDiags = this.db.prepare('DELETE FROM diagnostics WHERE file_path = ?');
                const delFile = this.db.prepare('DELETE FROM files WHERE file_path = ?');
                for (const f of batch.files) {
                    delFts.run(f.filePath);
                    delLabels.run(f.filePath);
                    delNodes.run(f.filePath);
                    delEdges.run(f.filePath);
                    delDiags.run(f.filePath);
                    delFile.run(f.filePath);
                }
            }
            const insFile = this.db.prepare(`
        INSERT OR REPLACE INTO files (
          file_path, package_name, language, sha256, mtime_ms, size_bytes, line_count, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
            for (const f of batch.files) {
                insFile.run(f.filePath, f.packageName, f.language, f.sha256, f.mtimeMs, f.sizeBytes, f.lineCount, nowIso);
            }
            const insNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, package_name, file_path, language,
          start_line, start_col, end_line, end_col, signature, docstring,
          exported, complexity, properties_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            const insLabel = this.db.prepare(`
        INSERT OR IGNORE INTO node_labels (node_id, label) VALUES (?, ?)
      `);
            const delFtsById = this.db.prepare('DELETE FROM nodes_fts WHERE id = ?');
            const insFts = this.db.prepare(`
        INSERT INTO nodes_fts (id, name, qualified_name, signature, docstring, package_name, file_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
            for (const n of batch.nodes) {
                insNode.run(n.id, n.kind, n.name, n.qualifiedName, n.packageName, n.filePath, n.language, n.startLine, n.startCol, n.endLine, n.endCol, n.signature, n.docstring, n.exported ? 1 : 0, n.complexity, JSON.stringify(n.properties ?? {}));
                insLabel.run(n.id, n.kind);
                for (const label of n.labels) {
                    insLabel.run(n.id, label);
                }
                delFtsById.run(n.id);
                insFts.run(n.id, n.name, n.qualifiedName, n.signature, n.docstring, n.packageName, n.filePath);
            }
            if (batch.edges.length > 0) {
                const symCache = new Map();
                const fileCache = new Map();
                const kindCache = new Map();
                for (const r of this.db.prepare('SELECT kid, kind FROM edge_kinds').all()) {
                    kindCache.set(r.kind, Number(r.kid));
                }
                for (const r of this.db.prepare('SELECT fid, file_path FROM file_ids').all()) {
                    fileCache.set(r.file_path, Number(r.fid));
                }
                const insSym = this.db.prepare('INSERT OR IGNORE INTO symbol_ids (id) VALUES (?)');
                const selSym = this.db.prepare('SELECT sid FROM symbol_ids WHERE id = ?');
                const insFileId = this.db.prepare('INSERT OR IGNORE INTO file_ids (file_path) VALUES (?)');
                const selFileId = this.db.prepare('SELECT fid FROM file_ids WHERE file_path = ?');
                const insKind = this.db.prepare('INSERT OR IGNORE INTO edge_kinds (kind) VALUES (?)');
                const selKind = this.db.prepare('SELECT kid FROM edge_kinds WHERE kind = ?');
                const internSym = (id) => {
                    const cached = symCache.get(id);
                    if (cached !== undefined)
                        return cached;
                    const existing = selSym.get(id);
                    if (existing?.sid !== undefined) {
                        const sid = Number(existing.sid);
                        symCache.set(id, sid);
                        return sid;
                    }
                    const res = insSym.run(id);
                    const sid = res.changes > 0
                        ? Number(res.lastInsertRowid)
                        : Number(selSym.get(id).sid);
                    symCache.set(id, sid);
                    return sid;
                };
                const internFile = (fp) => {
                    const cached = fileCache.get(fp);
                    if (cached !== undefined)
                        return cached;
                    const res = insFileId.run(fp);
                    const fid = res.changes > 0
                        ? Number(res.lastInsertRowid)
                        : Number(selFileId.get(fp).fid);
                    fileCache.set(fp, fid);
                    return fid;
                };
                const internKind = (kind) => {
                    const cached = kindCache.get(kind);
                    if (cached !== undefined)
                        return cached;
                    const res = insKind.run(kind);
                    const kid = res.changes > 0
                        ? Number(res.lastInsertRowid)
                        : Number(selKind.get(kind).kid);
                    kindCache.set(kind, kid);
                    return kid;
                };
                const insEdge = this.db.prepare(`
          INSERT OR REPLACE INTO edge_rows (
            src_sid, kid, dst_sid, fid, line, col, weight, properties_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
                for (const e of batch.edges) {
                    const propStr = e.properties && Object.keys(e.properties).length > 0 ? JSON.stringify(e.properties) : '';
                    insEdge.run(internSym(e.srcId), internKind(e.kind), internSym(e.dstId), internFile(e.filePath), e.line, e.col, e.weight, propStr);
                }
            }
            const insDiag = this.db.prepare(`
        INSERT INTO diagnostics (
          file_path, enclosing_symbol_id, compiler, severity, code, message, line, col
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
            for (const d of batch.diagnostics) {
                insDiag.run(d.filePath, d.enclosingSymbolId, d.compiler, d.severity, d.code, d.message, d.line, d.col);
            }
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }
    recordSyncRun(params) {
        const counts = this.getCounts();
        const stmt = this.db.prepare(`
      INSERT INTO sync_runs (
        started_at, duration_ms, mode, files_scanned, files_updated, nodes_count, edges_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(new Date().toISOString(), params.durationMs, params.mode, params.filesScanned, params.filesUpdated, counts.nodes, counts.edges);
        try {
            this.db.exec('DELETE FROM sync_runs WHERE id <= (SELECT MAX(id) - 200 FROM sync_runs)');
        }
        catch {
            // non-fatal
        }
    }
    recordQueryTelemetry(queryType, target, latencyMs, resultCount) {
        try {
            const stmt = this.db.prepare(`
        INSERT INTO query_telemetry (executed_at, query_type, target, latency_ms, result_count)
        VALUES (?, ?, ?, ?, ?)
      `);
            stmt.run(new Date().toISOString(), queryType, target, latencyMs, resultCount);
            this.db.exec('DELETE FROM query_telemetry WHERE id <= (SELECT MAX(id) - 500 FROM query_telemetry)');
        }
        catch {
            // Ignore telemetry write errors if read-only
        }
    }
    getCounts() {
        const files = this.db.prepare('SELECT COUNT(*) AS c FROM files').get().c;
        const nodes = this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c;
        const edges = this.db.prepare('SELECT COUNT(*) AS c FROM edge_rows').get().c;
        const diagnostics = this.db.prepare('SELECT COUNT(*) AS c FROM diagnostics').get().c;
        const packages = this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'WorkspacePackage'").get().c;
        return { files, nodes, edges, diagnostics, packages };
    }
    mapNodeRow(row) {
        const id = String(row.id);
        const labelRows = this.db
            .prepare('SELECT label FROM node_labels WHERE node_id = ?')
            .all(id);
        return {
            id,
            kind: String(row.kind),
            name: String(row.name),
            qualifiedName: String(row.qualified_name),
            packageName: String(row.package_name),
            filePath: String(row.file_path),
            language: String(row.language),
            startLine: Number(row.start_line),
            endLine: Number(row.end_line),
            signature: String(row.signature),
            docstring: String(row.docstring),
            exported: Number(row.exported) === 1,
            complexity: Number(row.complexity),
            labels: labelRows.map((l) => l.label),
        };
    }
    normalizeFilePathQuery(raw) {
        let cleaned = raw
            .trim()
            .replace(/^file:\/\//i, '')
            .replace(/#L?\d+(?:-L?\d+)?$/i, '')
            .replace(/\\/g, '/')
            .replace(/^\.\//, '');
        const canonicalRoot = this.getMeta('canonical_root');
        if (canonicalRoot && cleaned.startsWith(`${canonicalRoot}/`)) {
            cleaned = cleaned.slice(canonicalRoot.length + 1);
        }
        if (cleaned.startsWith('/')) {
            const matchRel = cleaned.match(/\/((?:packages|apps|tools|infra|src|backend|frontend|pkg|cmd|internal|terraform|sql|tests|test|skills|plugins|docs|scripts|static|templates)\/.+)$/);
            if (matchRel?.[1]) {
                cleaned = matchRel[1];
            }
        }
        return cleaned;
    }
    getFileChildSymbols(filePath, limit = 30) {
        const nonPropRows = this.db
            .prepare(`SELECT * FROM nodes
         WHERE file_path = ? AND kind NOT IN ('File', 'WorkspacePackage', 'Property')
         ORDER BY
           CASE WHEN kind IN ('RouteEndpoint', 'Class', 'Function', 'ZodSchema', 'Interface', 'Method', 'TerraformResource') THEN 0
                WHEN kind IN ('TypeAlias', 'Enum', 'Variable', 'TerraformVariable', 'TerraformOutput') THEN 1
                ELSE 2 END,
           exported DESC,
           complexity DESC,
           start_line ASC
         LIMIT ?`)
            .all(filePath, limit);
        if (nonPropRows.length > 0) {
            return nonPropRows.map((r) => this.mapNodeRow(r));
        }
        const allRows = this.db
            .prepare(`SELECT * FROM nodes
         WHERE file_path = ? AND kind NOT IN ('File', 'WorkspacePackage')
         ORDER BY exported DESC, complexity DESC, start_line ASC
         LIMIT ?`)
            .all(filePath, limit);
        return allRows.map((r) => this.mapNodeRow(r));
    }
    getFileSymbolIds(filePath, limit = 120) {
        const rows = this.db
            .prepare(`SELECT id FROM nodes
         WHERE file_path = ? AND kind NOT IN ('File', 'WorkspacePackage')
         ORDER BY
           CASE WHEN kind IN ('RouteEndpoint', 'Class', 'Function', 'ZodSchema', 'Interface', 'Method', 'TerraformResource') THEN 0
                WHEN kind IN ('TypeAlias', 'Enum', 'Variable', 'TerraformVariable', 'TerraformOutput') THEN 1
                ELSE 2 END,
           exported DESC,
           complexity DESC,
           start_line ASC
         LIMIT ?`)
            .all(filePath, limit);
        return rows.map((r) => r.id);
    }
    expandFileMatches(symbols, limit = 15) {
        const result = new Map();
        for (const sym of symbols) {
            result.set(sym.id, sym);
            if (sym.kind === 'File' && sym.filePath) {
                const children = this.getFileChildSymbols(sym.filePath, Math.max(limit, 25));
                for (const child of children) {
                    if (!result.has(child.id)) {
                        result.set(child.id, child);
                    }
                }
            }
        }
        return [...result.values()].slice(0, Math.max(limit, 25));
    }
    resolveTargetSymbols(target, limit = 15, options) {
        const trimmed = target.trim();
        if (!trimmed)
            return [];
        // 1. Exact ID match (ONLY when target starts with 'scip-')
        if (trimmed.startsWith('scip-')) {
            const byId = this.db.prepare('SELECT * FROM nodes WHERE id = ?').all(trimmed);
            if (byId.length > 0)
                return this.expandFileMatches(byId.map((r) => this.mapNodeRow(r)), limit);
        }
        // 2. Exact qualified_name, name, or RouteEndpoint path match (prioritizing non-File / non-TestCase definitions first)
        const byExact = this.db
            .prepare(`SELECT * FROM nodes
         WHERE qualified_name = ?
            OR name = ?
            OR (kind = 'RouteEndpoint' AND (name LIKE ? OR id LIKE ?))
         ORDER BY
           CASE WHEN kind IN ('RouteEndpoint', 'Function', 'Class', 'Method', 'ZodSchema', 'Interface', 'Property', 'Variable', 'TerraformResource') THEN 0 ELSE 1 END,
           CASE WHEN file_path LIKE '%.test.ts' THEN 1 ELSE 0 END,
           exported DESC,
           complexity DESC
         LIMIT ?`)
            .all(trimmed, trimmed, `% ${trimmed}`, `%:${trimmed}#`, limit);
        if (byExact.length > 0)
            return this.expandFileMatches(byExact.map((r) => this.mapNodeRow(r)), limit);
        // 3. File path match (exact or suffix)
        const normalizedPath = this.normalizeFilePathQuery(trimmed);
        if (normalizedPath.includes('/') ||
            /(?:^|\/)[Dd]ockerfile(?:\.[A-Za-z0-9_.-]+)?$|\.(ts|tsx|mjs|js|jsx|tf|hcl|tfvars|py|go|templ|sql|sqlx|html|proto|graphql|gql|rs|java|kt|kts|cs|rb|ex|exs|php|c|cc|cpp|cxx|h|hh|hpp|hxx|swift|zig|wat|wit)$/.test(normalizedPath)) {
            const byFile = this.db
                .prepare(`SELECT * FROM nodes
           WHERE file_path = ? OR file_path LIKE ?
           ORDER BY
             CASE WHEN kind = 'File' THEN 0
                  WHEN kind IN ('RouteEndpoint', 'Class', 'Function', 'ZodSchema', 'Interface', 'Method', 'TerraformResource') THEN 1
                  ELSE 2 END,
             exported DESC,
             start_line ASC
           LIMIT ?`)
                .all(normalizedPath, `%/${normalizedPath}`, Math.max(limit, 25));
            if (byFile.length > 0)
                return this.expandFileMatches(byFile.map((r) => this.mapNodeRow(r)), limit);
        }
        // 4. Repo-configured concept aliases (ast-graph.config.json). Never used for exact lookups, so an
        // alias hit surfaces as a labelled "No exact match" suggestion instead of masquerading as the target.
        const aliasTargets = options?.exactOnly ? undefined : this.getQueryAliases()[trimmed];
        if (aliasTargets && aliasTargets.length > 0) {
            const placeholders = aliasTargets.map(() => '?').join(', ');
            const aliasRows = this.db
                .prepare(`SELECT * FROM nodes
           WHERE name IN (${placeholders}) OR qualified_name IN (${placeholders})
           ORDER BY exported DESC, complexity DESC
           LIMIT ?`)
                .all(...aliasTargets, ...aliasTargets, limit);
            if (aliasRows.length > 0) {
                aliasRows.sort((a, b) => {
                    const idxA = aliasTargets.indexOf(String(a.name));
                    const idxB = aliasTargets.indexOf(String(b.name));
                    const rankA = idxA === -1 ? 999 : idxA;
                    const rankB = idxB === -1 ? 999 : idxB;
                    if (rankA !== rankB)
                        return rankA - rankB;
                    return Number(b.complexity) - Number(a.complexity);
                });
                return aliasRows.map((r) => this.mapNodeRow(r));
            }
        }
        // 5. Dotted Class.method or Package.symbol suffix match (matching qualified_name, never SCIP id prefix)
        if (trimmed.includes('.') &&
            !/\.(ts|tsx|mjs|js|jsx|tf|py|go|templ|sql|html)$/.test(trimmed)) {
            const parts = trimmed.split('.');
            const memberPart = parts[parts.length - 1] ?? trimmed;
            const containerPart = parts[0] ?? '';
            const dottedRows = this.db
                .prepare(`SELECT * FROM nodes
           WHERE qualified_name = ?
              OR qualified_name LIKE ?
              OR (name = ? AND qualified_name LIKE ?)
           ORDER BY
             CASE WHEN file_path LIKE '%.test.ts' THEN 1 ELSE 0 END,
             exported DESC,
             complexity DESC
           LIMIT ?`)
                .all(trimmed, `%.${trimmed}`, memberPart, `%${containerPart}%.${memberPart}`, limit);
            if (dottedRows.length > 0)
                return dottedRows.map((r) => this.mapNodeRow(r));
        }
        if (options?.exactOnly) {
            return [];
        }
        // 6. Fallback to searchSymbols (FTS5 + name/qualified_name LIKE)
        return this.searchSymbols(trimmed, undefined, limit);
    }
    normalizeKindFilter(raw) {
        if (!raw)
            return undefined;
        const cleaned = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
        if (!cleaned)
            return undefined;
        const aliases = {
            route: 'RouteEndpoint',
            routeendpoint: 'RouteEndpoint',
            endpoint: 'RouteEndpoint',
            sqltable: 'SqlTable',
            table: 'SqlTable',
            sqlcolumn: 'SqlColumn',
            column: 'SqlColumn',
            templ: 'TemplComponent',
            templcomponent: 'TemplComponent',
            terraform: 'TerraformResource',
            terraformresource: 'TerraformResource',
            tf: 'TerraformResource',
            schema: 'ZodSchema',
            zodschema: 'ZodSchema',
            pydantic: 'PydanticModel',
            pydanticmodel: 'PydanticModel',
            testsuite: 'TestSuite',
            testcase: 'TestCase',
            test: 'TestCase',
            workspacepackage: 'WorkspacePackage',
            package: 'WorkspacePackage',
            typealias: 'TypeAlias',
            type: 'TypeAlias',
            func: 'Function',
            function: 'Function',
            class: 'Class',
            struct: 'GoStruct',
            gostruct: 'GoStruct',
            interface: 'Interface',
            method: 'Method',
            property: 'Property',
            field: 'Property',
            variable: 'Variable',
            const: 'Variable',
            enum: 'Enum',
            file: 'File',
            stylesheetsection: 'StylesheetSection',
            css: 'StylesheetSection',
            stylesheet: 'StylesheetSection',
            cssatrule: 'CssAtRule',
            atrule: 'CssAtRule',
            templatelandmark: 'TemplateLandmark',
            landmark: 'TemplateLandmark',
            dom: 'TemplateLandmark',
            documentsection: 'DocumentSection',
            section: 'DocumentSection',
            heading: 'DocumentSection',
            env: 'EnvVar',
            envvar: 'EnvVar',
            service: 'ServiceInstance',
            serviceinstance: 'ServiceInstance',
            stage: 'ServiceInstance',
            namespace: 'Namespace',
            module: 'Namespace',
        };
        return aliases[cleaned] ?? raw.trim();
    }
    /** Distinct node kinds with counts, used to explain zero-result `kind` filters. */
    listKindCounts(limit = 40) {
        return this.db
            .prepare(`SELECT kind, COUNT(*) AS count FROM nodes
         WHERE kind NOT IN ('File', 'WorkspacePackage')
         GROUP BY kind ORDER BY count DESC LIMIT ?`)
            .all(limit);
    }
    searchSymbols(query, rawKind, limit = 20) {
        const t0 = performance.now();
        const kind = this.normalizeKindFilter(rawKind);
        const cleaned = query.trim();
        if (!cleaned && !kind)
            return [];
        if (!cleaned && kind) {
            const rows = this.db
                .prepare(`SELECT * FROM nodes
           WHERE LOWER(kind) = LOWER(?)
              OR EXISTS (SELECT 1 FROM node_labels nl WHERE nl.node_id = nodes.id AND LOWER(nl.label) = LOWER(?))
           ORDER BY exported DESC, complexity DESC, file_path ASC, start_line ASC
           LIMIT ?`)
                .all(kind, kind, limit);
            const list = rows.map((r) => this.mapNodeRow(r));
            this.recordQueryTelemetry('searchSymbols', `kind:${kind}`, performance.now() - t0, list.length);
            return list;
        }
        const results = new Map();
        // If query is a SCIP URI, match id directly
        if (cleaned.startsWith('scip-')) {
            const scipRows = this.db
                .prepare('SELECT * FROM nodes WHERE id = ? OR id LIKE ? LIMIT ?')
                .all(cleaned, `${cleaned}%`, limit);
            for (const r of scipRows) {
                const mapped = this.mapNodeRow(r);
                results.set(mapped.id, mapped);
            }
        }
        else {
            // Match name and qualified_name only — NEVER match LOWER(id) LIKE %...% against SCIP package/file prefix
            const likePattern = `%${cleaned}%`;
            const prefixPattern = `${cleaned}%`;
            const sqlExact = kind
                ? `SELECT * FROM nodes
           WHERE (LOWER(kind) = LOWER(?) OR EXISTS (SELECT 1 FROM node_labels nl WHERE nl.node_id = nodes.id AND LOWER(nl.label) = LOWER(?)))
             AND (LOWER(name) LIKE LOWER(?) OR LOWER(qualified_name) LIKE LOWER(?))
           ORDER BY
             CASE WHEN LOWER(name) = LOWER(?) THEN 0 WHEN LOWER(name) LIKE LOWER(?) THEN 1 ELSE 2 END,
             CASE WHEN kind IN ('TestCase', 'TestSuite', 'File', 'WorkspacePackage') THEN 1 ELSE 0 END,
             CASE WHEN file_path LIKE '%.test.ts' THEN 1 ELSE 0 END,
             exported DESC,
             complexity DESC
           LIMIT ?`
                : `SELECT * FROM nodes
           WHERE (LOWER(name) LIKE LOWER(?) OR LOWER(qualified_name) LIKE LOWER(?))
             AND kind NOT IN ('File', 'WorkspacePackage')
           ORDER BY
             CASE WHEN LOWER(name) = LOWER(?) THEN 0 WHEN LOWER(name) LIKE LOWER(?) THEN 1 ELSE 2 END,
             CASE WHEN kind IN ('TestCase', 'TestSuite', 'StylesheetSection', 'CssAtRule', 'DocumentSection', 'TemplateLandmark') THEN 1 ELSE 0 END,
             CASE WHEN file_path LIKE '%.test.%' OR file_path LIKE '%.spec.%' OR file_path LIKE 'docs/%' OR file_path LIKE '%/mocks/%' OR file_path LIKE '%mockup%' THEN 1 ELSE 0 END,
             exported DESC,
             complexity DESC
           LIMIT ?`;
            const rows = (kind
                ? this.db
                    .prepare(sqlExact)
                    .all(kind, kind, likePattern, likePattern, cleaned, prefixPattern, limit)
                : this.db.prepare(sqlExact).all(likePattern, likePattern, cleaned, prefixPattern, limit));
            for (const r of rows) {
                const mapped = this.mapNodeRow(r);
                results.set(mapped.id, mapped);
            }
        }
        // Check suggestion hints or canonical aliases before FTS fallback so known conceptual terms rank high
        const hintNames = this.getQueryAliases()[cleaned];
        if (results.size < limit && hintNames && hintNames.length > 0) {
            const placeholders = hintNames.map(() => '?').join(', ');
            const hintRows = this.db
                .prepare(`SELECT * FROM nodes
           WHERE (name IN (${placeholders}) OR qualified_name IN (${placeholders}))
             ${kind ? 'AND (LOWER(kind) = LOWER(?) OR EXISTS (SELECT 1 FROM node_labels nl WHERE nl.node_id = nodes.id AND LOWER(nl.label) = LOWER(?)))' : ''}
           ORDER BY exported DESC, complexity DESC
           LIMIT ?`)
                .all(...hintNames, ...hintNames, ...(kind ? [kind, kind, limit] : [limit]));
            for (const r of hintRows) {
                if (results.size >= limit)
                    break;
                const mapped = this.mapNodeRow(r);
                results.set(mapped.id, mapped);
            }
        }
        // FTS5 BM25 lexical search (also splitting camelCase / PascalCase words)
        if (results.size < limit) {
            const expandedWords = cleaned
                .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                .replace(/[^a-zA-Z0-9_]/g, ' ')
                .split(/\s+/)
                .map((tok) => tok.trim())
                .filter((tok) => tok.length >= 2);
            const uniqueTokens = [...new Set(expandedWords)];
            const ftsTokens = uniqueTokens.map((tok) => `"${tok}"*`).join(' OR ');
            if (ftsTokens) {
                try {
                    const ftsRows = this.db
                        .prepare(`SELECT n.*
               FROM nodes_fts f
               JOIN nodes n ON n.id = f.id
               WHERE nodes_fts MATCH ?
               ${kind ? 'AND (LOWER(n.kind) = LOWER(?) OR EXISTS (SELECT 1 FROM node_labels nl WHERE nl.node_id = n.id AND LOWER(nl.label) = LOWER(?)))' : "AND n.kind NOT IN ('File', 'WorkspacePackage', 'TestCase', 'TestSuite')"}
               ORDER BY
                 CASE WHEN n.file_path LIKE '%.test.ts' THEN 1 ELSE 0 END,
                 bm25(nodes_fts),
                 n.exported DESC,
                 n.complexity DESC
               LIMIT ?`)
                        .all(...(kind ? [ftsTokens, kind, kind, limit] : [ftsTokens, limit]));
                    for (const r of ftsRows) {
                        if (results.size >= limit)
                            break;
                        const mapped = this.mapNodeRow(r);
                        results.set(mapped.id, mapped);
                    }
                }
                catch {
                    // Ignore FTS syntax edge cases
                }
            }
        }
        const out = [...results.values()].slice(0, limit);
        this.recordQueryTelemetry('searchSymbols', query, performance.now() - t0, out.length);
        return out;
    }
    suggestClosestSymbols(query, limit = 5) {
        const cleaned = query.trim();
        if (!cleaned)
            return [];
        const tokens = cleaned
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[^a-zA-Z0-9_]/g, ' ')
            .split(/\s+/)
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length >= 3);
        const results = new Map();
        for (const tok of tokens) {
            const prefix = `${tok.slice(0, Math.min(tok.length, 5))}%`;
            const sub = `%${tok.slice(0, Math.min(tok.length, 5))}%`;
            const rows = this.db
                .prepare(`SELECT * FROM nodes
           WHERE kind NOT IN ('File', 'WorkspacePackage', 'TestCase', 'TestSuite')
             AND (LOWER(name) LIKE ? OR LOWER(name) LIKE ? OR LOWER(qualified_name) LIKE ?)
           ORDER BY
             CASE WHEN kind IN ('StylesheetSection', 'CssAtRule', 'DocumentSection', 'TemplateLandmark') THEN 1 ELSE 0 END,
             CASE WHEN file_path LIKE '%.test.%' OR file_path LIKE '%.spec.%' OR file_path LIKE 'docs/%' OR file_path LIKE '%/mocks/%' OR file_path LIKE '%mockup%' THEN 1 ELSE 0 END,
             exported DESC,
             complexity DESC
           LIMIT ?`)
                .all(prefix, sub, sub, limit);
            for (const r of rows) {
                if (results.size >= limit)
                    break;
                const mapped = this.mapNodeRow(r);
                results.set(mapped.id, mapped);
            }
        }
        return [...results.values()].slice(0, limit);
    }
    getFileOutline(filePathQuery, options) {
        const t0 = performance.now();
        const normalized = this.normalizeFilePathQuery(filePathQuery);
        const limit = Math.max(1, Math.min(500, options?.limit ?? 250));
        if (!normalized) {
            return {
                query: filePathQuery,
                filePath: null,
                packageName: null,
                language: null,
                lineCount: 0,
                totalSymbolsInFile: 0,
                matchedSymbolsCount: 0,
                symbols: [],
                candidateFiles: [],
                latencyMs: performance.now() - t0,
            };
        }
        const fileRows = this.db
            .prepare(`SELECT file_path, package_name, language, line_count
         FROM files
         WHERE file_path = ?
            OR file_path LIKE ?
            OR LOWER(file_path) LIKE LOWER(?)
         ORDER BY
           CASE WHEN file_path = ? THEN 0 WHEN file_path LIKE ? THEN 1 ELSE 2 END,
           LENGTH(file_path) ASC
         LIMIT 10`)
            .all(normalized, `%/${normalized}`, `%${normalized}%`, normalized, `%/${normalized}`);
        const matchedFile = fileRows[0];
        if (!matchedFile) {
            // Check if the requested file exists on disk in canonicalRoot (e.g. .md, .yaml, .json, or unindexed file)
            const canonicalRoot = this.getMeta('canonical_root');
            if (canonicalRoot) {
                let diskRelPath = null;
                const directCandidate = path.resolve(canonicalRoot, normalized);
                if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).isFile()) {
                    diskRelPath = path.relative(canonicalRoot, directCandidate).split(path.sep).join('/');
                }
                if (diskRelPath) {
                    try {
                        const rawContent = fs.readFileSync(path.join(canonicalRoot, diskRelPath), 'utf8');
                        const fallback = buildFallbackStructuralOutline(diskRelPath, rawContent);
                        const filterLower = options?.filter?.trim().toLowerCase();
                        const kindFilterLower = this.normalizeKindFilter(options?.kind)?.toLowerCase();
                        const exportedOnly = Boolean(options?.exportedOnly);
                        const filteredSyms = fallback.symbols.filter((s) => {
                            if (kindFilterLower && s.kind.toLowerCase() !== kindFilterLower)
                                return false;
                            if (exportedOnly && !s.exported)
                                return false;
                            if (filterLower && !`${s.name} ${s.qualifiedName} ${s.signature}`.toLowerCase().includes(filterLower)) {
                                return false;
                            }
                            return true;
                        });
                        const slicedFallback = filteredSyms.slice(0, limit);
                        const latencyMs = performance.now() - t0;
                        this.recordQueryTelemetry('getFileOutline', filePathQuery, latencyMs, slicedFallback.length);
                        return {
                            query: filePathQuery,
                            filePath: diskRelPath,
                            packageName: path.basename(canonicalRoot),
                            language: fallback.language,
                            lineCount: fallback.lineCount,
                            totalSymbolsInFile: fallback.symbols.length,
                            matchedSymbolsCount: filteredSyms.length,
                            symbols: slicedFallback,
                            candidateFiles: [diskRelPath],
                            latencyMs,
                        };
                    }
                    catch {
                        // Fall through to standard candidateFiles response if unreadable
                    }
                }
            }
            const reqExt = path.extname(normalized).toLowerCase();
            const reqDir = path.dirname(normalized).replace(/^\.$/, '');
            const reqBase = path.basename(normalized, path.extname(normalized)).toLowerCase();
            const reqTokens = reqBase.split(/[-_./]+/).filter((t) => t.length >= 2);
            const allTrackedFiles = this.db.prepare('SELECT file_path FROM files ORDER BY file_path ASC').all().map((r) => r.file_path);
            const fallbackFiles = allTrackedFiles
                .map((fp) => {
                let score = 0;
                const fpLower = fp.toLowerCase();
                const fpBase = path.basename(fpLower, path.extname(fpLower));
                if (reqBase && fpBase === reqBase)
                    score += 25;
                else if (reqBase && (fpBase.includes(reqBase) || reqBase.includes(fpBase)))
                    score += 14;
                for (const tok of reqTokens) {
                    if (fpBase.includes(tok))
                        score += 6;
                }
                if (reqDir && fp.includes(reqDir))
                    score += 8;
                if (reqExt && fpLower.endsWith(reqExt))
                    score += 6;
                return { fp, score };
            })
                .sort((a, b) => b.score - a.score || a.fp.localeCompare(b.fp))
                .slice(0, 15)
                .map((x) => x.fp);
            const latencyMs = performance.now() - t0;
            this.recordQueryTelemetry('getFileOutline', filePathQuery, latencyMs, 0);
            return {
                query: filePathQuery,
                filePath: null,
                packageName: null,
                language: null,
                lineCount: 0,
                totalSymbolsInFile: 0,
                matchedSymbolsCount: 0,
                symbols: [],
                candidateFiles: fallbackFiles,
                latencyMs,
            };
        }
        const totalSymbolsInFile = this.db
            .prepare("SELECT COUNT(*) AS c FROM nodes WHERE file_path = ? AND kind NOT IN ('File', 'WorkspacePackage', 'Property')")
            .get(matchedFile.file_path).c;
        const allRows = this.db
            .prepare(`SELECT *
         FROM nodes
         WHERE file_path = ?
           AND kind NOT IN ('File', 'WorkspacePackage')
         ORDER BY start_line ASC, end_line ASC`)
            .all(matchedFile.file_path);
        if (allRows.length === 0) {
            const canonicalRoot = this.getMeta('canonical_root');
            if (canonicalRoot) {
                try {
                    const rawContent = fs.readFileSync(path.join(canonicalRoot, matchedFile.file_path), 'utf8');
                    const fallback = buildFallbackStructuralOutline(matchedFile.file_path, rawContent);
                    const filterLowerFallback = options?.filter?.trim().toLowerCase();
                    const kindFilterLowerFallback = this.normalizeKindFilter(options?.kind)?.toLowerCase();
                    const exportedOnlyFallback = Boolean(options?.exportedOnly);
                    const filteredSyms = fallback.symbols.filter((s) => {
                        if (kindFilterLowerFallback && s.kind.toLowerCase() !== kindFilterLowerFallback)
                            return false;
                        if (exportedOnlyFallback && !s.exported)
                            return false;
                        if (filterLowerFallback &&
                            !`${s.name} ${s.qualifiedName} ${s.signature}`.toLowerCase().includes(filterLowerFallback)) {
                            return false;
                        }
                        return true;
                    });
                    const slicedFallback = filteredSyms.slice(0, limit);
                    const latencyMs = performance.now() - t0;
                    this.recordQueryTelemetry('getFileOutline', filePathQuery, latencyMs, slicedFallback.length);
                    return {
                        query: filePathQuery,
                        filePath: matchedFile.file_path,
                        packageName: matchedFile.package_name,
                        language: matchedFile.language,
                        lineCount: Number(matchedFile.line_count),
                        totalSymbolsInFile: fallback.symbols.length,
                        matchedSymbolsCount: filteredSyms.length,
                        symbols: slicedFallback,
                        candidateFiles: fileRows.map((f) => f.file_path),
                        latencyMs,
                    };
                }
                catch {
                    // Fall through if file cannot be read
                }
            }
        }
        const filterLower = options?.filter?.trim().toLowerCase();
        const filterTokens = filterLower
            ? filterLower
                .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                .split(/[\s,|]+/)
                .filter(Boolean)
            : [];
        const kindFilterLower = this.normalizeKindFilter(options?.kind)?.toLowerCase();
        const exportedOnly = Boolean(options?.exportedOnly);
        const matchedSymbols = [];
        for (const r of allRows) {
            const kind = String(r.kind);
            const exported = Number(r.exported) === 1;
            if (!kindFilterLower && filterTokens.length === 0 && kind === 'Property')
                continue;
            if (kindFilterLower && kind.toLowerCase() !== kindFilterLower)
                continue;
            if (exportedOnly && !exported)
                continue;
            const name = String(r.name);
            const qualifiedName = String(r.qualified_name);
            const signature = String(r.signature);
            const docstring = String(r.docstring);
            if (filterTokens.length > 0) {
                const haystack = `${name} ${qualifiedName} ${signature}`.toLowerCase();
                const matchesFilter = filterTokens.some((tok) => haystack.includes(tok));
                if (!matchesFilter)
                    continue;
            }
            matchedSymbols.push({
                id: String(r.id),
                kind,
                name,
                qualifiedName,
                signature,
                exported,
                startLine: Number(r.start_line),
                endLine: Number(r.end_line),
                complexity: Number(r.complexity),
            });
        }
        const sliced = matchedSymbols.slice(0, limit);
        const latencyMs = performance.now() - t0;
        this.recordQueryTelemetry('getFileOutline', filePathQuery, latencyMs, sliced.length);
        return {
            query: filePathQuery,
            filePath: matchedFile.file_path,
            packageName: matchedFile.package_name,
            language: matchedFile.language,
            lineCount: Number(matchedFile.line_count),
            totalSymbolsInFile,
            matchedSymbolsCount: matchedSymbols.length,
            symbols: sliced,
            candidateFiles: fileRows.map((f) => f.file_path),
            latencyMs,
        };
    }
    mapEdgeRows(rows) {
        return rows.map((r) => ({
            srcId: String(r.src_id),
            srcName: String(r.src_name ?? r.src_id),
            srcKind: String(r.src_kind ?? 'Variable'),
            srcFilePath: String(r.src_file ?? r.file_path ?? ''),
            srcLine: Number(r.src_line ?? r.line ?? 0),
            dstId: String(r.dst_id),
            dstName: String(r.dst_name ?? r.dst_id),
            dstKind: String(r.dst_kind ?? 'Variable'),
            dstFilePath: String(r.dst_file ?? ''),
            dstLine: Number(r.dst_line ?? 0),
            edgeKind: String(r.kind),
            callSiteFile: String(r.file_path ?? ''),
            callSiteLine: Number(r.line ?? 0),
        }));
    }
    getSymbolNeighborhood(symbolIdOrName, options) {
        const t0 = performance.now();
        const limit = Math.max(1, Math.min(200, options?.limit ?? 20));
        const exactMatches = this.resolveTargetSymbols(symbolIdOrName, 10, { exactOnly: true });
        const focal = exactMatches[0] ?? null;
        if (!focal) {
            const suggestions = this.searchSymbols(symbolIdOrName, undefined, Math.min(limit, 15));
            const latencyMs = performance.now() - t0;
            this.recordQueryTelemetry('getSymbolNeighborhood', symbolIdOrName, latencyMs, 0);
            return {
                query: symbolIdOrName,
                symbol: null,
                matches: suggestions,
                callers: [],
                callees: [],
                typeReferences: [],
                coveringTests: [],
                totalCallersCount: 0,
                totalCalleesCount: 0,
                totalCoveringTestsCount: 0,
                latencyMs,
            };
        }
        const targetSliceLimit = focal.kind === 'File' ? 15 : 3;
        const targetIds = exactMatches.slice(0, targetSliceLimit).map((m) => m.id);
        const placeholders = targetIds.map(() => '?').join(', ');
        const outgoingEdgeKinds = focal.kind === 'File'
            ? "'CONTAINS', 'CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT'"
            : "'CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT'";
        const totalCallersCount = this.db
            .prepare(`SELECT COUNT(DISTINCT e.src_id || ':' || e.file_path || ':' || e.line) AS c
           FROM edges e
           JOIN nodes s ON s.id = e.src_id
           WHERE e.dst_id IN (${placeholders})
             AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT')
             AND s.kind NOT IN ('TestCase', 'TestSuite')`)
            .get(...targetIds).c;
        const incomingRows = this.db
            .prepare(`SELECT e.*,
                s.name AS src_name, s.kind AS src_kind, s.file_path AS src_file, s.start_line AS src_line,
                d.name AS dst_name, d.kind AS dst_kind, d.file_path AS dst_file, d.start_line AS dst_line
         FROM edges e
         JOIN nodes s ON s.id = e.src_id
         JOIN nodes d ON d.id = e.dst_id
         WHERE e.dst_id IN (${placeholders})
           AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT')
           AND s.kind NOT IN ('TestCase', 'TestSuite')
         GROUP BY e.src_id, e.dst_id, e.file_path, e.line
         ORDER BY
           CASE WHEN e.kind = 'WRITES_PROPERTY' THEN 0 ELSE 1 END,
           e.file_path ASC, e.line ASC
         LIMIT ?`)
            .all(...targetIds, limit);
        const totalCalleesCount = this.db
            .prepare(`SELECT COUNT(DISTINCT e.dst_id || ':' || e.file_path || ':' || e.line) AS c
           FROM edges e
           JOIN nodes d ON d.id = e.dst_id
           WHERE e.src_id IN (${placeholders})
             AND e.kind IN (${outgoingEdgeKinds})`)
            .get(...targetIds).c;
        const outgoingRows = this.db
            .prepare(`SELECT e.*,
                s.name AS src_name, s.kind AS src_kind, s.file_path AS src_file, s.start_line AS src_line,
                d.name AS dst_name, d.kind AS dst_kind, d.file_path AS dst_file, d.start_line AS dst_line
         FROM edges e
         JOIN nodes s ON s.id = e.src_id
         JOIN nodes d ON d.id = e.dst_id
         WHERE e.src_id IN (${placeholders})
           AND e.kind IN (${outgoingEdgeKinds})
         GROUP BY e.src_id, e.dst_id, e.file_path, e.line
         ORDER BY e.file_path ASC, e.line ASC
         LIMIT ?`)
            .all(...targetIds, limit);
        const typeRows = this.db
            .prepare(`SELECT e.*,
                s.name AS src_name, s.kind AS src_kind, s.file_path AS src_file, s.start_line AS src_line,
                d.name AS dst_name, d.kind AS dst_kind, d.file_path AS dst_file, d.start_line AS dst_line
         FROM edges e
         JOIN nodes s ON s.id = e.src_id
         JOIN nodes d ON d.id = e.dst_id
         WHERE (e.src_id IN (${placeholders}) OR e.dst_id IN (${placeholders}))
           AND e.kind IN ('EXTENDS', 'IMPLEMENTS', 'RETURNS_TYPE', 'HAS_PARAMETER_TYPE')
         GROUP BY e.src_id, e.dst_id, e.kind
         LIMIT ?`)
            .all(...targetIds, ...targetIds, limit);
        const totalCoveringTestsCount = this.db
            .prepare(`SELECT COUNT(DISTINCT s.id) AS c
           FROM edges e
           JOIN nodes s ON s.id = e.src_id
           WHERE e.dst_id IN (${placeholders})
             AND (e.kind IN ('TESTS_SYMBOL', 'TESTS_FILE') OR s.kind IN ('TestCase', 'TestSuite'))`)
            .get(...targetIds).c;
        const testRows = this.db
            .prepare(`SELECT s.id AS test_id, s.name AS test_name, s.kind AS test_kind,
                s.file_path, s.start_line, s.end_line, e.kind AS edge_kind
         FROM edges e
         JOIN nodes s ON s.id = e.src_id
         WHERE e.dst_id IN (${placeholders})
           AND (e.kind IN ('TESTS_SYMBOL', 'TESTS_FILE') OR s.kind IN ('TestCase', 'TestSuite'))
         GROUP BY s.id
         ORDER BY s.file_path ASC, s.start_line ASC
         LIMIT ?`)
            .all(...targetIds, limit);
        const latencyMs = performance.now() - t0;
        this.recordQueryTelemetry('getSymbolNeighborhood', symbolIdOrName, latencyMs, incomingRows.length + outgoingRows.length + testRows.length);
        return {
            query: symbolIdOrName,
            symbol: focal,
            matches: exactMatches,
            callers: this.mapEdgeRows(incomingRows),
            callees: this.mapEdgeRows(outgoingRows),
            typeReferences: this.mapEdgeRows(typeRows),
            coveringTests: testRows.map((r) => ({
                testId: String(r.test_id),
                testName: String(r.test_name),
                testKind: String(r.test_kind),
                filePath: String(r.file_path),
                startLine: Number(r.start_line),
                endLine: Number(r.end_line),
                edgeKind: String(r.edge_kind),
            })),
            totalCallersCount,
            totalCalleesCount,
            totalCoveringTestsCount,
            latencyMs,
        };
    }
    /**
     * Look up all read, write, and call sites for a symbol, class property, interface field, or Zod schema field.
     * Separates mutations (WRITES_PROPERTY) from reads/calls (READS_PROPERTY, REFERENCES, CALLS).
     */
    getSymbolReferences(symbolIdOrName, options) {
        const t0 = performance.now();
        const limit = Math.max(5, Math.min(200, options?.limit ?? 60));
        const matches = this.resolveTargetSymbols(symbolIdOrName, 50, { exactOnly: true });
        if (matches.length === 0) {
            const latencyMs = performance.now() - t0;
            this.recordQueryTelemetry('getSymbolReferences', symbolIdOrName, latencyMs, 0);
            return {
                target: symbolIdOrName,
                resolvedSymbols: [],
                writes: [],
                reads: [],
                references: [],
                totalWritesCount: 0,
                totalReadsCount: 0,
                totalReferencesCount: 0,
                latencyMs,
            };
        }
        const targetIds = matches.map((m) => m.id);
        const placeholders = targetIds.map(() => '?').join(', ');
        const allIncoming = this.db
            .prepare(`SELECT e.*,
                s.name AS src_name, s.kind AS src_kind, s.file_path AS src_file, s.start_line AS src_line, s.end_line AS src_end_line,
                d.name AS dst_name, d.kind AS dst_kind, d.file_path AS dst_file, d.start_line AS dst_line
         FROM edges e
         JOIN nodes s ON s.id = e.src_id
         JOIN nodes d ON d.id = e.dst_id
         WHERE e.dst_id IN (${placeholders})
           AND e.kind IN ('WRITES_PROPERTY', 'READS_PROPERTY', 'REFERENCES', 'CALLS', 'VALIDATES_SCHEMA')
         GROUP BY e.src_id, e.dst_id, e.kind, e.file_path, e.line
         ORDER BY
           CASE WHEN s.kind IN ('TestCase', 'TestSuite') THEN 1 ELSE 0 END,
           e.file_path ASC, e.line ASC`)
            .all(...targetIds);
        const mapped = allIncoming.map((r) => ({
            srcId: String(r.src_id),
            srcName: String(r.src_name),
            srcKind: String(r.src_kind),
            srcFilePath: String(r.src_file),
            srcLine: Number(r.src_line),
            srcStartLine: Number(r.src_line),
            srcEndLine: Number(r.src_end_line ?? r.src_line),
            dstId: String(r.dst_id),
            dstName: String(r.dst_name),
            dstKind: String(r.dst_kind),
            dstFilePath: String(r.dst_file),
            dstLine: Number(r.dst_line),
            edgeKind: String(r.kind),
            callSiteFile: String(r.file_path),
            callSiteLine: Number(r.line),
        }));
        const writes = mapped.filter((e) => e.edgeKind === 'WRITES_PROPERTY');
        const reads = mapped.filter((e) => e.edgeKind === 'READS_PROPERTY');
        const references = mapped.filter((e) => e.edgeKind !== 'WRITES_PROPERTY' && e.edgeKind !== 'READS_PROPERTY');
        const latencyMs = performance.now() - t0;
        this.recordQueryTelemetry('getSymbolReferences', symbolIdOrName, latencyMs, mapped.length);
        return {
            target: symbolIdOrName,
            resolvedSymbols: matches,
            writes: writes.slice(0, limit),
            reads: reads.slice(0, limit),
            references: references.slice(0, limit),
            totalWritesCount: writes.length,
            totalReadsCount: reads.length,
            totalReferencesCount: references.length,
            latencyMs,
        };
    }
    getBlastRadius(target, maxHops = 3) {
        const t0 = performance.now();
        const resolvedSymbols = this.resolveTargetSymbols(target, 8);
        if (resolvedSymbols.length === 0) {
            const latencyMs = performance.now() - t0;
            this.recordQueryTelemetry('getBlastRadius', target, latencyMs, 0);
            return {
                target,
                resolvedSymbols: [],
                maxHops,
                impactedNodes: [],
                impactedByHop: {},
                impactedPackages: [],
                impactedFiles: [],
                recommendedTests: [],
                vitestCommand: 'npx vitest run',
                latencyMs,
            };
        }
        // If a File node was resolved, include symbols defined inside that file as roots
        const seedIds = new Set();
        for (const sym of resolvedSymbols) {
            seedIds.add(sym.id);
            if (sym.kind === 'File') {
                const fileSyms = this.db
                    .prepare("SELECT id FROM nodes WHERE file_path = ? AND kind != 'File'")
                    .all(sym.filePath);
                for (const fsym of fileSyms) {
                    seedIds.add(fsym.id);
                }
            }
        }
        const seedList = [...seedIds].slice(0, 25);
        const placeholders = seedList.map(() => '?').join(', ');
        // Upstream recursive CTE over integer idx_edge_rows_reverse(dst_sid, kid, src_sid)
        const cteRows = this.db
            .prepare(`WITH RECURSIVE
           blast_kinds(kid, kind) AS (
             SELECT kid, kind FROM edge_kinds
             WHERE kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT', 'TESTS_SYMBOL', 'TESTS_FILE')
           ),
           seed_sids(sid) AS (
             SELECT sid FROM symbol_ids WHERE id IN (${placeholders})
           ),
           upstream(node_sid, from_sid, kid, hop) AS (
             SELECT e.src_sid, e.dst_sid, e.kid, 1
             FROM edge_rows e
             JOIN seed_sids ss ON ss.sid = e.dst_sid
             JOIN blast_kinds bk ON bk.kid = e.kid
             UNION
             SELECT e.src_sid, u.node_sid, e.kid, u.hop + 1
             FROM upstream u
             JOIN edge_rows e ON e.dst_sid = u.node_sid
             JOIN blast_kinds bk ON bk.kid = e.kid
             WHERE u.hop < ?
           )
         SELECT
           n.id, n.name, n.qualified_name, n.kind, n.package_name, n.file_path, n.start_line, n.end_line,
           MIN(u.hop) AS hop_distance,
           k.kind AS via_edge_kind,
           fs.id AS from_symbol_id
         FROM upstream u
         JOIN symbol_ids ns ON ns.sid = u.node_sid
         JOIN nodes n ON n.id = ns.id
         JOIN symbol_ids fs ON fs.sid = u.from_sid
         JOIN edge_kinds k ON k.kid = u.kid
         WHERE n.id NOT IN (${placeholders})
           AND n.kind != 'WorkspacePackage'
         GROUP BY n.id
         ORDER BY hop_distance ASC, n.package_name ASC, n.file_path ASC, n.start_line ASC
         LIMIT 250`)
            .all(...seedList, maxHops, ...seedList);
        const impactedNodes = cteRows.map((r) => ({
            id: String(r.id),
            name: String(r.name),
            qualifiedName: String(r.qualified_name),
            kind: String(r.kind),
            packageName: String(r.package_name),
            filePath: String(r.file_path),
            startLine: Number(r.start_line),
            endLine: Number(r.end_line),
            hopDistance: Number(r.hop_distance),
            viaEdgeKind: String(r.via_edge_kind),
            fromSymbolId: String(r.from_symbol_id),
        }));
        const impactedByHop = {};
        const pkgSet = new Set(resolvedSymbols.map((s) => s.packageName));
        const fileMap = new Map();
        for (const sym of resolvedSymbols) {
            if (sym.filePath) {
                fileMap.set(sym.filePath, {
                    filePath: sym.filePath,
                    packageName: sym.packageName,
                    symbolCount: 1,
                    minLine: sym.startLine,
                    maxLine: sym.endLine,
                });
            }
        }
        for (const node of impactedNodes) {
            if (!impactedByHop[node.hopDistance]) {
                impactedByHop[node.hopDistance] = [];
            }
            impactedByHop[node.hopDistance].push(node);
            if (node.packageName)
                pkgSet.add(node.packageName);
            if (node.filePath && !node.filePath.includes('.test.ts')) {
                const existing = fileMap.get(node.filePath);
                if (!existing) {
                    fileMap.set(node.filePath, {
                        filePath: node.filePath,
                        packageName: node.packageName,
                        symbolCount: 1,
                        minLine: node.startLine,
                        maxLine: node.endLine,
                    });
                }
                else {
                    existing.symbolCount += 1;
                    existing.minLine = Math.min(existing.minLine, node.startLine);
                    existing.maxLine = Math.max(existing.maxLine, node.endLine);
                }
            }
        }
        // Gather covering test cases from impacted nodes + direct tests for change
        const allIdsForTests = [...new Set([...seedList, ...impactedNodes.map((n) => n.id)])].slice(0, 60);
        const testPlaceholders = allIdsForTests.map(() => '?').join(', ');
        const coveringTestRows = this.db
            .prepare(`SELECT DISTINCT t.id, t.name, t.kind, t.file_path, t.package_name, t.start_line, t.end_line
         FROM edges e
         JOIN nodes t ON t.id = e.src_id
         WHERE e.dst_id IN (${testPlaceholders})
           AND t.kind IN ('TestCase', 'TestSuite')
         ORDER BY t.file_path ASC, t.start_line ASC`)
            .all(...allIdsForTests);
        // Also include any TestCase/TestSuite already in impactedNodes
        const testSuitesByFile = new Map();
        const addTestRow = (id, name, kind, filePath, packageName, startLine, endLine) => {
            if (!filePath)
                return;
            let group = testSuitesByFile.get(filePath);
            if (!group) {
                group = { testFilePath: filePath, packageName, testCases: [] };
                testSuitesByFile.set(filePath, group);
            }
            if (!group.testCases.some((tc) => tc.id === id)) {
                group.testCases.push({ id, name, kind, startLine, endLine });
            }
        };
        for (const r of coveringTestRows) {
            addTestRow(String(r.id), String(r.name), String(r.kind), String(r.file_path), String(r.package_name), Number(r.start_line), Number(r.end_line));
        }
        for (const n of impactedNodes) {
            if (n.kind === 'TestCase' ||
                n.kind === 'TestSuite' ||
                n.filePath.endsWith('.test.ts') ||
                n.filePath.endsWith('_test.go') ||
                path.basename(n.filePath).startsWith('test_') ||
                n.filePath.endsWith('_test.py')) {
                addTestRow(n.id, n.name, n.kind, n.filePath, n.packageName, n.startLine, n.endLine);
            }
        }
        const recommendedTests = [...testSuitesByFile.values()];
        const testFilePaths = recommendedTests.map((t) => t.testFilePath);
        const vitestCommand = this.formatTestCommand(testFilePaths, recommendedTests.flatMap((r) => r.testCases.map((tc) => tc.name)));
        const latencyMs = performance.now() - t0;
        this.recordQueryTelemetry('getBlastRadius', target, latencyMs, impactedNodes.length);
        return {
            target,
            resolvedSymbols,
            maxHops,
            impactedNodes,
            impactedByHop,
            impactedPackages: [...pkgSet],
            impactedFiles: [...fileMap.values()],
            recommendedTests,
            vitestCommand,
            latencyMs,
        };
    }
    formatTestCommand(testFilePaths, testCaseNames = []) {
        if (testFilePaths.length === 0) {
            const pyRow = this.db.prepare("SELECT 1 FROM files WHERE language = 'python' LIMIT 1").get();
            const goRow = this.db.prepare("SELECT 1 FROM files WHERE language = 'go' LIMIT 1").get();
            const rsRow = this.db.prepare("SELECT 1 FROM files WHERE language = 'rust' LIMIT 1").get();
            const tsRow = this.db.prepare("SELECT 1 FROM files WHERE language = 'typescript' LIMIT 1").get();
            if (goRow && !tsRow)
                return 'go test ./...';
            if (pyRow && !tsRow)
                return 'uv run pytest';
            if (rsRow && !tsRow)
                return 'cargo test';
            return 'npx vitest run';
        }
        const hasPy = testFilePaths.some((f) => f.endsWith('.py'));
        const hasGo = testFilePaths.some((f) => f.endsWith('.go'));
        const hasRs = testFilePaths.some((f) => f.endsWith('.rs'));
        const hasRb = testFilePaths.some((f) => f.endsWith('.rb'));
        const hasEx = testFilePaths.some((f) => f.endsWith('.exs') || f.endsWith('.ex'));
        const hasZig = testFilePaths.some((f) => f.endsWith('.zig'));
        if (hasGo) {
            const pkgs = [...new Set(testFilePaths.filter((f) => f.endsWith('.go')).map((f) => {
                    const dir = path.dirname(f);
                    return dir === '.' ? './...' : `./${dir}`;
                }))];
            const goTests = testCaseNames.filter((n) => n.startsWith('Test'));
            const runFlag = goTests.length > 0 && goTests.length <= 10 ? ` -run "^(${goTests.join('|')})$"` : '';
            return `go test ${pkgs.join(' ')}${runFlag}`;
        }
        if (hasPy) {
            return `uv run pytest ${testFilePaths.filter((f) => f.endsWith('.py')).join(' ')}`;
        }
        if (hasRs) {
            const rsTests = [...new Set(testCaseNames.filter((n) => n !== 'tests'))].slice(0, 5);
            if (rsTests.length === 1)
                return `cargo test ${rsTests[0]}`;
            if (rsTests.length > 1)
                return `cargo test -- ${rsTests.join(' ')}`;
            return 'cargo test';
        }
        if (hasRb) {
            return `bundle exec rspec ${testFilePaths.filter((f) => f.endsWith('.rb')).join(' ')}`;
        }
        if (hasEx) {
            return `mix test ${testFilePaths.filter((f) => f.endsWith('.exs') || f.endsWith('.ex')).join(' ')}`;
        }
        if (hasZig) {
            return `zig test ${testFilePaths.filter((f) => f.endsWith('.zig')).join(' ')}`;
        }
        return `npx vitest run ${testFilePaths.join(' ')}`;
    }
    getTestsForChange(target) {
        const t0 = performance.now();
        const resolvedSymbols = this.resolveTargetSymbols(target, 10);
        if (resolvedSymbols.length === 0) {
            const latencyMs = performance.now() - t0;
            this.recordQueryTelemetry('getTestsForChange', target, latencyMs, 0);
            return {
                target,
                resolvedSymbols: [],
                directTests: [],
                transitiveTests: [],
                testFiles: [],
                vitestCommand: this.formatTestCommand([]),
                latencyMs,
            };
        }
        const seedIds = new Set();
        for (const sym of resolvedSymbols) {
            seedIds.add(sym.id);
            if (sym.kind === 'File') {
                const fileSyms = this.db
                    .prepare('SELECT id FROM nodes WHERE file_path = ?')
                    .all(sym.filePath);
                for (const s of fileSyms)
                    seedIds.add(s.id);
            }
        }
        const seedList = [...seedIds].slice(0, 30);
        const placeholders = seedList.map(() => '?').join(', ');
        const directRows = this.db
            .prepare(`SELECT t.id, t.name, t.kind, t.file_path, t.package_name, t.start_line, t.end_line,
                d.name AS target_symbol_name, e.kind AS edge_kind
         FROM edges e
         JOIN nodes t ON t.id = e.src_id
         JOIN nodes d ON d.id = e.dst_id
         WHERE e.dst_id IN (${placeholders})
           AND (e.kind IN ('TESTS_SYMBOL', 'TESTS_FILE') OR t.kind IN ('TestCase', 'TestSuite'))
         ORDER BY t.file_path ASC, t.start_line ASC`)
            .all(...seedList);
        const directIds = new Set(directRows.map((r) => String(r.id)));
        // Transitive tests via 2-3 hop blast radius
        const blast = this.getBlastRadius(target, 3);
        const transitiveTests = [];
        for (const group of blast.recommendedTests) {
            for (const tc of group.testCases) {
                if (!directIds.has(tc.id)) {
                    transitiveTests.push({
                        id: tc.id,
                        name: tc.name,
                        kind: tc.kind,
                        filePath: group.testFilePath,
                        packageName: group.packageName,
                        startLine: tc.startLine,
                        endLine: tc.endLine,
                        hopDistance: 2,
                    });
                }
            }
        }
        const directTestsMap = new Map();
        for (const r of directRows) {
            const id = String(r.id);
            if (!directTestsMap.has(id)) {
                directTestsMap.set(id, {
                    id,
                    name: String(r.name),
                    kind: String(r.kind),
                    filePath: String(r.file_path),
                    packageName: String(r.package_name),
                    startLine: Number(r.start_line),
                    endLine: Number(r.end_line),
                    targetSymbolName: String(r.target_symbol_name),
                    edgeKind: String(r.edge_kind),
                });
            }
        }
        const directTests = [...directTestsMap.values()];
        const testFiles = [
            ...new Set([
                ...directTests.map((d) => d.filePath),
                ...transitiveTests.map((t) => t.filePath),
            ]),
        ];
        const testCaseNames = [
            ...directTests.filter((d) => d.kind === 'TestCase').map((d) => d.name),
            ...transitiveTests.filter((t) => t.kind === 'TestCase').map((t) => t.name),
        ];
        const vitestCommand = this.formatTestCommand(testFiles, testCaseNames);
        const latencyMs = performance.now() - t0;
        this.recordQueryTelemetry('getTestsForChange', target, latencyMs, directTests.length + transitiveTests.length);
        return {
            target,
            resolvedSymbols,
            directTests,
            transitiveTests,
            testFiles,
            vitestCommand,
            latencyMs,
        };
    }
    getCrossLayerLineage(target) {
        const t0 = performance.now();
        const focalNodes = this.resolveTargetSymbols(target, 10);
        if (focalNodes.length === 0) {
            const latencyMs = performance.now() - t0;
            this.recordQueryTelemetry('getCrossLayerLineage', target, latencyMs, 0);
            return {
                target,
                focalNodes: [],
                validators: [],
                emitters: [],
                routesHandled: [],
                endpointClients: [],
                infraProvisions: [],
                downstreamConsumers: [],
                upstreamProviders: [],
                latencyMs,
            };
        }
        const ids = focalNodes.map((n) => n.id);
        const placeholders = ids.map(() => '?').join(', ');
        const edgeQuery = (whereClause, params) => this.mapEdgeRows(this.db
            .prepare(`SELECT e.*,
                    s.name AS src_name, s.kind AS src_kind, s.file_path AS src_file, s.start_line AS src_line,
                    d.name AS dst_name, d.kind AS dst_kind, d.file_path AS dst_file, d.start_line AS dst_line
             FROM edges e
             JOIN nodes s ON s.id = e.src_id
             JOIN nodes d ON d.id = e.dst_id
             WHERE ${whereClause}
             ORDER BY e.file_path ASC, e.line ASC
             LIMIT 100`)
            .all(...params));
        const validators = edgeQuery(`(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind = 'VALIDATES_SCHEMA'`, [...ids, ...ids]);
        const emitters = edgeQuery(`(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind = 'EMITS_SCHEMA'`, [...ids, ...ids]);
        const routesHandled = edgeQuery(`(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind = 'HANDLES_ROUTE'`, [...ids, ...ids]);
        const endpointClients = edgeQuery(`(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind IN ('CONNECTS_ENDPOINT', 'CALLS_ROUTE')`, [...ids, ...ids]);
        const infraProvisions = edgeQuery(`(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind IN ('PROVISIONS_SERVICE', 'REFERENCES_TF_RESOURCE', 'CONFIGURES_ENV')`, [...ids, ...ids]);
        const downstreamConsumers = edgeQuery(`e.dst_id IN (${placeholders}) AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS') AND s.kind NOT IN ('TestCase', 'TestSuite')`, ids);
        const upstreamProviders = edgeQuery(`e.src_id IN (${placeholders}) AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS')`, ids);
        const latencyMs = performance.now() - t0;
        this.recordQueryTelemetry('getCrossLayerLineage', target, latencyMs, validators.length + routesHandled.length + endpointClients.length + downstreamConsumers.length);
        return {
            target,
            focalNodes,
            validators,
            emitters,
            routesHandled,
            endpointClients,
            infraProvisions,
            downstreamConsumers,
            upstreamProviders,
            latencyMs,
        };
    }
    findShortestPath(fromTarget, toTarget, maxHops = 6) {
        const t0 = performance.now();
        const fromNodes = this.resolveTargetSymbols(fromTarget, 5);
        const toNodes = this.resolveTargetSymbols(toTarget, 5);
        if (fromNodes.length === 0 || toNodes.length === 0) {
            const latencyMs = performance.now() - t0;
            this.recordQueryTelemetry('findShortestPath', `${fromTarget}->${toTarget}`, latencyMs, 0);
            return {
                fromTarget,
                toTarget,
                found: false,
                hopCount: 0,
                path: [],
                latencyMs,
            };
        }
        const startIds = new Set(fromNodes.map((n) => n.id));
        for (const fn of fromNodes) {
            if (fn.kind === 'File') {
                const syms = this.db
                    .prepare('SELECT id FROM nodes WHERE file_path = ?')
                    .all(fn.filePath);
                for (const s of syms)
                    startIds.add(s.id);
            }
        }
        const goalIds = new Set(toNodes.map((n) => n.id));
        for (const tn of toNodes) {
            if (tn.kind === 'File') {
                const syms = this.db
                    .prepare('SELECT id FROM nodes WHERE file_path = ?')
                    .all(tn.filePath);
                for (const s of syms)
                    goalIds.add(s.id);
            }
        }
        const visited = new Set(startIds);
        const queue = [...startIds].map((id) => ({ nodeId: id, steps: [] }));
        const outEdgesStmt = this.db.prepare(`SELECT src_id, dst_id, kind, line
       FROM edges
       WHERE src_id = ?
         AND kind != 'CONTAINS'`);
        const inEdgesStmt = this.db.prepare(`SELECT src_id, dst_id, kind, line
       FROM edges
       WHERE dst_id = ?
         AND kind != 'CONTAINS'`);
        let matchedSteps = null;
        while (queue.length > 0) {
            const current = queue.shift();
            if (goalIds.has(current.nodeId) && current.steps.length > 0) {
                matchedSteps = current.steps;
                break;
            }
            if (current.steps.length >= maxHops)
                continue;
            const forwardRows = outEdgesStmt.all(current.nodeId);
            for (const e of forwardRows) {
                if (!visited.has(e.dst_id)) {
                    visited.add(e.dst_id);
                    const nextSteps = [
                        ...current.steps,
                        {
                            fromId: e.src_id,
                            toId: e.dst_id,
                            edgeKind: e.kind,
                            line: Number(e.line),
                        },
                    ];
                    if (goalIds.has(e.dst_id)) {
                        matchedSteps = nextSteps;
                        break;
                    }
                    queue.push({ nodeId: e.dst_id, steps: nextSteps });
                }
            }
            if (matchedSteps)
                break;
            // Also allow traversing reverse dependency edges if no forward path alone connects them
            const reverseRows = inEdgesStmt.all(current.nodeId);
            for (const e of reverseRows) {
                if (!visited.has(e.src_id)) {
                    visited.add(e.src_id);
                    const nextSteps = [
                        ...current.steps,
                        {
                            fromId: e.src_id,
                            toId: e.dst_id,
                            edgeKind: e.kind,
                            line: Number(e.line),
                        },
                    ];
                    if (goalIds.has(e.src_id)) {
                        matchedSteps = nextSteps;
                        break;
                    }
                    queue.push({ nodeId: e.src_id, steps: nextSteps });
                }
            }
            if (matchedSteps)
                break;
        }
        const nodeLookup = this.db.prepare('SELECT id, name, file_path FROM nodes WHERE id = ?');
        const pathSteps = (matchedSteps ?? []).map((st) => {
            const fromRow = nodeLookup.get(st.fromId);
            const toRow = nodeLookup.get(st.toId);
            return {
                fromId: st.fromId,
                fromName: fromRow?.name ?? st.fromId,
                fromFile: fromRow?.file_path ?? '',
                edgeKind: st.edgeKind,
                toId: st.toId,
                toName: toRow?.name ?? st.toId,
                toFile: toRow?.file_path ?? '',
                line: st.line,
            };
        });
        const latencyMs = performance.now() - t0;
        this.recordQueryTelemetry('findShortestPath', `${fromTarget}->${toTarget}`, latencyMs, pathSteps.length);
        return {
            fromTarget,
            toTarget,
            found: pathSteps.length > 0,
            hopCount: pathSteps.length,
            path: pathSteps,
            latencyMs,
        };
    }
    exportGraph(outputDir) {
        const resolvedDir = path.resolve(outputDir);
        fs.mkdirSync(resolvedDir, { recursive: true });
        const cypherPath = path.join(resolvedDir, 'export.cypher');
        const jsonlPath = path.join(resolvedDir, 'snapshot.jsonl');
        const nodes = this.db.prepare('SELECT * FROM nodes ORDER BY id ASC').all();
        const edges = this.db
            .prepare('SELECT * FROM edges ORDER BY src_id ASC, kind ASC, dst_id ASC')
            .all();
        const escapeCypher = (val) => val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
        const cypherLines = [
            '// Auto-generated openCypher Labeled Property Graph export from @warehouse/ast-sidecar',
            `// Generated at: ${new Date().toISOString()}`,
        ];
        const jsonlLines = [];
        for (const n of nodes) {
            const mapped = this.mapNodeRow(n);
            const safeLabel = mapped.kind.replace(/[^A-Za-z0-9_]/g, '_') || 'AstNode';
            cypherLines.push(`MERGE (n:${safeLabel} {id: "${escapeCypher(mapped.id)}"}) SET n.name = "${escapeCypher(mapped.name)}", n.qualifiedName = "${escapeCypher(mapped.qualifiedName)}", n.packageName = "${escapeCypher(mapped.packageName)}", n.filePath = "${escapeCypher(mapped.filePath)}", n.startLine = ${mapped.startLine}, n.endLine = ${mapped.endLine}, n.complexity = ${mapped.complexity}, n.exported = ${mapped.exported};`);
            jsonlLines.push(JSON.stringify({
                type: 'node',
                id: mapped.id,
                labels: mapped.labels,
                properties: {
                    kind: mapped.kind,
                    name: mapped.name,
                    qualifiedName: mapped.qualifiedName,
                    packageName: mapped.packageName,
                    filePath: mapped.filePath,
                    language: mapped.language,
                    startLine: mapped.startLine,
                    endLine: mapped.endLine,
                    signature: mapped.signature,
                    exported: mapped.exported,
                    complexity: mapped.complexity,
                },
            }));
        }
        for (const e of edges) {
            const srcId = String(e.src_id);
            const dstId = String(e.dst_id);
            const kind = String(e.kind).replace(/[^A-Za-z0-9_]/g, '_') || 'RELATES_TO';
            const filePath = String(e.file_path);
            const line = Number(e.line);
            cypherLines.push(`MATCH (a {id: "${escapeCypher(srcId)}"}), (b {id: "${escapeCypher(dstId)}"}) MERGE (a)-[r:${kind} {filePath: "${escapeCypher(filePath)}", line: ${line}}]->(b);`);
            jsonlLines.push(JSON.stringify({
                type: 'edge',
                srcId,
                dstId,
                kind,
                properties: {
                    filePath,
                    line,
                    col: Number(e.col),
                    weight: Number(e.weight),
                },
            }));
        }
        fs.writeFileSync(cypherPath, cypherLines.join('\n') + '\n', 'utf8');
        fs.writeFileSync(jsonlPath, jsonlLines.join('\n') + '\n', 'utf8');
        return {
            cypherPath,
            jsonlPath,
            nodesExported: nodes.length,
            edgesExported: edges.length,
        };
    }
}
//# sourceMappingURL=db.js.map