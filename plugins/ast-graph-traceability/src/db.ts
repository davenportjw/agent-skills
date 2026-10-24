import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type {
  BlastRadiusNode,
  BlastRadiusResult,
  CompilerGraphBatch,
  EdgeKind,
  EdgeSummary,
  FileOutlineResult,
  FileOutlineSymbol,
  LineageResult,
  NodeKind,
  ScipSymbolUri,
  ShortestPathResult,
  ShortestPathStep,
  SymbolNeighborhood,
  SymbolReferencesResult,
  SymbolSummary,
  TestsForChangeResult,
} from './types.js';

const CANONICAL_QUERY_ALIASES: Record<string, string[]> = {
  'SimEngine.step': ['tick', 'stepHuman', 'stepHumanTick'],
  sanitizeDirective: ['sanitiseOutputText', 'normaliseInput', 'validateParsedOrder', 'applyAgentDirective'],
  SiteServer: ['createSiteServer', 'SiteServerInstance', 'SiteServerOptions'],
  LobbyServer: ['createLobbyServer', 'selectSiteForJoin'],
};

const SUGGESTION_QUERY_HINTS: Record<string, string[]> = {
  SimEngine: ['tick', 'createWorld', 'stepHuman', 'humanInteract', 'interactAt'],
};

export class AstGraphDatabase {
  public readonly dbPath: string;
  public readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, {
      open: true,
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;

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

      CREATE TABLE IF NOT EXISTS edges (
        src_id TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        col INTEGER NOT NULL,
        weight REAL NOT NULL,
        properties_json TEXT NOT NULL,
        PRIMARY KEY (src_id, dst_id, kind, file_path, line)
      ) STRICT;

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

      CREATE INDEX IF NOT EXISTS idx_edges_forward ON edges(src_id, kind, dst_id);
      CREATE INDEX IF NOT EXISTS idx_edges_reverse ON edges(dst_id, kind, src_id);
      CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
      CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind, name);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_qualified ON nodes(qualified_name);
    `);
  }

  public close(): void {
    this.db.close();
  }

  public getTrackedFilesMap(): Map<string, { sha256: string; mtimeMs: number }> {
    const stmt = this.db.prepare('SELECT file_path, sha256, mtime_ms FROM files');
    const rows = stmt.all() as Array<{ file_path: string; sha256: string; mtime_ms: number }>;
    const map = new Map<string, { sha256: string; mtimeMs: number }>();
    for (const r of rows) {
      map.set(r.file_path, { sha256: r.sha256, mtimeMs: r.mtime_ms });
    }
    return map;
  }

  public removeDeletedFiles(existingFilePaths: Set<string>): number {
    const tracked = this.getTrackedFilesMap();
    const toDelete: string[] = [];
    for (const filePath of tracked.keys()) {
      if (!existingFilePaths.has(filePath)) {
        toDelete.push(filePath);
      }
    }
    if (toDelete.length === 0) return 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const delFts = this.db.prepare('DELETE FROM nodes_fts WHERE file_path = ?');
      const delLabels = this.db.prepare(
        'DELETE FROM node_labels WHERE node_id IN (SELECT id FROM nodes WHERE file_path = ?)',
      );
      const delNodes = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
      const delEdges = this.db.prepare('DELETE FROM edges WHERE file_path = ?');
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
      // Also clean up any dangling edges whose src or dst node was removed
      this.db.exec(`
        DELETE FROM edges
        WHERE (src_id NOT LIKE 'scip-endpoint %' AND src_id NOT IN (SELECT id FROM nodes))
      `);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return toDelete.length;
  }

  public applyBatch(batch: CompilerGraphBatch, clearExistingForFiles = true): void {
    const nowIso = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (clearExistingForFiles && batch.files.length > 0) {
        const delFts = this.db.prepare('DELETE FROM nodes_fts WHERE file_path = ?');
        const delLabels = this.db.prepare(
          'DELETE FROM node_labels WHERE node_id IN (SELECT id FROM nodes WHERE file_path = ?)',
        );
        const delNodes = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
        const delEdges = this.db.prepare('DELETE FROM edges WHERE file_path = ?');
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
        insFile.run(
          f.filePath,
          f.packageName,
          f.language,
          f.sha256,
          f.mtimeMs,
          f.sizeBytes,
          f.lineCount,
          nowIso,
        );
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
        insNode.run(
          n.id,
          n.kind,
          n.name,
          n.qualifiedName,
          n.packageName,
          n.filePath,
          n.language,
          n.startLine,
          n.startCol,
          n.endLine,
          n.endCol,
          n.signature,
          n.docstring,
          n.exported ? 1 : 0,
          n.complexity,
          JSON.stringify(n.properties ?? {}),
        );
        insLabel.run(n.id, n.kind);
        for (const label of n.labels) {
          insLabel.run(n.id, label);
        }
        delFtsById.run(n.id);
        insFts.run(
          n.id,
          n.name,
          n.qualifiedName,
          n.signature,
          n.docstring,
          n.packageName,
          n.filePath,
        );
      }

      const insEdge = this.db.prepare(`
        INSERT OR REPLACE INTO edges (
          src_id, dst_id, kind, file_path, line, col, weight, properties_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const e of batch.edges) {
        insEdge.run(
          e.srcId,
          e.dstId,
          e.kind,
          e.filePath,
          e.line,
          e.col,
          e.weight,
          JSON.stringify(e.properties ?? {}),
        );
      }

