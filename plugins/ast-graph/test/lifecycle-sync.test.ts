import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AstGraphDatabase,
  AstGraphIndexer,
  AstMcpServer,
  executeCliCommand,
  extractGitLifecycleActions,
  getRegisteredWorkspaces,
  handleHookInvocation,
  resolveGitHeadSignature,
  resolveGitInfo,
} from '../src/index.js';

const tempDirs: string[] = [];
let prevRegistryEnv: string | undefined;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

function makeRealGitRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ast-lifecycle-${name}-`));
  tempDirs.push(dir);
  git(dir, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

beforeEach(() => {
  prevRegistryEnv = process.env.AST_GRAPH_REGISTRY_PATH;
  const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-lifecycle-reg-'));
  tempDirs.push(regDir);
  process.env.AST_GRAPH_REGISTRY_PATH = path.join(regDir, 'workspaces.json');
});

afterEach(() => {
  if (prevRegistryEnv === undefined) {
    delete process.env.AST_GRAPH_REGISTRY_PATH;
  } else {
    process.env.AST_GRAPH_REGISTRY_PATH = prevRegistryEnv;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('repository, branch, and worktree lifecycle synchronization', () => {
  it('detects branch switches via HEAD signature even on single-file outline queries', async () => {
    const repo = makeRealGitRepo('branch-switch');
    fs.writeFileSync(path.join(repo, 'src', 'keep.ts'), 'export function keepFn(): number { return 1; }\n');
    fs.writeFileSync(path.join(repo, 'src', 'mainOnly.ts'), 'export function mainOnlyFn(): string { return "main"; }\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial main']);

    await executeCliCommand(['sync', '--workspace', repo]);
    const mainHead = resolveGitHeadSignature(repo);
    expect(mainHead).toContain('refs/heads/main:');

    // Create a new branch that removes mainOnly.ts and adds branchOnly.ts without touching keep.ts
    git(repo, ['checkout', '-b', 'feat/new-branch']);
    fs.unlinkSync(path.join(repo, 'src', 'mainOnly.ts'));
    fs.writeFileSync(path.join(repo, 'src', 'branchOnly.ts'), 'export function branchOnlyFn(): number { return 42; }\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'branch changes']);

    // Querying outline on untouched src/keep.ts previously took the single-file fast path and missed branch diffs
    await executeCliCommand(['outline', 'src/keep.ts', '--workspace', repo]);

    const db = new AstGraphDatabase(path.join(repo, '.ast-graph', 'ast.db'), repo);
    try {
      expect(db.searchSymbols('mainOnlyFn')).toHaveLength(0);
      expect(db.searchSymbols('branchOnlyFn').length).toBeGreaterThan(0);
      expect(db.getMeta('last_git_head')).toContain('refs/heads/feat/new-branch:');
    } finally {
      db.close();
    }
  });

  it('seeds new worktrees from parent ast.db, removes .ast-graph before git worktree remove, and evicts stale MCP handles', async () => {
    const repo = makeRealGitRepo('worktree-flow');
    fs.writeFileSync(path.join(repo, 'src', 'core.ts'), 'export function coreService(): string { return "ok"; }\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);

    await executeCliCommand(['sync', '--workspace', repo]);

    const wtPath = path.join(repo, '.worktrees', 'feat-alpha');
    const addCmd = `git worktree add .worktrees/feat-alpha -b feat/alpha`;
    git(repo, ['worktree', 'add', '.worktrees/feat-alpha', '-b', 'feat/alpha']);

    const gitInfo = resolveGitInfo(wtPath);
    expect(gitInfo?.isWorktree).toBe(true);
    expect(gitInfo?.parentRepoRoot).toBe(fs.realpathSync(repo));

    // Simulate PostToolUse hook after `git worktree add`
    const postAdd = await handleHookInvocation(
      'post-tool-use',
      JSON.stringify({
        cwd: repo,
        workspacePaths: [repo],
        toolCall: { name: 'run_command', args: { CommandLine: addCmd } },
      }),
      { coldBuild: 'inline' },
    );
    expect(postAdd.workspaceRoots?.[0]).toBe(fs.realpathSync(wtPath));
    expect(fs.existsSync(path.join(wtPath, '.ast-graph', 'ast.db'))).toBe(true);

    // Shared parent .git/info/exclude receives both .ast-graph/ and .worktrees/
    const excludeContent = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(excludeContent).toContain('.ast-graph/');
    expect(excludeContent).toContain('.worktrees/');

    // Query worktree via AstMcpServer (pools open SQLite handle)
    const mcp = new AstMcpServer(repo);
    const symResp = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ast_search', arguments: { query: 'coreService', workspace: wtPath } },
    });
    expect(JSON.stringify(symResp.result)).toContain('coreService');
    expect(getRegisteredWorkspaces().some((w) => w.canonicalRoot === fs.realpathSync(wtPath))).toBe(true);

    // PreToolUse cleans `.ast-graph` inside the worktree so `git worktree remove` (without --force) succeeds!
    const rmCmd = 'git worktree remove .worktrees/feat-alpha';
    const preRm = await handleHookInvocation(
      'pre-tool-use',
      JSON.stringify({
        cwd: repo,
        workspacePaths: [repo],
        toolCall: { name: 'run_command', args: { CommandLine: rmCmd } },
      }),
    );
    expect(preRm.stdoutJson).toEqual({ decision: 'allow' });
    expect(fs.existsSync(path.join(wtPath, '.ast-graph'))).toBe(false);

    // Real `git worktree remove` WITHOUT `--force` succeeds cleanly
    git(repo, ['worktree', 'remove', '.worktrees/feat-alpha']);
    expect(fs.existsSync(wtPath)).toBe(false);

    await handleHookInvocation(
      'post-tool-use',
      JSON.stringify({
        cwd: repo,
        workspacePaths: [repo],
        toolCall: { name: 'run_command', args: { CommandLine: rmCmd } },
      }),
    );

    expect(getRegisteredWorkspaces().some((w) => w.canonicalRoot.endsWith('feat-alpha'))).toBe(false);
    expect(mcp.evictStaleHandles()).toBeGreaterThanOrEqual(1);
  });

  it('preserves Git dirty-worktree protection when user untracked files exist alongside .ast-graph', async () => {
    const repo = makeRealGitRepo('dirty-wt');
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    await executeCliCommand(['sync', '--workspace', repo]);

    const wtPath = path.join(repo, '.worktrees', 'dirty');
    git(repo, ['worktree', 'add', '.worktrees/dirty', '-b', 'feat/dirty']);
    await executeCliCommand(['sync', '--workspace', wtPath]);

    // Create an untracked user file inside the worktree
    fs.writeFileSync(path.join(wtPath, 'uncommitted-notes.txt'), 'keep me safe\n');

    await handleHookInvocation(
      'pre-tool-use',
      JSON.stringify({
        cwd: repo,
        workspacePaths: [repo],
        toolCall: { name: 'run_command', args: { CommandLine: 'git worktree remove .worktrees/dirty' } },
      }),
    );

    // .ast-graph was removed, but uncommitted-notes.txt still causes git worktree remove (no --force) to refuse
    expect(fs.existsSync(path.join(wtPath, '.ast-graph'))).toBe(false);
    expect(() => git(repo, ['worktree', 'remove', '.worktrees/dirty'])).toThrow();
    expect(fs.existsSync(path.join(wtPath, 'uncommitted-notes.txt'))).toBe(true);
  });

  it('caps sync_runs history and compacts freelist pages via compactIfNeeded', () => {
    const repo = makeRealGitRepo('compact');
    const dbPath = path.join(repo, '.ast-graph', 'ast.db');
    const db = new AstGraphDatabase(dbPath, repo);
    try {
      const indexer = new AstGraphIndexer(repo, db);
      fs.writeFileSync(path.join(repo, 'src', 'big.ts'), 'export const x = 1;\n');
      indexer.syncWorkspace({ full: true });

      for (let i = 0; i < 230; i += 1) {
        db.recordSyncRun({ durationMs: 1, mode: 'noop', filesScanned: 1, filesUpdated: 0 });
      }
      const runCount = (db.db.prepare('SELECT COUNT(*) as c FROM sync_runs').get() as { c: number }).c;
      expect(runCount).toBeLessThanOrEqual(200);

      // Force compaction and confirm zero freelist pages remain
      expect(db.compactIfNeeded({ force: true })).toBe(true);
      const freePages = (db.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
      expect(freePages).toBe(0);
    } finally {
      db.close();
    }
  });

  it('parses chained git lifecycle commands across cd and git -C flags', () => {
    const actions = extractGitLifecycleActions(
      'cd /tmp/demo && git worktree add -b feat/one .worktrees/one && git -C /tmp/other switch main && git clone https://github.com/org/proj.git',
      '/tmp',
    );
    expect(actions).toEqual([
      { kind: 'worktree-add', targetPath: path.resolve('/tmp/demo/.worktrees/one') },
      { kind: 'head-mutation', repoPath: path.resolve('/tmp/other') },
      { kind: 'repo-created', targetPath: path.resolve('/tmp/demo/proj') },
    ]);
  });

  it('resolves HEAD signatures across files and reftable backends (unborn, branch, detached)', () => {
    for (const refFormat of ['files', 'reftable'] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ast-head-${refFormat}-`));
      tempDirs.push(dir);
      try {
        git(dir, ['init', '-b', 'main', `--ref-format=${refFormat}`]);
      } catch {
        // Older git versions without --ref-format support only test the default backend
        continue;
      }

      expect(resolveGitHeadSignature(dir)).toBe('refs/heads/main:unborn');

      fs.writeFileSync(path.join(dir, 'index.ts'), 'export const v = 1;\n');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-m', 'init']);
      const sha = git(dir, ['rev-parse', 'HEAD']);
      expect(resolveGitHeadSignature(dir)).toBe(`refs/heads/main:${sha}`);

      git(dir, ['checkout', '--detach', sha]);
      expect(resolveGitHeadSignature(dir)).toBe(`detached:${sha}`);
    }
  });
});
