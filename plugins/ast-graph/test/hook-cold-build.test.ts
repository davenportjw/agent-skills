import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AstGraphDatabase } from '../src/index.js';
import { handleHookInvocation } from '../src/hook-handler.js';
import { syncLockPath } from '../src/sync-lock.js';

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const distCli = path.resolve(__dirname, '..', 'dist', 'cli.js');

function makeTempRepo(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ast-graph-${name}-`)));
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
  tempDirs.push(dir);
  return dir;
}

function liveForeignPid(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

function fileCount(dbPath: string): number {
  const db = new AstGraphDatabase(dbPath);
  try {
    return db.getCounts().files;
  } finally {
    db.close();
  }
}

afterEach(() => {
  while (children.length > 0) children.pop()!.kill('SIGKILL');
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('hook cold builds and lock contention', () => {
  it.skipIf(!fs.existsSync(distCli))(
    'returns immediately on a cold repo and builds the index in a detached background sync',
    async () => {
      const repo = makeTempRepo('hook-cold');
      const dbPath = path.join(repo, '.ast-graph', 'ast.db');
      const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'a.ts') } });

      const result = await handleHookInvocation('PostToolUse', payload, { coldBuild: 'background' });
      expect(result.filesUpdated).toBe(0);
      expect(result.workspaceRoots).toEqual([repo]);

      const deadline = Date.now() + 15_000;
      while (fileCount(dbPath) === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(fileCount(dbPath)).toBeGreaterThan(0);
      // Background builds never write the large snapshot exports.
      expect(fs.existsSync(path.join(repo, '.ast-graph', 'export.cypher'))).toBe(false);
      expect(fs.existsSync(path.join(repo, '.ast-graph', 'snapshot.jsonl'))).toBe(false);
    },
    20_000,
  );

  it('treats a cold repo locked by another live process as a no-op instead of failing the hook', async () => {
    const repo = makeTempRepo('hook-locked');
    const dbPath = path.join(repo, '.ast-graph', 'ast.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const pid = liveForeignPid();
    const now = Date.now();
    fs.writeFileSync(
      syncLockPath(dbPath),
      JSON.stringify({ pid, host: os.hostname(), startedAt: now, heartbeatAt: now }),
    );

    const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'a.ts') } });
    for (const coldBuild of ['inline', 'background'] as const) {
      const result = await handleHookInvocation('PostToolUse', payload, { coldBuild });
      expect(result.filesUpdated).toBe(0);
    }
    const session = await handleHookInvocation('SessionStart', JSON.stringify({ cwd: repo }), { coldBuild: 'inline' });
    expect(session.filesUpdated).toBe(0);
    expect(fileCount(dbPath)).toBe(0);
  });
});