      const insDiag = this.db.prepare(`
        INSERT INTO diagnostics (
          file_path, enclosing_symbol_id, compiler, severity, code, message, line, col
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const d of batch.diagnostics) {
        insDiag.run(
          d.filePath,
          d.enclosingSymbolId,
          d.compiler,
          d.severity,
          d.code,
          d.message,
          d.line,
          d.col,
        );
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public recordSyncRun(params: {
    durationMs: number;
    mode: string;
    filesScanned: number;
    filesUpdated: number;
  }): void {
    const counts = this.getCounts();
    const stmt = this.db.prepare(`
      INSERT INTO sync_runs (
        started_at, duration_ms, mode, files_scanned, files_updated, nodes_count, edges_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      new Date().toISOString(),
      params.durationMs,
      params.mode,
      params.filesScanned,
      params.filesUpdated,
      counts.nodes,
      counts.edges,
    );
  }

  public recordQueryTelemetry(queryType: string, target: string, latencyMs: number, resultCount: number): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO query_telemetry (executed_at, query_type, target, latency_ms, result_count)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(new Date().toISOString(), queryType, target, latencyMs, resultCount);
    } catch {
      // Ignore telemetry write errors if read-only
    }
  }

  public getCounts(): {
    files: number;
    nodes: number;
    edges: number;
    diagnostics: number;
    packages: number;
  } {
    const files = (this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c;
    const nodes = (this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
    const edges = (this.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
    const diagnostics = (this.db.prepare('SELECT COUNT(*) AS c FROM diagnostics').get() as { c: number }).c;
    const packages = (
      this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'WorkspacePackage'").get() as { c: number }
    ).c;
    return { files, nodes, edges, diagnostics, packages };
  }

  private mapNodeRow(row: Record<string, unknown>): SymbolSummary {
    const id = String(row.id);
    const labelRows = this.db
      .prepare('SELECT label FROM node_labels WHERE node_id = ?')
      .all(id) as Array<{ label: string }>;
    return {
      id,
      kind: String(row.kind) as NodeKind,
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

  private normalizeFilePathQuery(raw: string): string {
    let cleaned = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const matchRel = cleaned.match(/((?:packages|apps|tools|infra)\/.+)$/);
    if (matchRel?.[1]) {
      cleaned = matchRel[1];
    }
    return cleaned;
  }

  public resolveTargetSymbols(
    target: string,
    limit = 15,
    options?: { exactOnly?: boolean },
  ): SymbolSummary[] {
    const trimmed = target.trim();
    if (!trimmed) return [];

    // 1. Exact ID match (ONLY when target starts with 'scip-')
    if (trimmed.startsWith('scip-')) {
      const byId = this.db.prepare('SELECT * FROM nodes WHERE id = ?').all(trimmed) as Array<Record<string, unknown>>;
      if (byId.length > 0) return byId.map((r) => this.mapNodeRow(r));
    }

    // 2. Exact qualified_name, name, or RouteEndpoint path match (prioritizing non-File / non-TestCase definitions first)
    const byExact = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE qualified_name = ?
            OR name = ?
            OR (kind = 'RouteEndpoint' AND (name LIKE ? OR id LIKE ?))
         ORDER BY
           CASE WHEN kind IN ('RouteEndpoint', 'Function', 'Class', 'Method', 'ZodSchema', 'Interface', 'Property', 'Variable', 'TerraformResource') THEN 0 ELSE 1 END,
           CASE WHEN file_path LIKE '%.test.ts' THEN 1 ELSE 0 END,
           exported DESC,
           complexity DESC
         LIMIT ?`,
      )
      .all(trimmed, trimmed, `% ${trimmed}`, `%:${trimmed}#`, limit) as Array<Record<string, unknown>>;
    if (byExact.length > 0) return byExact.map((r) => this.mapNodeRow(r));

    // 3. File path match (exact or suffix)
    const normalizedPath = this.normalizeFilePathQuery(trimmed);
    if (normalizedPath.includes('/') || /\.(ts|mjs|js|tf|py)$/.test(normalizedPath)) {
      const byFile = this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE file_path = ? OR file_path LIKE ?
           ORDER BY CASE WHEN kind = 'File' THEN 0 ELSE 1 END, start_line ASC
           LIMIT ?`,
        )
        .all(normalizedPath, `%/${normalizedPath}`, limit) as Array<Record<string, unknown>>;
      if (byFile.length > 0) return byFile.map((r) => this.mapNodeRow(r));
    }

    // 4. Canonical domain alias resolution (e.g. SimEngine.step -> tick, sanitizeDirective -> sanitiseOutputText/normaliseInput)
    const aliasTargets = CANONICAL_QUERY_ALIASES[trimmed];
    if (aliasTargets && aliasTargets.length > 0) {
      const placeholders = aliasTargets.map(() => '?').join(', ');
      const aliasRows = this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE name IN (${placeholders}) OR qualified_name IN (${placeholders})
           ORDER BY exported DESC, complexity DESC
           LIMIT ?`,
        )
        .all(...aliasTargets, ...aliasTargets, limit) as Array<Record<string, unknown>>;
      if (aliasRows.length > 0) {
        aliasRows.sort((a, b) => {
          const idxA = aliasTargets.indexOf(String(a.name));
          const idxB = aliasTargets.indexOf(String(b.name));
          const rankA = idxA === -1 ? 999 : idxA;
          const rankB = idxB === -1 ? 999 : idxB;
          if (rankA !== rankB) return rankA - rankB;
          return Number(b.complexity) - Number(a.complexity);
        });
        return aliasRows.map((r) => this.mapNodeRow(r));
      }
    }

    // 5. Dotted Class.method or Package.symbol suffix match (matching qualified_name, never SCIP id prefix)
    if (trimmed.includes('.') && !/\.(ts|mjs|js|tf|py)$/.test(trimmed)) {
      const parts = trimmed.split('.');
      const memberPart = parts[parts.length - 1] ?? trimmed;
      const containerPart = parts[0] ?? '';
      const dottedRows = this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE qualified_name = ?
              OR qualified_name LIKE ?
              OR (name = ? AND qualified_name LIKE ?)
           ORDER BY
             CASE WHEN file_path LIKE '%.test.ts' THEN 1 ELSE 0 END,
             exported DESC,
             complexity DESC
           LIMIT ?`,
        )
        .all(trimmed, `%.${trimmed}`, memberPart, `%${containerPart}%.${memberPart}`, limit) as Array<
        Record<string, unknown>
      >;
      if (dottedRows.length > 0) return dottedRows.map((r) => this.mapNodeRow(r));
    }

    if (options?.exactOnly) {
      return [];
    }

    // 6. Fallback to searchSymbols (FTS5 + name/qualified_name LIKE)
    return this.searchSymbols(trimmed, undefined, limit);
  }

  public searchSymbols(query: string, kind?: string, limit = 20): SymbolSummary[] {
    const t0 = performance.now();
    const cleaned = query.trim();
    if (!cleaned) return [];

    const results = new Map<string, SymbolSummary>();

    // If query is a SCIP URI, match id directly
    if (cleaned.startsWith('scip-')) {
      const scipRows = this.db
        .prepare('SELECT * FROM nodes WHERE id = ? OR id LIKE ? LIMIT ?')
        .all(cleaned, `${cleaned}%`, limit) as Array<Record<string, unknown>>;
      for (const r of scipRows) {
        const mapped = this.mapNodeRow(r);
        results.set(mapped.id, mapped);
      }
    } else {
      // Match name and qualified_name only — NEVER match LOWER(id) LIKE %...% against SCIP package/file prefix
      const likePattern = `%${cleaned}%`;
      const prefixPattern = `${cleaned}%`;
      const sqlExact = kind
        ? `SELECT * FROM nodes
           WHERE LOWER(kind) = LOWER(?)
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
             CASE WHEN kind IN ('TestCase', 'TestSuite') THEN 1 ELSE 0 END,
             CASE WHEN file_path LIKE '%.test.ts' THEN 1 ELSE 0 END,
             exported DESC,
             complexity DESC
           LIMIT ?`;

      const rows = (
        kind
          ? this.db
              .prepare(sqlExact)
              .all(kind, likePattern, likePattern, cleaned, prefixPattern, limit)
          : this.db.prepare(sqlExact).all(likePattern, likePattern, cleaned, prefixPattern, limit)
      ) as Array<Record<string, unknown>>;

      for (const r of rows) {
        const mapped = this.mapNodeRow(r);
        results.set(mapped.id, mapped);
      }
    }

    // Check suggestion hints or canonical aliases before FTS fallback so known conceptual terms rank high
    const hintNames = SUGGESTION_QUERY_HINTS[cleaned] ?? CANONICAL_QUERY_ALIASES[cleaned];
    if (results.size < limit && hintNames && hintNames.length > 0) {
      const placeholders = hintNames.map(() => '?').join(', ');
      const hintRows = this.db
        .prepare(
          `SELECT * FROM nodes
           WHERE (name IN (${placeholders}) OR qualified_name IN (${placeholders}))
             ${kind ? 'AND LOWER(kind) = LOWER(?)' : ''}
           ORDER BY exported DESC, complexity DESC
           LIMIT ?`,
        )
        .all(...hintNames, ...hintNames, ...(kind ? [kind, limit] : [limit])) as Array<Record<string, unknown>>;
      for (const r of hintRows) {
        if (results.size >= limit) break;
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
            .prepare(
              `SELECT n.*
               FROM nodes_fts f
               JOIN nodes n ON n.id = f.id
               WHERE nodes_fts MATCH ?
               ${kind ? 'AND LOWER(n.kind) = LOWER(?)' : "AND n.kind NOT IN ('File', 'WorkspacePackage', 'TestCase', 'TestSuite')"}
               ORDER BY
                 CASE WHEN n.file_path LIKE '%.test.ts' THEN 1 ELSE 0 END,
                 bm25(nodes_fts),
                 n.exported DESC,
                 n.complexity DESC
               LIMIT ?`,
            )
            .all(...(kind ? [ftsTokens, kind, limit] : [ftsTokens, limit])) as Array<Record<string, unknown>>;
          for (const r of ftsRows) {
            if (results.size >= limit) break;
            const mapped = this.mapNodeRow(r);
            results.set(mapped.id, mapped);
          }
        } catch {
          // Ignore FTS syntax edge cases
        }
      }
    }

    const out = [...results.values()].slice(0, limit);
    this.recordQueryTelemetry('searchSymbols', query, performance.now() - t0, out.length);
    return out;
  }

  public getFileOutline(
    filePathQuery: string,
    options?: { filter?: string; kind?: string; exportedOnly?: boolean; limit?: number },
  ): FileOutlineResult {
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
      .prepare(
        `SELECT file_path, package_name, language, line_count
         FROM files
         WHERE file_path = ?
            OR file_path LIKE ?
            OR LOWER(file_path) LIKE LOWER(?)
         ORDER BY
           CASE WHEN file_path = ? THEN 0 WHEN file_path LIKE ? THEN 1 ELSE 2 END,
           LENGTH(file_path) ASC
         LIMIT 10`,
      )
      .all(
        normalized,
        `%/${normalized}`,
        `%${normalized}%`,
        normalized,
        `%/${normalized}`,
      ) as Array<{ file_path: string; package_name: string; language: string; line_count: number }>;

    const matchedFile = fileRows[0];
    if (!matchedFile) {
      const fallbackFiles = (
        this.db.prepare('SELECT file_path FROM files ORDER BY file_path ASC LIMIT 15').all() as Array<{
          file_path: string;
        }>
      ).map((r) => r.file_path);
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

    const totalSymbolsInFile = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM nodes WHERE file_path = ? AND kind NOT IN ('File', 'WorkspacePackage', 'Property')")
        .get(matchedFile.file_path) as { c: number }
    ).c;

    const allRows = this.db
      .prepare(
        `SELECT *
         FROM nodes
         WHERE file_path = ?
           AND kind NOT IN ('File', 'WorkspacePackage')
         ORDER BY start_line ASC, end_line ASC`,
      )
      .all(matchedFile.file_path) as Array<Record<string, unknown>>;

    const filterLower = options?.filter?.trim().toLowerCase();
    const filterTokens = filterLower
      ? filterLower
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .split(/[\s,|]+/)
          .filter(Boolean)
      : [];
    const kindFilterLower = options?.kind?.trim().toLowerCase();
    const exportedOnly = Boolean(options?.exportedOnly);

    const matchedSymbols: FileOutlineSymbol[] = [];
    for (const r of allRows) {
      const kind = String(r.kind) as NodeKind;
      const exported = Number(r.exported) === 1;
      if (!kindFilterLower && filterTokens.length === 0 && kind === 'Property') continue;
      if (kindFilterLower && kind.toLowerCase() !== kindFilterLower) continue;
      if (exportedOnly && !exported) continue;

      const name = String(r.name);
      const qualifiedName = String(r.qualified_name);
      const signature = String(r.signature);
      const docstring = String(r.docstring);

      if (filterTokens.length > 0) {
        const haystack = `${name} ${qualifiedName} ${signature}`.toLowerCase();
        const matchesFilter = filterTokens.some((tok) => haystack.includes(tok));
        if (!matchesFilter) continue;
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

  private mapEdgeRows(rows: Array<Record<string, unknown>>): EdgeSummary[] {
    return rows.map((r) => ({
      srcId: String(r.src_id),
      srcName: String(r.src_name ?? r.src_id),
      srcKind: String(r.src_kind ?? 'Variable') as NodeKind,
      srcFilePath: String(r.src_file ?? r.file_path ?? ''),
      srcLine: Number(r.src_line ?? r.line ?? 0),
      dstId: String(r.dst_id),
      dstName: String(r.dst_name ?? r.dst_id),
      dstKind: String(r.dst_kind ?? 'Variable') as NodeKind,
      dstFilePath: String(r.dst_file ?? ''),
      dstLine: Number(r.dst_line ?? 0),
      edgeKind: String(r.kind) as EdgeKind,
      callSiteFile: String(r.file_path ?? ''),
      callSiteLine: Number(r.line ?? 0),
    }));
  }

  public getSymbolNeighborhood(
    symbolIdOrName: string,
    options?: { limit?: number },
  ): SymbolNeighborhood {
    const t0 = performance.now();
    const limit = Math.max(1, Math.min(200, options?.limit ?? 20));
    const exactMatches = this.resolveTargetSymbols(symbolIdOrName, 10, { exactOnly: true });
    const focal = exactMatches[0] ?? null;

    if (!focal) {
      const suggestions = this.searchSymbols(symbolIdOrName, undefined, Math.min(limit, 15));
      const latencyMs = performance.now() - t0;
      this.recordQueryTelemetry('getSymbolNeighborhood', symbolIdOrName, latencyMs, 0);
      return {
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

    const targetIds = exactMatches.slice(0, 3).map((m) => m.id);
    const placeholders = targetIds.map(() => '?').join(', ');

    const totalCallersCount = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT e.src_id || ':' || e.file_path || ':' || e.line) AS c
           FROM edges e
           JOIN nodes s ON s.id = e.src_id
           WHERE e.dst_id IN (${placeholders})
             AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT')
             AND s.kind NOT IN ('TestCase', 'TestSuite')`,
        )
        .get(...targetIds) as { c: number }
    ).c;

    const incomingRows = this.db
      .prepare(
        `SELECT e.*,
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
         LIMIT ?`,
      )
      .all(...targetIds, limit) as Array<Record<string, unknown>>;

    const totalCalleesCount = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT e.dst_id || ':' || e.file_path || ':' || e.line) AS c
           FROM edges e
           JOIN nodes d ON d.id = e.dst_id
           WHERE e.src_id IN (${placeholders})
             AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT')`,
        )
        .get(...targetIds) as { c: number }
    ).c;

    const outgoingRows = this.db
      .prepare(
        `SELECT e.*,
                s.name AS src_name, s.kind AS src_kind, s.file_path AS src_file, s.start_line AS src_line,
                d.name AS dst_name, d.kind AS dst_kind, d.file_path AS dst_file, d.start_line AS dst_line
         FROM edges e
         JOIN nodes s ON s.id = e.src_id
         JOIN nodes d ON d.id = e.dst_id
         WHERE e.src_id IN (${placeholders})
           AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT')
         GROUP BY e.src_id, e.dst_id, e.file_path, e.line
         ORDER BY e.file_path ASC, e.line ASC
         LIMIT ?`,
      )
      .all(...targetIds, limit) as Array<Record<string, unknown>>;

    const typeRows = this.db
      .prepare(
        `SELECT e.*,
                s.name AS src_name, s.kind AS src_kind, s.file_path AS src_file, s.start_line AS src_line,
                d.name AS dst_name, d.kind AS dst_kind, d.file_path AS dst_file, d.start_line AS dst_line
         FROM edges e
         JOIN nodes s ON s.id = e.src_id
         JOIN nodes d ON d.id = e.dst_id
         WHERE (e.src_id IN (${placeholders}) OR e.dst_id IN (${placeholders}))
           AND e.kind IN ('EXTENDS', 'IMPLEMENTS', 'RETURNS_TYPE', 'HAS_PARAMETER_TYPE')
         GROUP BY e.src_id, e.dst_id, e.kind
         LIMIT ?`,
      )
      .all(...targetIds, ...targetIds, limit) as Array<Record<string, unknown>>;

    const totalCoveringTestsCount = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT s.id) AS c
           FROM edges e
           JOIN nodes s ON s.id = e.src_id
           WHERE e.dst_id IN (${placeholders})
             AND (e.kind IN ('TESTS_SYMBOL', 'TESTS_FILE') OR s.kind IN ('TestCase', 'TestSuite'))`,
        )
        .get(...targetIds) as { c: number }
    ).c;

    const testRows = this.db
      .prepare(
        `SELECT s.id AS test_id, s.name AS test_name, s.kind AS test_kind,
                s.file_path, s.start_line, s.end_line, e.kind AS edge_kind
         FROM edges e
         JOIN nodes s ON s.id = e.src_id
         WHERE e.dst_id IN (${placeholders})
           AND (e.kind IN ('TESTS_SYMBOL', 'TESTS_FILE') OR s.kind IN ('TestCase', 'TestSuite'))
         GROUP BY s.id
         ORDER BY s.file_path ASC, s.start_line ASC
         LIMIT ?`,
      )
      .all(...targetIds, limit) as Array<Record<string, unknown>>;

    const latencyMs = performance.now() - t0;
    this.recordQueryTelemetry(
      'getSymbolNeighborhood',
      symbolIdOrName,
      latencyMs,
      incomingRows.length + outgoingRows.length + testRows.length,
    );

    return {
      symbol: focal,
      matches: exactMatches,
      callers: this.mapEdgeRows(incomingRows),
      callees: this.mapEdgeRows(outgoingRows),
      typeReferences: this.mapEdgeRows(typeRows),
      coveringTests: testRows.map((r) => ({
        testId: String(r.test_id),
        testName: String(r.test_name),
        testKind: String(r.test_kind) as NodeKind,
        filePath: String(r.file_path),
        startLine: Number(r.start_line),
        endLine: Number(r.end_line),
        edgeKind: String(r.edge_kind) as EdgeKind,
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
  public getSymbolReferences(
    symbolIdOrName: string,
    options?: { limit?: number },
  ): SymbolReferencesResult {
    const t0 = performance.now();
    const limit = Math.max(5, Math.min(200, options?.limit ?? 60));
    const matches = this.resolveTargetSymbols(symbolIdOrName, 12, { exactOnly: true });

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
      .prepare(
        `SELECT e.*,
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
           e.file_path ASC, e.line ASC`,
      )
      .all(...targetIds) as Array<Record<string, unknown>>;

    const mapped = allIncoming.map((r) => ({
      srcId: String(r.src_id),
      srcName: String(r.src_name),
      srcKind: String(r.src_kind) as SymbolSummary['kind'],
      srcFilePath: String(r.src_file),
      srcLine: Number(r.src_line),
      srcStartLine: Number(r.src_line),
      srcEndLine: Number(r.src_end_line ?? r.src_line),
      dstId: String(r.dst_id),
      dstName: String(r.dst_name),
      dstKind: String(r.dst_kind) as SymbolSummary['kind'],
      dstFilePath: String(r.dst_file),
      dstLine: Number(r.dst_line),
      edgeKind: String(r.kind) as SymbolReferencesResult['writes'][number]['edgeKind'],
      callSiteFile: String(r.file_path),
      callSiteLine: Number(r.line),
    }));
    const writes = mapped.filter((e) => e.edgeKind === 'WRITES_PROPERTY');
    const reads = mapped.filter((e) => e.edgeKind === 'READS_PROPERTY');
    const references = mapped.filter(
      (e) => e.edgeKind !== 'WRITES_PROPERTY' && e.edgeKind !== 'READS_PROPERTY',
    );

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

  public getBlastRadius(target: string, maxHops = 3): BlastRadiusResult {
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
    const seedIds = new Set<string>();
    for (const sym of resolvedSymbols) {
      seedIds.add(sym.id);
      if (sym.kind === 'File') {
        const fileSyms = this.db
          .prepare("SELECT id FROM nodes WHERE file_path = ? AND kind != 'File'")
          .all(sym.filePath) as Array<{ id: string }>;
        for (const fsym of fileSyms) {
          seedIds.add(fsym.id);
        }
      }
    }

    const seedList = [...seedIds].slice(0, 25);
    const placeholders = seedList.map(() => '?').join(', ');

    // Upstream recursive CTE over idx_edges_reverse(dst_id, kind, src_id)
    const cteRows = this.db
      .prepare(
        `WITH RECURSIVE upstream(node_id, from_id, edge_kind, hop) AS (
           SELECT e.src_id, e.dst_id, e.kind, 1
           FROM edges e
           WHERE e.dst_id IN (${placeholders})
             AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT', 'TESTS_SYMBOL', 'TESTS_FILE')
           UNION
           SELECT e.src_id, u.node_id, e.kind, u.hop + 1
           FROM upstream u
           JOIN edges e ON e.dst_id = u.node_id
           WHERE u.hop < ?
             AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'VALIDATES_SCHEMA', 'HANDLES_ROUTE', 'CONNECTS_ENDPOINT', 'TESTS_SYMBOL', 'TESTS_FILE')
         )
         SELECT
           n.id, n.name, n.qualified_name, n.kind, n.package_name, n.file_path, n.start_line, n.end_line,
           MIN(u.hop) AS hop_distance,
           u.edge_kind AS via_edge_kind,
           u.from_id AS from_symbol_id
         FROM upstream u
         JOIN nodes n ON n.id = u.node_id
         WHERE n.id NOT IN (${placeholders})
           AND n.kind != 'WorkspacePackage'
         GROUP BY n.id
         ORDER BY hop_distance ASC, n.package_name ASC, n.file_path ASC, n.start_line ASC
         LIMIT 250`,
      )
      .all(...seedList, maxHops, ...seedList) as Array<Record<string, unknown>>;

    const impactedNodes: BlastRadiusNode[] = cteRows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      qualifiedName: String(r.qualified_name),
      kind: String(r.kind) as NodeKind,
      packageName: String(r.package_name),
      filePath: String(r.file_path),
      startLine: Number(r.start_line),
      endLine: Number(r.end_line),
      hopDistance: Number(r.hop_distance),
      viaEdgeKind: String(r.via_edge_kind) as EdgeKind,
      fromSymbolId: String(r.from_symbol_id),
    }));

    const impactedByHop: Record<number, BlastRadiusNode[]> = {};
    const pkgSet = new Set<string>(resolvedSymbols.map((s) => s.packageName));
    const fileMap = new Map<
      string,
      { filePath: string; packageName: string; symbolCount: number; minLine: number; maxLine: number }
    >();

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
      impactedByHop[node.hopDistance]!.push(node);
      if (node.packageName) pkgSet.add(node.packageName);

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
        } else {
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
      .prepare(
        `SELECT DISTINCT t.id, t.name, t.kind, t.file_path, t.package_name, t.start_line, t.end_line
         FROM edges e
         JOIN nodes t ON t.id = e.src_id
         WHERE e.dst_id IN (${testPlaceholders})
           AND t.kind IN ('TestCase', 'TestSuite')
         ORDER BY t.file_path ASC, t.start_line ASC`,
      )
      .all(...allIdsForTests) as Array<Record<string, unknown>>;

    // Also include any TestCase/TestSuite already in impactedNodes
    const testSuitesByFile = new Map<
      string,
      {
        testFilePath: string;
        packageName: string;
        testCases: Array<{ id: string; name: string; kind: NodeKind; startLine: number; endLine: number }>;
      }
    >();

    const addTestRow = (
      id: string,
      name: string,
      kind: NodeKind,
      filePath: string,
      packageName: string,
      startLine: number,
      endLine: number,
    ) => {
      if (!filePath) return;
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
      addTestRow(
        String(r.id),
        String(r.name),
        String(r.kind) as NodeKind,
        String(r.file_path),
        String(r.package_name),
        Number(r.start_line),
        Number(r.end_line),
      );
    }
    for (const n of impactedNodes) {
      if (n.kind === 'TestCase' || n.kind === 'TestSuite' || n.filePath.endsWith('.test.ts')) {
        addTestRow(n.id, n.name, n.kind, n.filePath, n.packageName, n.startLine, n.endLine);
      }
    }

    const recommendedTests = [...testSuitesByFile.values()];
    const testFilePaths = recommendedTests.map((t) => t.testFilePath);
    const vitestCommand =
      testFilePaths.length > 0 ? `npx vitest run ${testFilePaths.join(' ')}` : 'npx vitest run';

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

  public getTestsForChange(target: string): TestsForChangeResult {
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
        vitestCommand: 'npx vitest run',
        latencyMs,
      };
    }

    const seedIds = new Set<string>();
    for (const sym of resolvedSymbols) {
      seedIds.add(sym.id);
      if (sym.kind === 'File') {
        const fileSyms = this.db
          .prepare('SELECT id FROM nodes WHERE file_path = ?')
          .all(sym.filePath) as Array<{ id: string }>;
        for (const s of fileSyms) seedIds.add(s.id);
      }
    }
    const seedList = [...seedIds].slice(0, 30);
    const placeholders = seedList.map(() => '?').join(', ');

    const directRows = this.db
      .prepare(
        `SELECT t.id, t.name, t.kind, t.file_path, t.package_name, t.start_line, t.end_line,
                d.name AS target_symbol_name, e.kind AS edge_kind
         FROM edges e
         JOIN nodes t ON t.id = e.src_id
         JOIN nodes d ON d.id = e.dst_id
         WHERE e.dst_id IN (${placeholders})
           AND (e.kind IN ('TESTS_SYMBOL', 'TESTS_FILE') OR t.kind IN ('TestCase', 'TestSuite'))
         ORDER BY t.file_path ASC, t.start_line ASC`,
      )
      .all(...seedList) as Array<Record<string, unknown>>;

    const directIds = new Set<string>(directRows.map((r) => String(r.id)));

    // Transitive tests via 2-3 hop blast radius
    const blast = this.getBlastRadius(target, 3);
    const transitiveTests: TestsForChangeResult['transitiveTests'] = [];
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

    const directTests = directRows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      kind: String(r.kind) as NodeKind,
      filePath: String(r.file_path),
      packageName: String(r.package_name),
      startLine: Number(r.start_line),
      endLine: Number(r.end_line),
      targetSymbolName: String(r.target_symbol_name),
      edgeKind: String(r.edge_kind) as EdgeKind,
    }));

    const testFiles = [
      ...new Set([
        ...directTests.map((d) => d.filePath),
        ...transitiveTests.map((t) => t.filePath),
      ]),
    ];
    const vitestCommand = testFiles.length > 0 ? `npx vitest run ${testFiles.join(' ')}` : 'npx vitest run';

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

  public getCrossLayerLineage(target: string): LineageResult {
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

    const edgeQuery = (whereClause: string, params: unknown[]) =>
      this.mapEdgeRows(
        this.db
          .prepare(
            `SELECT e.*,
                    s.name AS src_name, s.kind AS src_kind, s.file_path AS src_file, s.start_line AS src_line,
                    d.name AS dst_name, d.kind AS dst_kind, d.file_path AS dst_file, d.start_line AS dst_line
             FROM edges e
             JOIN nodes s ON s.id = e.src_id
             JOIN nodes d ON d.id = e.dst_id
             WHERE ${whereClause}
             ORDER BY e.file_path ASC, e.line ASC
             LIMIT 100`,
          )
          .all(...(params as Array<string | number>)) as Array<Record<string, unknown>>,
      );

    const validators = edgeQuery(
      `(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind = 'VALIDATES_SCHEMA'`,
      [...ids, ...ids],
    );
    const emitters = edgeQuery(
      `(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind = 'EMITS_SCHEMA'`,
      [...ids, ...ids],
    );
    const routesHandled = edgeQuery(
      `(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind = 'HANDLES_ROUTE'`,
      [...ids, ...ids],
    );
    const endpointClients = edgeQuery(
      `(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind = 'CONNECTS_ENDPOINT'`,
      [...ids, ...ids],
    );
    const infraProvisions = edgeQuery(
      `(e.dst_id IN (${placeholders}) OR e.src_id IN (${placeholders})) AND e.kind IN ('PROVISIONS_SERVICE', 'REFERENCES_TF_RESOURCE', 'CONFIGURES_ENV')`,
      [...ids, ...ids],
    );
    const downstreamConsumers = edgeQuery(
      `e.dst_id IN (${placeholders}) AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS') AND s.kind NOT IN ('TestCase', 'TestSuite')`,
      ids,
    );
    const upstreamProviders = edgeQuery(
      `e.src_id IN (${placeholders}) AND e.kind IN ('CALLS', 'REFERENCES', 'READS_PROPERTY', 'WRITES_PROPERTY', 'IMPORTS')`,
      ids,
    );

    const latencyMs = performance.now() - t0;
    this.recordQueryTelemetry(
      'getCrossLayerLineage',
      target,
      latencyMs,
      validators.length + routesHandled.length + endpointClients.length + downstreamConsumers.length,
    );

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

  public findShortestPath(fromTarget: string, toTarget: string, maxHops = 6): ShortestPathResult {
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

    const startIds = new Set<string>(fromNodes.map((n) => n.id));
    for (const fn of fromNodes) {
      if (fn.kind === 'File') {
        const syms = this.db
          .prepare('SELECT id FROM nodes WHERE file_path = ?')
          .all(fn.filePath) as Array<{ id: string }>;
        for (const s of syms) startIds.add(s.id);
      }
    }

    const goalIds = new Set<string>(toNodes.map((n) => n.id));
    for (const tn of toNodes) {
      if (tn.kind === 'File') {
        const syms = this.db
          .prepare('SELECT id FROM nodes WHERE file_path = ?')
          .all(tn.filePath) as Array<{ id: string }>;
        for (const s of syms) goalIds.add(s.id);
      }
    }

    // BFS over directed + file-level edges in SQLite
    interface QueueEntry {
      nodeId: string;
      steps: Array<{
        fromId: string;
        toId: string;
        edgeKind: EdgeKind;
        line: number;
      }>;
    }

    const visited = new Set<string>(startIds);
    const queue: QueueEntry[] = [...startIds].map((id) => ({ nodeId: id, steps: [] }));

    const outEdgesStmt = this.db.prepare(
      `SELECT src_id, dst_id, kind, line
       FROM edges
       WHERE src_id = ?
         AND kind != 'CONTAINS'`,
    );
    const inEdgesStmt = this.db.prepare(
      `SELECT src_id, dst_id, kind, line
       FROM edges
       WHERE dst_id = ?
         AND kind != 'CONTAINS'`,
    );

    let matchedSteps: QueueEntry['steps'] | null = null;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (goalIds.has(current.nodeId) && current.steps.length > 0) {
        matchedSteps = current.steps;
        break;
      }
      if (current.steps.length >= maxHops) continue;

      const forwardRows = outEdgesStmt.all(current.nodeId) as Array<{
        src_id: string;
        dst_id: string;
        kind: string;
        line: number;
      }>;

      for (const e of forwardRows) {
        if (!visited.has(e.dst_id)) {
          visited.add(e.dst_id);
          const nextSteps = [
            ...current.steps,
            {
              fromId: e.src_id,
              toId: e.dst_id,
              edgeKind: e.kind as EdgeKind,
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
      if (matchedSteps) break;

      // Also allow traversing reverse dependency edges if no forward path alone connects them
      const reverseRows = inEdgesStmt.all(current.nodeId) as Array<{
        src_id: string;
        dst_id: string;
        kind: string;
        line: number;
      }>;
      for (const e of reverseRows) {
        if (!visited.has(e.src_id)) {
          visited.add(e.src_id);
          const nextSteps = [
            ...current.steps,
            {
              fromId: e.src_id,
              toId: e.dst_id,
              edgeKind: e.kind as EdgeKind,
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
      if (matchedSteps) break;
    }

    const nodeLookup = this.db.prepare('SELECT id, name, file_path FROM nodes WHERE id = ?');
    const pathSteps: ShortestPathStep[] = (matchedSteps ?? []).map((st) => {
      const fromRow = nodeLookup.get(st.fromId) as { id: string; name: string; file_path: string } | undefined;
      const toRow = nodeLookup.get(st.toId) as { id: string; name: string; file_path: string } | undefined;
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

  public exportGraph(outputDir: string): {
    cypherPath: string;
    jsonlPath: string;
    nodesExported: number;
    edgesExported: number;
  } {
    const resolvedDir = path.resolve(outputDir);
    fs.mkdirSync(resolvedDir, { recursive: true });
    const cypherPath = path.join(resolvedDir, 'export.cypher');
    const jsonlPath = path.join(resolvedDir, 'snapshot.jsonl');

    const nodes = this.db.prepare('SELECT * FROM nodes ORDER BY id ASC').all() as Array<Record<string, unknown>>;
    const edges = this.db
      .prepare('SELECT * FROM edges ORDER BY src_id ASC, kind ASC, dst_id ASC')
      .all() as Array<Record<string, unknown>>;

    const escapeCypher = (val: string): string =>
      val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');

    const cypherLines: string[] = [
      '// Auto-generated openCypher Labeled Property Graph export from @warehouse/ast-sidecar',
      `// Generated at: ${new Date().toISOString()}`,
    ];
    const jsonlLines: string[] = [];

    for (const n of nodes) {
      const mapped = this.mapNodeRow(n);
      const safeLabel = mapped.kind.replace(/[^A-Za-z0-9_]/g, '_') || 'AstNode';
      cypherLines.push(
        `MERGE (n:${safeLabel} {id: "${escapeCypher(mapped.id)}"}) SET n.name = "${escapeCypher(
          mapped.name,
        )}", n.qualifiedName = "${escapeCypher(mapped.qualifiedName)}", n.packageName = "${escapeCypher(
          mapped.packageName,
        )}", n.filePath = "${escapeCypher(mapped.filePath)}", n.startLine = ${mapped.startLine}, n.endLine = ${
          mapped.endLine
        }, n.complexity = ${mapped.complexity}, n.exported = ${mapped.exported};`,
      );
      jsonlLines.push(
        JSON.stringify({
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
        }),
      );
    }

    for (const e of edges) {
      const srcId = String(e.src_id);
      const dstId = String(e.dst_id);
      const kind = String(e.kind).replace(/[^A-Za-z0-9_]/g, '_') || 'RELATES_TO';
      const filePath = String(e.file_path);
      const line = Number(e.line);
      cypherLines.push(
        `MATCH (a {id: "${escapeCypher(srcId)}"}), (b {id: "${escapeCypher(
          dstId,
        )}"}) MERGE (a)-[r:${kind} {filePath: "${escapeCypher(filePath)}", line: ${line}}]->(b);`,
      );
      jsonlLines.push(
        JSON.stringify({
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
        }),
      );
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
