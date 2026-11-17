import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AstGraphDatabase, AstGraphIndexer } from '../src/index.js';
import { activeLockOwner, syncLockPath, tryAcquireSyncLock } from '../src/sync-lock.js';

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

function makeTempRepo(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ast-graph-${name}-`)));
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
  tempDirs.push(dir);
  return dir;
}

/** A real, live foreign process to own the lock (no fake PIDs). */
function liveForeignPid(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

/** PID of a process that has already exited. */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number(res.stdout);
}

function writeLock(dbPath: string, pid: number, ageMs: number): void {
  const ts = Date.now() - ageMs;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(
    syncLockPath(dbPath),
    JSON.stringify({ pid, host: os.hostname(), startedAt: ts, heartbeatAt: ts }),
  );
}

afterEach(() => {
  while (children.length > 0) children.pop()!.kill('SIGKILL');
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('cross-process sync lock', () => {
  it('serves the committed index while another live process syncs, even past the old 15s window', () => {
    const repo = makeTempRepo('lock-live');
    const dbPath = path.join(repo, '.ast-graph', 'ast.db');
    const db = new AstGraphDatabase(dbPath);
    try {
      const indexer = new AstGraphIndexer(repo, db);
      indexer.syncWorkspace({ full: true });
      expect(db.resolveTargetSymbols('alpha', 5, { exactOnly: true })).toHaveLength(1);

      const owner = liveForeignPid();
      writeLock(dbPath, owner, 60_000); // a 60s-old lock from a live long-running cold sync
      fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export function beta(): number { return 2; }\n');

      const lazy = indexer.lazySyncIfDirty();
      expect(lazy.lockedBy?.pid).toBe(owner);
      const forced = indexer.syncWorkspace({ full: true, force: true });
      expect(forced.lockedBy?.pid).toBe(owner);
      // Last committed index is still served; the foreign lock was not stolen.
      expect(db.resolveTargetSymbols('alpha', 5, { exactOnly: true })).toHaveLength(1);
      expect(activeLockOwner(syncLockPath(dbPath))?.pid).toBe(owner);
    } finally {
      db.close();
    }
  });

  it('refuses a concurrent cold build with INDEX_BUILDING instead of double-indexing', () => {
    const repo = makeTempRepo('lock-cold');
    const dbPath = path.join(repo, '.ast-graph', 'ast.db');
    const db = new AstGraphDatabase(dbPath);
    try {
      writeLock(dbPath, liveForeignPid(), 0);
      const indexer = new AstGraphIndexer(repo, db);
      expect(() => indexer.lazySyncIfDirty()).toThrow(/INDEX_BUILDING/);
      expect(db.getTrackedFilesMap().size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('takes over orphaned locks from dead processes and legacy pid:timestamp locks', () => {
    const repo = makeTempRepo('lock-dead');
    const dbPath = path.join(repo, '.ast-graph', 'ast.db');
    const db = new AstGraphDatabase(dbPath);
    try {
      writeLock(dbPath, deadPid(), 0);
      const indexer = new AstGraphIndexer(repo, db);
      const res = indexer.syncWorkspace({ full: true });
      expect(res.mode).toBe('full');
      expect(res.lockedBy).toBeUndefined();
      expect(fs.existsSync(syncLockPath(dbPath))).toBe(false);

      fs.writeFileSync(syncLockPath(dbPath), `${deadPid()}:${Date.now()}`);
      expect(activeLockOwner(syncLockPath(dbPath))).toBeNull();
      const handle = tryAcquireSyncLock(dbPath);
      expect(handle).not.toBeNull();
      handle!.release();
    } finally {
      db.close();
    }
  });

  it('treats a live owner that stopped heartbeating as hung', () => {
    const repo = makeTempRepo('lock-hung');
    const dbPath = path.join(repo, '.ast-graph', 'ast.db');
    writeLock(dbPath, liveForeignPid(), 5_000);
    expect(tryAcquireSyncLock(dbPath, { hungAfterMs: 60_000 })).toBeNull();
    const handle = tryAcquireSyncLock(dbPath, { hungAfterMs: 1_000 });
    expect(handle).not.toBeNull();
    handle!.release();
  });

  it('checkpoints and truncates the WAL after sync and skips snapshot exports by default', () => {
    const repo = makeTempRepo('lock-wal');
    const dbPath = path.join(repo, '.ast-graph', 'ast.db');
    const db = new AstGraphDatabase(dbPath);
    try {
      new AstGraphIndexer(repo, db).syncWorkspace({ full: true });
      const walPath = `${dbPath}-wal`;
      const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      expect(walSize).toBe(0);
      expect(fs.existsSync(path.join(repo, '.ast-graph', 'snapshot.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(repo, '.ast-graph', 'export.cypher'))).toBe(false);
    } finally {
      db.close();
    }
  });
});
