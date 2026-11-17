import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AstGraphDatabase, AstGraphIndexer } from '../src/index.js';
import { clearRepoBoundaryCache, isPathInExcludedSubtree } from '../src/repo-boundary.js';

const tempDirs: string[] = [];

function makeTempRepo(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ast-graph-${name}-`)));
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

afterEach(() => {
  clearRepoBoundaryCache();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('repo boundaries, stale bindings, and repo-scoped aliases', () => {
  it('never indexes nested worktrees, submodules, or vendored clones', () => {
    const repo = makeTempRepo('worktrees');
    write(repo, 'package.json', JSON.stringify({ name: 'host' }));
    write(repo, 'src/main.ts', 'export function hostOnly(): number { return 1; }\n');
    // git worktree: `.git` is a file
    write(repo, '.worktrees/feature/.git', 'gitdir: ../../.git/worktrees/feature\n');
    write(repo, '.worktrees/feature/src/main.ts', 'export function hostOnly(): number { return 2; }\n');
    // nested clone outside `.worktrees`: `.git` is a directory
    fs.mkdirSync(path.join(repo, 'vendor-clone', '.git'), { recursive: true });
    write(repo, 'vendor-clone/lib.go', 'package lib\n\nfunc Cloned() int { return 1 }\n');
    write(repo, 'vendor-clone/app.py', 'def cloned_py():\n    return 1\n');

    const db = new AstGraphDatabase(path.join(repo, '.ast-graph', 'ast.db'));
    try {
      const indexer = new AstGraphIndexer(repo, db);
      indexer.syncWorkspace({ full: true });
      const files = [...db.getTrackedFilesMap().keys()];
      expect(files).toContain('src/main.ts');
      expect(files.filter((f) => f.startsWith('.worktrees/') || f.startsWith('vendor-clone/'))).toEqual([]);
      expect(db.resolveTargetSymbols('hostOnly', 10, { exactOnly: true }).map((s) => s.filePath)).toEqual([
        'src/main.ts',
      ]);

      // Explicit hook targets inside a nested checkout are ignored as well.
      indexer.syncWorkspace({ targetPaths: ['.worktrees/feature/src/main.ts'], force: true });
      expect([...db.getTrackedFilesMap().keys()].some((f) => f.startsWith('.worktrees/'))).toBe(false);
      expect(isPathInExcludedSubtree(path.join(repo, 'vendor-clone', 'lib.go'), repo)).toBe(true);
      expect(isPathInExcludedSubtree(path.join(repo, 'src', 'main.ts'), repo)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('rebinds a moved/renamed checkout index instead of throwing TAMPER_GUARD', () => {
    const repo = makeTempRepo('renamed');
    write(repo, 'package.json', JSON.stringify({ name: 'renamed' }));
    write(repo, 'src/a.ts', 'export const alpha = 1;\n');
    const dbPath = path.join(repo, '.ast-graph', 'ast.db');

    const first = new AstGraphDatabase(dbPath);
    new AstGraphIndexer(repo, first).syncWorkspace({ full: true });
    first.close();

    // Simulate the worktree having been created under a different name.
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'canonical_root'").run('/old/path/electric-sheep');
    raw.prepare("UPDATE meta SET value = 'ab78cd30204c2879' WHERE key = 'repo_id'").run();
    raw.close();

    const reopened = new AstGraphDatabase(dbPath);
    try {
      const indexer = new AstGraphIndexer(repo, reopened); // previously threw TAMPER_GUARD
      expect(reopened.getMeta('canonical_root')).toBe(repo);
      expect(reopened.schemaRebuilt?.reason).toMatch(/rebound/);
      expect(reopened.getTrackedFilesMap().size).toBe(0);
      indexer.lazySyncIfDirty();
      expect(reopened.resolveTargetSymbols('alpha', 5, { exactOnly: true }).length).toBeGreaterThan(0);
    } finally {
      reopened.close();
    }
  });

  it('still refuses a database that lives in a different repository', () => {
    const repoA = makeTempRepo('own-a');
    const repoB = makeTempRepo('own-b');
    const db = new AstGraphDatabase(path.join(repoA, '.ast-graph', 'ast.db'), repoA);
    try {
      expect(() => db.verifyRepoBinding(repoB)).toThrow(/TAMPER_GUARD/);
      // A sibling whose name shares a prefix must not pass the containment check.
      expect(() => db.verifyRepoBinding(`${repoA}-other`)).toThrow(/TAMPER_GUARD/);
    } finally {
      db.close();
    }
  });

  it('has no built-in repo-specific aliases; repo config aliases only produce labelled suggestions', () => {
    const repo = makeTempRepo('aliases');
    write(repo, 'package.json', JSON.stringify({ name: 'aliases' }));
    write(repo, 'src/output.ts', 'export function sanitiseOutputText(raw: string): string { return raw; }\n');
    const db = new AstGraphDatabase(path.join(repo, '.ast-graph', 'ast.db'));
    try {
      new AstGraphIndexer(repo, db).syncWorkspace({ full: true });

      // Without config, the old hardcoded warehouse alias must not resolve.
      expect(db.resolveTargetSymbols('sanitizeDirective', 5)).not.toContainEqual(
        expect.objectContaining({ name: 'sanitiseOutputText' }),
      );

      write(repo, 'ast-graph.config.json', JSON.stringify({ aliases: { sanitizeDirective: ['sanitiseOutputText'] } }));
      expect(db.resolveTargetSymbols('sanitizeDirective', 5).map((s) => s.name)).toContain('sanitiseOutputText');
      // Exact lookups (ast_symbol) never treat an alias as the target...
      expect(db.resolveTargetSymbols('sanitizeDirective', 5, { exactOnly: true })).toEqual([]);
      const hood = db.getSymbolNeighborhood('sanitizeDirective');
      expect(hood.symbol).toBeNull();
      // ...but the alias is offered as a suggestion.
      expect(hood.matches.map((s) => s.name)).toContain('sanitiseOutputText');
    } finally {
      db.close();
    }
  });
});
