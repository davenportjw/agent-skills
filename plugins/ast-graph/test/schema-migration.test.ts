import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeGraph } from '../src/analyzer.js';
import { AstGraphDatabase } from '../src/db.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

const tempDirs: string[] = [];
function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-graph-schema-'));
  tempDirs.push(dir);
  return path.join(dir, 'ast.db');
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function userVersion(dbPath: string): number {
  const raw = new DatabaseSync(dbPath);
  const v = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  raw.close();
  return v;
}

describe('schema versioning', () => {
  it('stamps a fresh database with SCHEMA_VERSION and does not flag a rebuild', () => {
    const dbPath = tempDb();
    const db = new AstGraphDatabase(dbPath);
    expect(db.schemaRebuilt).toBeNull();
    expect(db.getMeta('schema_version')).toBe(String(AstGraphDatabase.SCHEMA_VERSION));
    db.close();
    expect(userVersion(dbPath)).toBe(AstGraphDatabase.SCHEMA_VERSION);
  });

  it('reopening a current database is a no-op that preserves indexed rows', () => {
    const dbPath = tempDb();
    const first = new AstGraphDatabase(dbPath);
    first.db
      .prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('src/a.ts', 'pkg', 'typescript', 'abc', 1, 10, 1, 'now');
    first.close();
    const second = new AstGraphDatabase(dbPath);
    expect(second.schemaRebuilt).toBeNull();
    expect(second.getTrackedFilesMap().size).toBe(1);
    second.close();
  });

  it('drops a legacy fork layout (labels_json column) and keeps repo binding meta', () => {
    const dbPath = tempDb();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('repo_id', 'legacy-repo');
      CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, labels_json TEXT);
      INSERT INTO nodes VALUES ('n1', 'Function', 'old', '[]');
      CREATE TABLE files (file_path TEXT PRIMARY KEY);
      INSERT INTO files VALUES ('src/old.ts');
    `);
    raw.close();

    const db = new AstGraphDatabase(dbPath);
    expect(db.schemaRebuilt?.fromVersion).toBe(0);
    expect(db.schemaRebuilt?.reason).toMatch(/full re-sync required/);
    expect(db.getTrackedFilesMap().size).toBe(0);
    expect(db.getMeta('repo_id')).toBe('legacy-repo');
    const cols = (db.db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('properties_json');
    expect(cols).not.toContain('labels_json');
    db.close();
    expect(userVersion(dbPath)).toBe(AstGraphDatabase.SCHEMA_VERSION);
  });

  it('refuses a database written by a newer schema with an actionable error', () => {
    const dbPath = tempDb();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`PRAGMA user_version = ${AstGraphDatabase.SCHEMA_VERSION + 1};`);
    raw.close();
    expect(() => new AstGraphDatabase(dbPath)).toThrow(/SCHEMA_TOO_NEW/);
  });

  it('upgrades a v3 string-keyed edges table to v4 compact edge_rows + edges view and reclaims space', () => {
    const dbPath = tempDb();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      PRAGMA user_version = 3;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('repo_id', 'v3-repo');
      CREATE TABLE files (file_path TEXT PRIMARY KEY);
      CREATE TABLE nodes (id TEXT PRIMARY KEY);
      CREATE TABLE edges (
        src_id TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        col INTEGER NOT NULL,
        weight REAL NOT NULL,
        properties_json TEXT NOT NULL,
        PRIMARY KEY (src_id, dst_id, kind, file_path, line)
      );
    `);
    const ins = raw.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 400; i++) {
      ins.run(
        `scip-ts npm @demo/pkg 1.0.0 src/very/long/path/module_${i}.ts/fn_${i}().`,
        `scip-ts npm @demo/pkg 1.0.0 src/very/long/path/target_${i}.ts/prop_${i}.`,
        'REFERENCES',
        `src/very/long/path/module_${i}.ts`,
        i + 1,
        1,
        1.0,
        '{}',
      );
    }
    raw.close();
    const v3Bytes = fs.statSync(dbPath).size;

    const db = new AstGraphDatabase(dbPath);
    expect(db.schemaRebuilt?.fromVersion).toBe(3);
    expect(db.getMeta('repo_id')).toBe('v3-repo');
    const objTypes = new Map(
      (
        db.db
          .prepare("SELECT name, type FROM sqlite_master WHERE name IN ('edges', 'edge_rows', 'symbol_ids', 'file_ids', 'edge_kinds')")
          .all() as Array<{ name: string; type: string }>
      ).map((r) => [r.name, r.type]),
    );
    expect(objTypes.get('edges')).toBe('view');
    expect(objTypes.get('edge_rows')).toBe('table');
    expect(objTypes.get('symbol_ids')).toBe('table');
    expect(objTypes.get('file_ids')).toBe('table');
    expect(objTypes.get('edge_kinds')).toBe('table');
    db.close();
    // Upgrading and vacuuming should reclaim legacy v3 pages immediately.
    expect(fs.statSync(dbPath).size).toBeLessThan(v3Bytes);
  });

  it('stores edges compactly in edge_rows, exposes them via edges view, and prunes orphaned intern entries on compact', () => {
    const dbPath = tempDb();
    const db = new AstGraphDatabase(dbPath);
    db.applyBatch({
      files: [
        {
          filePath: 'src/a.ts',
          packageName: 'pkg',
          language: 'typescript',
          sha256: 'h1',
          mtimeMs: 1,
          sizeBytes: 100,
          lineCount: 10,
        },
      ],
      nodes: [
        {
          id: 'sym:a',
          kind: 'Function',
          labels: ['Function'],
          name: 'a',
          qualifiedName: 'a',
          packageName: 'pkg',
          filePath: 'src/a.ts',
          language: 'typescript',
          startLine: 1,
          startCol: 1,
          endLine: 5,
          endCol: 1,
          signature: 'function a()',
          docstring: '',
          exported: true,
          complexity: 1,
          properties: {},
        },
        {
          id: 'sym:b',
          kind: 'Function',
          labels: ['Function'],
          name: 'b',
          qualifiedName: 'b',
          packageName: 'pkg',
          filePath: 'src/a.ts',
          language: 'typescript',
          startLine: 6,
          startCol: 1,
          endLine: 10,
          endCol: 1,
          signature: 'function b()',
          docstring: '',
          exported: true,
          complexity: 1,
          properties: {},
        },
      ],
      edges: [
        {
          srcId: 'sym:a',
          dstId: 'sym:b',
          kind: 'CALLS',
          filePath: 'src/a.ts',
          line: 2,
          col: 3,
          weight: 1.0,
          properties: {},
        },
        {
          srcId: 'sym:a',
          dstId: 'ext:console.log',
          kind: 'REFERENCES',
          filePath: 'src/a.ts',
          line: 3,
          col: 3,
          weight: 1.0,
          properties: { via: 'member' },
        },
      ],
      diagnostics: [],
    });

    expect(db.getCounts().edges).toBe(2);
    const viewRows = db.db
      .prepare('SELECT src_id, dst_id, kind, file_path, properties_json FROM edges ORDER BY line ASC')
      .all() as Array<Record<string, unknown>>;
    expect(viewRows).toEqual([
      { src_id: 'sym:a', dst_id: 'sym:b', kind: 'CALLS', file_path: 'src/a.ts', properties_json: '{}' },
      { src_id: 'sym:a', dst_id: 'ext:console.log', kind: 'REFERENCES', file_path: 'src/a.ts', properties_json: '{"via":"member"}' },
    ]);

    // Remove the file and force compact -> orphaned symbol_ids & file_ids should be pruned
    expect(db.removeDeletedFiles(new Set())).toBe(1);
    expect(db.getCounts().edges).toBe(0);
    expect(db.compactIfNeeded({ force: true })).toBe(true);
    const symCount = (db.db.prepare('SELECT COUNT(*) AS c FROM symbol_ids').get() as { c: number }).c;
    const fileIdCount = (db.db.prepare('SELECT COUNT(*) AS c FROM file_ids').get() as { c: number }).c;
    expect(symCount).toBe(0);
    expect(fileIdCount).toBe(0);
    db.close();
  });

  it('reopening a v4 database preserves edges/intern tables without rebuilding, and analyzeGraph counts edgesByKind accurately', () => {
    const dbPath = tempDb();
    const first = new AstGraphDatabase(dbPath);
    first.applyBatch({
      files: [
        { filePath: 'src/x.ts', packageName: 'pkg', language: 'typescript', sha256: 'hx', mtimeMs: 1, sizeBytes: 50, lineCount: 5 },
      ],
      nodes: [
        {
          id: 'sym:x1', kind: 'Function', labels: ['Function'], name: 'x1', qualifiedName: 'x1', packageName: 'pkg',
          filePath: 'src/x.ts', language: 'typescript', startLine: 1, startCol: 1, endLine: 2, endCol: 1,
          signature: 'function x1()', docstring: '', exported: true, complexity: 1, properties: {},
        },
        {
          id: 'sym:x2', kind: 'Function', labels: ['Function'], name: 'x2', qualifiedName: 'x2', packageName: 'pkg',
          filePath: 'src/x.ts', language: 'typescript', startLine: 3, startCol: 1, endLine: 5, endCol: 1,
          signature: 'function x2()', docstring: '', exported: true, complexity: 1, properties: {},
        },
      ],
      edges: [
        { srcId: 'sym:x1', dstId: 'sym:x2', kind: 'CALLS', filePath: 'src/x.ts', line: 2, col: 1, weight: 1, properties: {} },
        { srcId: 'sym:x1', dstId: 'sym:x2', kind: 'REFERENCES', filePath: 'src/x.ts', line: 2, col: 5, weight: 1, properties: {} },
      ],
      diagnostics: [],
    });
    first.close();

    const reopened = new AstGraphDatabase(dbPath);
    expect(reopened.schemaRebuilt).toBeNull();
    expect(reopened.getCounts().edges).toBe(2);
    const analysis = analyzeGraph(reopened);
    expect(analysis.edgesByKind).toEqual({ CALLS: 1, REFERENCES: 1 });
    reopened.close();
  });

  it('seedFromParentDatabase clears stale child intern IDs and excludes nested .worktrees edges', () => {
    const parentPath = tempDb();
    const childPath = tempDb();
    const childRoot = path.dirname(childPath);

    // Parent has A -> B (CALLS in src/a.ts) plus a stale nested .worktrees edge that must be excluded.
    const parent = new AstGraphDatabase(parentPath);
    parent.applyBatch({
      files: [
        { filePath: 'src/a.ts', packageName: 'pkg', language: 'typescript', sha256: 'ha', mtimeMs: 1, sizeBytes: 50, lineCount: 5 },
        { filePath: '.worktrees/nested/src/w.ts', packageName: 'pkg', language: 'typescript', sha256: 'hw', mtimeMs: 1, sizeBytes: 50, lineCount: 5 },
      ],
      nodes: [
        {
          id: 'sym:A', kind: 'Function', labels: ['Function'], name: 'A', qualifiedName: 'A', packageName: 'pkg',
          filePath: 'src/a.ts', language: 'typescript', startLine: 1, startCol: 1, endLine: 2, endCol: 1,
          signature: 'function A()', docstring: '', exported: true, complexity: 1, properties: {},
        },
        {
          id: 'sym:B', kind: 'Function', labels: ['Function'], name: 'B', qualifiedName: 'B', packageName: 'pkg',
          filePath: 'src/a.ts', language: 'typescript', startLine: 3, startCol: 1, endLine: 5, endCol: 1,
          signature: 'function B()', docstring: '', exported: true, complexity: 1, properties: {},
        },
        {
          id: 'sym:W', kind: 'Function', labels: ['Function'], name: 'W', qualifiedName: 'W', packageName: 'pkg',
          filePath: '.worktrees/nested/src/w.ts', language: 'typescript', startLine: 1, startCol: 1, endLine: 2, endCol: 1,
          signature: 'function W()', docstring: '', exported: true, complexity: 1, properties: {},
        },
      ],
      edges: [
        { srcId: 'sym:A', dstId: 'sym:B', kind: 'CALLS', filePath: 'src/a.ts', line: 2, col: 1, weight: 1, properties: {} },
        { srcId: 'sym:W', dstId: 'sym:B', kind: 'CALLS', filePath: '.worktrees/nested/src/w.ts', line: 2, col: 1, weight: 1, properties: {} },
      ],
      diagnostics: [],
    });
    parent.close();

    // Child previously indexed completely different symbols/kind/file, then deleted all files (leaving stale intern IDs 1, 2).
    const child = new AstGraphDatabase(childPath);
    child.applyBatch({
      files: [
        { filePath: 'src/z.ts', packageName: 'pkg', language: 'typescript', sha256: 'hz', mtimeMs: 1, sizeBytes: 50, lineCount: 5 },
      ],
      nodes: [
        {
          id: 'sym:Z1', kind: 'Function', labels: ['Function'], name: 'Z1', qualifiedName: 'Z1', packageName: 'pkg',
          filePath: 'src/z.ts', language: 'typescript', startLine: 1, startCol: 1, endLine: 2, endCol: 1,
          signature: 'function Z1()', docstring: '', exported: true, complexity: 1, properties: {},
        },
        {
          id: 'sym:Z2', kind: 'Function', labels: ['Function'], name: 'Z2', qualifiedName: 'Z2', packageName: 'pkg',
          filePath: 'src/z.ts', language: 'typescript', startLine: 3, startCol: 1, endLine: 5, endCol: 1,
          signature: 'function Z2()', docstring: '', exported: true, complexity: 1, properties: {},
        },
      ],
      edges: [
        { srcId: 'sym:Z1', dstId: 'sym:Z2', kind: 'REFERENCES', filePath: 'src/z.ts', line: 2, col: 1, weight: 1, properties: {} },
      ],
      diagnostics: [],
    });
    expect(child.removeDeletedFiles(new Set())).toBe(1);
    expect(child.getCounts().files).toBe(0);
    // Stale intern rows remain before seeding
    expect((child.db.prepare('SELECT COUNT(*) AS c FROM symbol_ids').get() as { c: number }).c).toBeGreaterThan(0);

    expect(child.seedFromParentDatabase(parentPath, childRoot)).toBe(true);
    const seededEdges = child.db
      .prepare('SELECT src_id, dst_id, kind, file_path FROM edges')
      .all() as Array<Record<string, unknown>>;
    expect(seededEdges).toEqual([
      { src_id: 'sym:A', dst_id: 'sym:B', kind: 'CALLS', file_path: 'src/a.ts' },
    ]);
    child.close();
  });
});
