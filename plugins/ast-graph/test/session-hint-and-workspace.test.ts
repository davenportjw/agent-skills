import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCliCommand } from '../src/cli.js';
import { buildSessionHint, handleHookInvocation, listLinkedWorktrees } from '../src/hook-handler.js';

const tempDirs: string[] = [];

function makeTempRepo(name: string, gitInit = false): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ast-graph-${name}-`)));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
  if (gitInit) {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  } else {
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  }
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('CLI workspace validation', () => {
  it('fails with WORKSPACE_NOT_FOUND and never creates a missing workspace directory', async () => {
    const base = makeTempRepo('ws-missing');
    const missing = path.join(base, '.worktrees', 'removed-item');
    const result = await executeCliCommand(['outline', 'src/a.ts', '--workspace', missing]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('WORKSPACE_NOT_FOUND');
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(path.join(base, '.worktrees'))).toBe(false);
  });

  it('rejects a --workspace that points at a file', async () => {
    const repo = makeTempRepo('ws-file');
    const result = await executeCliCommand(['status', '--workspace', path.join(repo, 'package.json'), '--json']);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output).error).toBe('WORKSPACE_NOT_FOUND');
  });
});

describe('SessionStart CLI hint', () => {
  it('injects the CLI line and --workspace root as an Antigravity system message', async () => {
    const repo = makeTempRepo('hint-agy');
    const result = await handleHookInvocation('session-start', JSON.stringify({ workspacePaths: [repo] }), {
      coldBuild: 'inline',
    });
    const steps = (result.stdoutJson as { injectSteps?: Array<{ systemMessage: { systemMessage: string } }> })
      .injectSteps;
    expect(steps).toHaveLength(1);
    const text = steps![0].systemMessage.systemMessage;
    expect(text).toMatch(/node \S*cli\.js outline\|symbol\|refs\|search\|blast\|tests/);
    expect(text).toContain(`--workspace ${repo}`);
    expect(text).toContain('subagents or swarm workers');
  });

  it('uses additionalContext for Claude Code', async () => {
    const repo = makeTempRepo('hint-claude');
    const result = await handleHookInvocation(
      'SessionStart',
      JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', cwd: repo }),
      { coldBuild: 'inline' },
    );
    const out = result.stdoutJson as { continue: boolean; hookSpecificOutput: { additionalContext: string } };
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput.additionalContext).toContain(`--workspace ${repo}`);
  });

  it('can be disabled', async () => {
    const repo = makeTempRepo('hint-off');
    const result = await handleHookInvocation('session-start', JSON.stringify({ workspacePaths: [repo] }), {
      coldBuild: 'inline',
      sessionHint: false,
    });
    expect(result.stdoutJson).toEqual({});
  });

  it('lists live linked worktrees with their own --workspace path', () => {
    const repo = makeTempRepo('hint-wt', true);
    const wt = path.join(repo, '.worktrees', 'feat-x');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'feat/x'], { stdio: 'ignore' });
    const realWt = fs.realpathSync(wt);
    expect(listLinkedWorktrees(repo).map((p) => fs.realpathSync(p))).toEqual([realWt]);
    const hint = buildSessionHint([repo])!;
    expect(hint).toMatch(/Worktrees have their own index/);
    expect(hint).toContain('feat-x');
  });
});
