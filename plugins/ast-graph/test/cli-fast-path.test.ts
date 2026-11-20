import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCliCommand } from '../src/cli.js';
import { syncLockPath } from '../src/sync-lock.js';

const tempDirs: string[] = [];

function makeGitRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'math.ts'),
    [
      'export function addNumbers(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export function multiplyNumbers(a: number, b: number): number {',
      '  return a * b;',
      '}',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'math.test.ts'),
    [
      "import { addNumbers } from './math.js';",
      "describe('math', () => {",
      "  it('adds two numbers', () => {",
      '    expect(addNumbers(1, 2)).toBe(3);',
      '  });',
      '});',
    ].join('\n'),
    'utf8',
  );
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLI fast path, aliases, and batch search', () => {
  it('supports blast/tests aliases, batch search, and lazily re-indexes modified & untracked source files', async () => {
    const repo = makeGitRepo('ast-cli-fast-');

    // Initial sync builds the index and records last_git_head
    const syncRes = await executeCliCommand(['sync', '--workspace', repo]);
    expect(syncRes.exitCode).toBe(0);

    // Clean fast-path outline, batch search, blast alias, and tests alias
    const outlineRes = await executeCliCommand(['outline', 'src/math.ts', '--workspace', repo]);
    expect(outlineRes.exitCode).toBe(0);
    expect(outlineRes.output).toContain('addNumbers');

    const batchSearch = await executeCliCommand([
      'search',
      'addNumbers',
      'multiplyNumbers',
      '--workspace',
      repo,
    ]);
    expect(batchSearch.exitCode).toBe(0);
    expect(batchSearch.output).toContain('[AST BATCH] 2 targets');
    expect(batchSearch.output).toContain('addNumbers');
    expect(batchSearch.output).toContain('multiplyNumbers');

    const blastRes = await executeCliCommand(['blast', 'addNumbers', '--workspace', repo]);
    expect(blastRes.exitCode).toBe(0);
    expect(blastRes.output).toContain('BLAST RADIUS');

    const testsRes = await executeCliCommand(['tests', 'addNumbers', '--workspace', repo]);
    expect(testsRes.exitCode).toBe(0);
    expect(testsRes.output).toContain('math.test.ts');

    // Modifying a tracked file must invalidate the fast path and lazily re-index it
    const futureMs = Date.now() + 5000;
    fs.writeFileSync(
      path.join(repo, 'src', 'math.ts'),
      [
        'export function addNumbers(a: number, b: number): number {',
        '  return a + b;',
        '}',
        'export function divideNumbers(a: number, b: number): number {',
        '  return a / b;',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.utimesSync(path.join(repo, 'src', 'math.ts'), futureMs / 1000, futureMs / 1000);

    const afterEdit = await executeCliCommand(['outline', 'src/math.ts', '--workspace', repo]);
    expect(afterEdit.output).toContain('divideNumbers');

    // Adding a brand-new untracked source file must invalidate the repo-wide fast path
    fs.writeFileSync(
      path.join(repo, 'src', 'extra.ts'),
      'export function brandNewHelper(): string { return "ok"; }\n',
      'utf8',
    );
    const afterNew = await executeCliCommand(['symbol', 'brandNewHelper', '--workspace', repo]);
    expect(afterNew.output).toContain('brandNewHelper');

    // Adding a gitignored-but-indexed source file must also invalidate the fast path
    fs.writeFileSync(path.join(repo, '.gitignore'), 'generated/\n', 'utf8');
    fs.mkdirSync(path.join(repo, 'generated'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'generated', 'gen.ts'),
      'export function ignoredGenHelper(): number { return 99; }\n',
      'utf8',
    );
    const afterIgnored = await executeCliCommand(['search', 'ignoredGenHelper', '--workspace', repo]);
    expect(afterIgnored.output).toContain('ignoredGenHelper');

    // Extension parity: .hxx, *.dockerfile, lowercase dockerfile
    fs.writeFileSync(path.join(repo, 'src', 'widget.hxx'), 'struct WidgetBox { int w; };\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'src', 'api.dockerfile'), 'FROM node:22 AS api_stage\nEXPOSE 8080\n', 'utf8');
    const afterExts = await executeCliCommand(['search', 'WidgetBox', 'api_stage', '--workspace', repo]);
    expect(afterExts.output).toContain('WidgetBox');
    expect(afterExts.output).toContain('api_stage');

    // Deleting a tracked file must invalidate the fast path
    fs.rmSync(path.join(repo, 'src', 'extra.ts'));
    const afterDelete = await executeCliCommand(['search', 'brandNewHelper', '--workspace', repo]);
    expect(afterDelete.output).toContain('(0 matches)');

    // Staged rename (`git mv`) must invalidate the fast path
    execFileSync('git', ['mv', 'src/math.ts', 'src/arithmetic.ts'], { cwd: repo });
    const afterRename = await executeCliCommand(['outline', 'src/arithmetic.ts', '--workspace', repo]);
    expect(afterRename.output).toContain('divideNumbers');

    // Branch/HEAD switch must invalidate the fast path
    execFileSync('git', ['checkout', '-q', '-b', 'feat-head-check'], { cwd: repo });
    fs.writeFileSync(
      path.join(repo, 'src', 'branchOnly.ts'),
      'export function onlyOnBranch(): boolean { return true; }\n',
      'utf8',
    );
    execFileSync('git', ['add', 'src/branchOnly.ts'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'branch file'], { cwd: repo });
    const afterHead = await executeCliCommand(['symbol', 'onlyOnBranch', '--workspace', repo]);
    expect(afterHead.output).toContain('onlyOnBranch');
  });

  it('serves the last committed index with [index busy] notice (and indexBusy in --raw-json), and throws INDEX_BUILDING when empty', async () => {
    const repo = makeGitRepo('ast-cli-busy-');
    await executeCliCommand(['sync', '--workspace', repo]);

    const lockFile = syncLockPath(path.join(repo, '.ast-graph', 'ast.db'));
    // Write a lock owned by PID 1 (always alive on Unix) so activeLockOwner reports busy
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 1, host: os.hostname(), startedAt: Date.now(), heartbeatAt: Date.now() }),
      'utf8',
    );
    try {
      const res = await executeCliCommand(['outline', 'src/math.ts', '--workspace', repo]);
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain('[index busy]');
      expect(res.output).toContain('addNumbers');

      const rawRes = await executeCliCommand(['outline', 'src/math.ts', '--raw-json', '--workspace', repo]);
      const parsedRaw = JSON.parse(rawRes.output) as { indexBusy?: { pid: number } };
      expect(parsedRaw.indexBusy?.pid).toBe(1);
    } finally {
      fs.rmSync(lockFile, { force: true });
    }

    // Empty index with active lock must throw INDEX_BUILDING
    const emptyRepo = makeGitRepo('ast-cli-building-');
    const emptyAstDir = path.join(emptyRepo, '.ast-graph');
    fs.mkdirSync(emptyAstDir, { recursive: true });
    const emptyLock = syncLockPath(path.join(emptyAstDir, 'ast.db'));
    fs.writeFileSync(
      emptyLock,
      JSON.stringify({ pid: 1, host: os.hostname(), startedAt: Date.now(), heartbeatAt: Date.now() }),
      'utf8',
    );
    try {
      await expect(executeCliCommand(['outline', 'src/math.ts', '--workspace', emptyRepo])).rejects.toThrow(
        /INDEX_BUILDING/,
      );
    } finally {
      fs.rmSync(emptyLock, { force: true });
    }
  });

  it('does not import typescript on a clean read-only CLI subprocess query', () => {
    const repo = makeGitRepo('ast-cli-nots-');
    const cliPath = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js');
    execFileSync(process.execPath, ['--no-warnings', cliPath, 'sync', '--workspace', repo], {
      encoding: 'utf8',
    });

    // Probe in a fresh Node subprocess whether executing a clean outline/symbol loads the npm typescript package
    const probeScript = `
      import { createRequire } from 'node:module';
      const req = createRequire(import.meta.url);
      const { executeCliCommand } = await import(${JSON.stringify('file://' + cliPath)});
      const resOutline = await executeCliCommand(['outline', 'src/math.ts', '--workspace', ${JSON.stringify(repo)}]);
      const resSym = await executeCliCommand(['symbol', 'addNumbers', '--workspace', ${JSON.stringify(repo)}]);
      const loadedTsOnClean = Object.keys(req.cache).some((k) => k.includes('typescript'));
      await executeCliCommand(['sync', '--workspace', ${JSON.stringify(repo)}]);
      const loadedTsOnSync = Object.keys(req.cache).some((k) => k.includes('typescript'));
      console.log(JSON.stringify({
        exitCode: resOutline.exitCode,
        hasSymbol: resOutline.output.includes('addNumbers') && resSym.output.includes('addNumbers'),
        loadedTsOnClean,
        loadedTsOnSync,
      }));
    `;
    const stdout = execFileSync(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', probeScript],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(stdout.trim()) as {
      exitCode: number;
      hasSymbol: boolean;
      loadedTsOnClean: boolean;
      loadedTsOnSync: boolean;
    };
    expect(parsed.exitCode).toBe(0);
    expect(parsed.hasSymbol).toBe(true);
    expect(parsed.loadedTsOnClean).toBe(false);
    expect(parsed.loadedTsOnSync).toBe(true);
  });
});
