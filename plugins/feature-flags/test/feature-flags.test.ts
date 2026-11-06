import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULTS_PATH,
  evaluateHookEvent,
  resolveFeatureFlags,
  resetFeatureFlags,
  setFeatureFlag,
} from '../scripts/hook-handler.mjs';
import { runFlagsCli } from '../scripts/flags-cli.mjs';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agy-ff-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('@agent-skills/feature-flags plugin', () => {
  it('resolves 4-tier flag hierarchy (env > workspace > global > defaults)', () => {
    const workspaceRoot = makeTempDir('workspace');
    const globalDir = makeTempDir('global');
    const globalConfigPath = path.join(globalDir, 'feature-flags.json');

    // 1. Default values
    const base = resolveFeatureFlags({ workspaceRoot, globalConfigPath, envFlags: '' });
    expect(base.values.release_channel).toBe('stable');
    expect(base.sources.release_channel).toBe('default');
    expect(base.values.read_only_mode).toBe(false);

    // 2. Global override beats default
    setFeatureFlag('release_channel', 'beta', { scope: 'global', globalConfigPath });
    setFeatureFlag('strict_tdd', 'true', { scope: 'global', globalConfigPath });
    const withGlobal = resolveFeatureFlags({ workspaceRoot, globalConfigPath, envFlags: '' });
    expect(withGlobal.values.release_channel).toBe('beta');
    expect(withGlobal.sources.release_channel).toBe('global');
    expect(withGlobal.values.strict_tdd).toBe(true);

    // 3. Workspace override beats global
    setFeatureFlag('release_channel', 'experimental', { scope: 'workspace', workspaceRoot });
    const withWorkspace = resolveFeatureFlags({ workspaceRoot, globalConfigPath, envFlags: '' });
    expect(withWorkspace.values.release_channel).toBe('experimental');
    expect(withWorkspace.sources.release_channel).toBe('workspace');
    expect(withWorkspace.values.strict_tdd).toBe(true);
    expect(withWorkspace.sources.strict_tdd).toBe('global');

    // 4. Env var override beats workspace
    const withEnv = resolveFeatureFlags({
      workspaceRoot,
      globalConfigPath,
      envFlags: 'release_channel=stable,read_only_mode=true',
    });
    expect(withEnv.values.release_channel).toBe('stable');
    expect(withEnv.sources.release_channel).toBe('env');
    expect(withEnv.values.read_only_mode).toBe(true);
    expect(withEnv.sources.read_only_mode).toBe('env');
  });

  it('extracts workspacePaths[0] from stdin JSON on SessionStart and PreInvocation without transcript bloat', () => {
    const workspaceRoot = makeTempDir('hooks');
    const globalConfigPath = path.join(makeTempDir('global'), 'feature-flags.json');

    // When all flags are at default, SessionStart and PreInvocation emit empty {}
    const stdinPayload = JSON.stringify({
      conversationId: 'conv-123',
      workspacePaths: [workspaceRoot],
    });
    expect(evaluateHookEvent('session-start', stdinPayload, { globalConfigPath, envFlags: '' })).toEqual({});
    expect(evaluateHookEvent('pre-invocation', stdinPayload, { globalConfigPath, envFlags: '' })).toEqual({});

    // Enable read_only_mode and experimental release_channel in workspace
    setFeatureFlag('read_only_mode', true, { scope: 'workspace', workspaceRoot });
    setFeatureFlag('release_channel', 'experimental', { scope: 'workspace', workspaceRoot });

    // SessionStart emits a one-time systemMessage
    const sessionOut = evaluateHookEvent('session-start', stdinPayload, {
      globalConfigPath,
      envFlags: '',
    });
    expect(sessionOut.injectSteps).toHaveLength(1);
    expect(sessionOut.injectSteps[0].systemMessage.systemMessage).toContain('read_only_mode=true');
    expect(sessionOut.injectSteps[0].systemMessage.systemMessage).toContain('release_channel="experimental"');

    // PreInvocation emits a transient ephemeralMessage (never systemMessage)
    const preInvOut = evaluateHookEvent('pre-invocation', stdinPayload, {
      globalConfigPath,
      envFlags: '',
    });
    expect(preInvOut.injectSteps).toHaveLength(1);
    expect(preInvOut.injectSteps[0].ephemeralMessage).toContain('[FLAG release_channel=experimental]');
    expect(preInvOut.injectSteps[0].ephemeralMessage).toContain('[FLAG read_only_mode=true]');
    expect(preInvOut.injectSteps[0].systemMessage).toBeUndefined();
  });

  it('enforces PreToolUse deny, force_ask, and argument overwrite based on active flags', () => {
    const workspaceRoot = makeTempDir('pretool');
    const globalConfigPath = path.join(makeTempDir('global'), 'feature-flags.json');

    // 1. Default read_only_mode=false allows write_file
    const writeStdin = JSON.stringify({
      workspacePaths: [workspaceRoot],
      toolCall: {
        name: 'write_file',
        args: { Path: '/tmp/example.txt', Content: 'hello' },
      },
    });
    expect(evaluateHookEvent('pre-tool-use', writeStdin, { globalConfigPath, envFlags: '' })).toEqual({
      decision: 'allow',
    });

    // 2. Toggling read_only_mode=true immediately denies write_file and edit_file
    setFeatureFlag('read_only_mode', true, { scope: 'workspace', workspaceRoot });
    const deniedWrite = evaluateHookEvent('pre-tool-use', writeStdin, {
      globalConfigPath,
      envFlags: '',
    });
    expect(deniedWrite.decision).toBe('deny');
    expect(deniedWrite.reason).toContain('read_only_mode=true');

    // 3. Default prefer_uv_pytest=true rewrites bare pytest to uv run pytest
    const pytestStdin = JSON.stringify({
      workspacePaths: [workspaceRoot],
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'pytest tests/unit -q' },
      },
    });
    const rewritten = evaluateHookEvent('pre-tool-use', pytestStdin, {
      globalConfigPath,
      envFlags: '',
    });
    expect(rewritten.decision).toBe('allow');
    expect(rewritten.overwrite).toEqual({
      CommandLine: 'uv run pytest tests/unit -q',
    });

    // 4. Production deploy guard switches between force_ask and deny
    const deployStdin = JSON.stringify({
      workspacePaths: [workspaceRoot],
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'gcloud run deploy my-service --region us-central1' },
      },
    });
    const askDeploy = evaluateHookEvent('pre-tool-use', deployStdin, {
      globalConfigPath,
      envFlags: '',
    });
    expect(askDeploy.decision).toBe('force_ask');

    setFeatureFlag('prod_deploy_guard', 'deny', { scope: 'workspace', workspaceRoot });
    const denyDeploy = evaluateHookEvent('pre-tool-use', deployStdin, {
      globalConfigPath,
      envFlags: '',
    });
    expect(denyDeploy.decision).toBe('deny');
  });

  it('supports CLI list, get, set, enable, disable, and reset commands', () => {
    const workspaceRoot = makeTempDir('cli');
    const globalConfigPath = path.join(makeTempDir('global'), 'feature-flags.json');

    const enableOut = runFlagsCli(['enable', 'strict_tdd', '--workspace', workspaceRoot], {
      globalConfigPath,
      defaultsPath: DEFAULTS_PATH,
    });
    expect(enableOut).toContain('strict_tdd=true');

    const getOut = runFlagsCli(['get', 'strict_tdd', '--workspace', workspaceRoot], {
      globalConfigPath,
      defaultsPath: DEFAULTS_PATH,
    });
    expect(getOut).toContain('strict_tdd=true (source: workspace)');

    // Reject invalid enum values
    expect(() =>
      runFlagsCli(['set', 'release_channel', 'invalid-tier', '--workspace', workspaceRoot], {
        globalConfigPath,
        defaultsPath: DEFAULTS_PATH,
      }),
    ).toThrow(/Allowed options: stable, beta, experimental/);

    // Reset flag
    resetFeatureFlags('strict_tdd', { scope: 'workspace', workspaceRoot });
    const afterReset = runFlagsCli(['get', 'strict_tdd', '--workspace', workspaceRoot], {
      globalConfigPath,
      defaultsPath: DEFAULTS_PATH,
    });
    expect(afterReset).toContain('strict_tdd=false (source: default)');
  });
});
