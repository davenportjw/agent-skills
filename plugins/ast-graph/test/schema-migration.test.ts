import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AstGraphDatabase } from '../src/db.js';

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
});
