import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateClaudeConfigSnippet, generateCodexConfigSnippet } from '../scripts/arcade-cli.mjs';
import { computeGlobalState, createArcadeServer, readStateDisk, withGlobalState } from '../scripts/arcade-server.mjs';
import {
  buildHookStdout,
  focusAntigravityIfGameFront,
  isAttentionEvent,
  isGameWindowClosedByUser,
  openArcadeWindow,
  shouldOpenArcadeWindow,
  computeArcadeTransition,
  notifySidecarDaemon,
  parseMultiHarnessHookStdin,
  resetArcadeFlags,
  resolveArcadeFlags,
  setArcadeFlag,
  syncArtifactIfPresent,
} from '../scripts/hook-handler.mjs';

describe('thinking-arcade plugin (Model Invaders sidecar)', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-arcade-test-'));
    statePath = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses Antigravity, Claude Code, and OpenAI Codex stdin payloads accurately', () => {
    const agy = parseMultiHarnessHookStdin(
      JSON.stringify({
        conversationId: 'conv-1',
        toolCall: { name: 'ast_symbol', args: {} },
        artifactDirectoryPath: '/tmp/artifacts',
        fullyIdle: false,
      }),
    );
    expect(agy.harness).toBe('antigravity');
    expect(agy.toolName).toBe('ast_symbol');
    expect(agy.fullyIdle).toBe(false);

    const claude = parseMultiHarnessHookStdin(
      JSON.stringify({
        session_id: 'sess-claude',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      }),
    );
    expect(claude.harness).toBe('claude-code');
    expect(claude.toolName).toBe('Bash');

    const codex = parseMultiHarnessHookStdin(
      JSON.stringify({
        turnId: 'turn-99',
        threadId: 'thread-1',
        toolName: 'exec_command',
      }),
    );
    expect(codex.harness).toBe('codex');
    expect(codex.toolName).toBe('exec_command');
  });

  it('transitions to THINKING on PreInvocation / UserPromptSubmit and TOOL_RUNNING on PreToolUse', () => {
    const preInv = computeArcadeTransition(
      'pre-invocation',
      JSON.stringify({ conversationId: 'c1' }),
    );
    expect(preInv.state).toBe('THINKING');
    expect(preInv.event).toBe('PreInvocation');

    const claudePrompt = computeArcadeTransition(
      'user-prompt-submit',
      JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }),
    );
    expect(claudePrompt.state).toBe('THINKING');
    expect(claudePrompt.harness).toBe('claude-code');
    expect(claudePrompt.event).toBe('UserPromptSubmit');

    const toolRun = computeArcadeTransition(
      'pre-tool-use',
      JSON.stringify({ toolCall: { name: 'run_command' } }),
    );
    expect(toolRun.state).toBe('TOOL_RUNNING');
    expect(toolRun.detail).toBe('run_command');
  });

  it('stops the game immediately on Stop by default even if fullyIdle is false, unless keep_alive_on_subagents is explicitly enabled', () => {
    const defaultStop = computeArcadeTransition(
      'stop',
      JSON.stringify({ terminationReason: 'NO_TOOL_CALL', fullyIdle: false }),
    );
    expect(defaultStop.state).toBe('IDLE');
    expect(defaultStop.fullyIdle).toBe(false);

    const optInKeepAliveStop = computeArcadeTransition(
      'stop',
      JSON.stringify({ terminationReason: 'NO_TOOL_CALL', fullyIdle: false }),
      { envFlags: 'keep_alive_on_subagents=true' },
    );
    expect(optInKeepAliveStop.state).toBe('THINKING');

    const fullStop = computeArcadeTransition(
      'stop',
      JSON.stringify({ terminationReason: 'NO_TOOL_CALL', fullyIdle: true }),
    );
    expect(fullStop.state).toBe('IDLE');
    expect(fullStop.fullyIdle).toBe(true);
  });

  it('emits zero-panic systemMessage on SessionStart and allow decisions on PreToolUse/Stop', () => {
    const startOut = buildHookStdout(
      'session-start',
      { harness: 'antigravity', state: 'IDLE' },
      { port: 4777, bannerUserMarkdown: false },
    );
    expect(startOut.injectSteps?.[0]?.systemMessage?.systemMessage).toContain(
      '[▶ Open Model Invaders](sidecar://thinking-arcade/arcade-daemon/)',
    );
    expect(startOut.injectSteps?.[0]?.systemMessage?.metadata).toBeUndefined();

    // Opt-in banner_user_markdown: pill moves to metadata.user_markdown (always-visible, never read by the model)
    const mdOut = buildHookStdout(
      'session-start',
      { harness: 'antigravity', state: 'IDLE' },
      { port: 4777, bannerUserMarkdown: true },
    );
    const mdMsg = mdOut.injectSteps?.[0]?.systemMessage;
    expect(mdMsg?.metadata?.user_markdown).toContain(
      '[▶ Open Model Invaders](sidecar://thinking-arcade/arcade-daemon/)',
    );
    expect(mdMsg?.systemMessage).not.toContain('sidecar://');
    expect(Object.keys(mdMsg?.metadata || {})).toEqual(['user_markdown']);

    const toolOut = buildHookStdout('pre-tool-use', { harness: 'antigravity' });
    expect(toolOut).toEqual({ decision: 'allow' });
  });

  it('serves live HTTP + event updates and persists high scores via createArcadeServer', async () => {
    const { server, getState } = createArcadeServer({ statePath });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };
    const port = address.port;

    try {
      // Notify daemon via hook helper
      const res = await notifySidecarDaemon(
        {
          state: 'TOOL_RUNNING',
          event: 'PreToolUse',
          harness: 'antigravity',
          detail: 'ast_blast_radius',
        },
        { port, statePath, autoSpawn: false },
      );
      expect(res.notified).toBe(true);
      expect(getState().state).toBe('TOOL_RUNNING');
      expect(getState().detail).toBe('ast_blast_radius');

      // Post a new score and verify highScore persistence
      const scoreResp = await fetch(`http://127.0.0.1:${port}/api/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: 420, wave: 3 }),
      });
      const scoreJson = (await scoreResp.json()) as { ok: boolean; status: { highScore: number; wave: number } };
      expect(scoreJson.ok).toBe(true);
      expect(scoreJson.status.highScore).toBe(420);
      expect(scoreJson.status.wave).toBe(3);

      const disk = readStateDisk(statePath);
      expect(disk.highScore).toBe(420);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('syncs the HTML artifact + .metadata.json and generates valid Claude Code and Codex CLI hook configs', () => {
    const artifactDir = path.join(tmpDir, 'artifacts');
    const firstSync = syncArtifactIfPresent(artifactDir);
    expect(firstSync.dest).toBeTruthy();
    expect(firstSync.newlyCreated).toBe(true);
    expect(fs.existsSync(firstSync.dest!)).toBe(true);
    expect(fs.existsSync(`${firstSync.dest!}.metadata.json`)).toBe(true);

    const secondSync = syncArtifactIfPresent(artifactDir);
    expect(secondSync.newlyCreated).toBe(false);

    const preInvOut = buildHookStdout(
      'pre-invocation',
      {
        harness: 'antigravity',
        state: 'THINKING',
        artifactDirectoryPath: artifactDir,
        displayMode: 'inline',
      },
      { newlyCreated: true, port: 4777 },
    );
    expect(preInvOut.injectSteps?.[0]?.ephemeralMessage).toContain(
      '<agent-embed src="file://',
    );

    const claudeCfg = generateClaudeConfigSnippet('/path/to/hook-handler.mjs');
    expect(claudeCfg.hooks.UserPromptSubmit).toBeDefined();
    expect(claudeCfg.hooks.Stop).toBeDefined();

    const codexCfg = generateCodexConfigSnippet('/path/to/hook-handler.mjs');
    expect(codexCfg.hooks.UserPromptSubmit).toBeDefined();
    expect(codexCfg.hooks.PermissionRequest).toBeDefined();
    expect(codexCfg.hooks.Stop).toBeDefined();
  });

  it('resolves display_mode (auxiliary | inline | inline-follow | both | off) across defaults, global, workspace, and env tiers', () => {
    const globalCfg = path.join(tmpDir, 'global-arcade.json');
    const wsRoot = path.join(tmpDir, 'ws');
    const artifactDir = path.join(tmpDir, 'artifacts-modes');

    // 1. Default is 'window' (hook opens a standalone app window on prompt start; no agent tool calls)
    const defResolved = resolveArcadeFlags({ globalConfigPath: globalCfg, workspaceRoot: wsRoot });
    expect(defResolved.values.display_mode).toBe('window');
    expect(defResolved.details.display_mode.source).toBe('default');

    // 2. Global override -> 'inline-follow' (Option 3: re-pins at the bottom of every turn)
    setArcadeFlag('display_mode', 'inline-follow', {
      scope: 'global',
      globalConfigPath: globalCfg,
    });
    const globResolved = resolveArcadeFlags({ globalConfigPath: globalCfg, workspaceRoot: wsRoot });
    expect(globResolved.values.display_mode).toBe('inline-follow');
    expect(globResolved.details.display_mode.source).toBe('global');

    // On invocationNum === 0 in inline-follow mode, bottom-pin ephemeralMessage is emitted without metadata map panic
    const followTurnStart = buildHookStdout(
      'pre-invocation',
      {
        harness: 'antigravity',
        state: 'THINKING',
        artifactDirectoryPath: artifactDir,
        displayMode: 'inline-follow',
        invocationNum: 0,
      },
      { newlyCreated: false, port: 4777 },
    );
    expect(followTurnStart.injectSteps).toHaveLength(1);
    expect(typeof followTurnStart.injectSteps?.[0]?.ephemeralMessage).toBe('string');
    expect(followTurnStart.injectSteps?.[0]?.ephemeralMessage).toContain(
      'display_mode=inline-follow',
    );
    expect(followTurnStart.injectSteps?.[0]?.ephemeralMessage).toContain(
      'at the very bottom of this response',
    );

    // On subsequent tool steps (invocationNum > 0) in inline-follow mode, nothing is re-injected mid-turn
    const followMidTurn = buildHookStdout(
      'pre-invocation',
      {
        harness: 'antigravity',
        state: 'THINKING',
        artifactDirectoryPath: artifactDir,
        displayMode: 'inline-follow',
        invocationNum: 3,
      },
      { newlyCreated: false, port: 4777 },
    );
    expect(followMidTurn).toEqual({});

    // Verify PreInvocation hook output in 'auxiliary' mode instructs agent to open Right Auxiliary Pane when client is not active, and skips re-injection when clientActive is true
    const auxOut = buildHookStdout(
      'pre-invocation',
      {
        harness: 'antigravity',
        state: 'THINKING',
        artifactDirectoryPath: artifactDir,
        displayMode: 'auxiliary',
      },
      { newlyCreated: true, clientActive: false, port: 4777 },
    );
    expect(auxOut.injectSteps).toHaveLength(1);
    expect(typeof auxOut.injectSteps?.[0]?.ephemeralMessage).toBe('string');
    expect(auxOut.injectSteps?.[0]?.ephemeralMessage).toContain(
      'display_mode=auxiliary',
    );
    expect(auxOut.injectSteps?.[0]?.ephemeralMessage).toContain(
      'Right Auxiliary Pane',
    );
    // The pill must stream as preamble text BEFORE the first tool call, not in the final reply
    // (final-reply text only renders after the agent finishes working).
    const auxMsg = String(auxOut.injectSteps?.[0]?.ephemeralMessage);
    expect(auxMsg).toContain('BEFORE making any tool call');
    expect(auxMsg).toContain('[▶ Open Model Invaders](sidecar://thinking-arcade/arcade-daemon/)');
    // No artifact-edit tool call: it never opened the pane and only pollutes transcripts.
    expect(auxMsg).toContain('Do NOT call edit_file/write_file');
    expect(auxMsg).not.toContain('UserFacing');
    expect(auxMsg).not.toContain('VERY FIRST LINE of your chat response');

    const auxAlreadyOpenOut = buildHookStdout(
      'pre-invocation',
      {
        harness: 'antigravity',
        state: 'THINKING',
        artifactDirectoryPath: artifactDir,
        displayMode: 'auxiliary',
        invocationNum: 0,
      },
      { newlyCreated: false, isPromptStart: true, clientActive: true, port: 4777 },
    );
    expect(auxAlreadyOpenOut).toEqual({});

    // 3. Workspace override -> 'both'
    setArcadeFlag('display_mode', 'both', {
      scope: 'workspace',
      workspaceRoot: wsRoot,
    });
    const wsResolved = resolveArcadeFlags({ globalConfigPath: globalCfg, workspaceRoot: wsRoot });
    expect(wsResolved.values.display_mode).toBe('both');
    expect(wsResolved.details.display_mode.source).toBe('workspace');

    const bothOut = buildHookStdout(
      'pre-invocation',
      {
        harness: 'antigravity',
        state: 'THINKING',
        artifactDirectoryPath: artifactDir,
        displayMode: 'both',
      },
      { newlyCreated: true, port: 4777 },
    );
    expect(bothOut.injectSteps).toHaveLength(1);
    expect(typeof bothOut.injectSteps?.[0]?.ephemeralMessage).toBe('string');
    expect(bothOut.injectSteps?.[0]?.ephemeralMessage).toContain('display_mode=both');

    // 4. Env override -> 'off'
    const envResolved = resolveArcadeFlags({
      globalConfigPath: globalCfg,
      workspaceRoot: wsRoot,
      envFlags: 'display_mode=off,no-keep_alive_on_subagents',
    });
    expect(envResolved.values.display_mode).toBe('off');
    expect(envResolved.values.keep_alive_on_subagents).toBe(false);
    expect(envResolved.details.display_mode.source).toBe('env');

    const offOut = buildHookStdout(
      'pre-invocation',
      {
        harness: 'antigravity',
        state: 'THINKING',
        artifactDirectoryPath: artifactDir,
        displayMode: 'off',
      },
      { newlyCreated: true, port: 4777 },
    );
    expect(offOut).toEqual({});

    // Reset workspace and global overrides
    resetArcadeFlags({ scope: 'workspace', workspaceRoot: wsRoot });
    resetArcadeFlags({ scope: 'global', globalConfigPath: globalCfg });
    const afterReset = resolveArcadeFlags({ globalConfigPath: globalCfg, workspaceRoot: wsRoot });
    expect(afterReset.values.display_mode).toBe('window');
  });

  it('display_mode=window opens a chromeless app window only at prompt start when no client is polling', () => {
    const base = { displayMode: 'window', harness: 'antigravity' };
    expect(shouldOpenArcadeWindow({ ...base, isPromptStart: true, clientActive: false })).toBe(true);
    expect(shouldOpenArcadeWindow({ ...base, isPromptStart: false, clientActive: false })).toBe(false);
    // clientActive ignored: dedupe happens by raising the existing window for the session
    expect(shouldOpenArcadeWindow({ ...base, isPromptStart: true, clientActive: true })).toBe(true);
    expect(shouldOpenArcadeWindow({ ...base, displayMode: 'auxiliary', isPromptStart: true, clientActive: false })).toBe(false);
    expect(shouldOpenArcadeWindow({ ...base, harness: 'claude', isPromptStart: true, clientActive: false })).toBe(false);

    const calls: any[] = [];
    const spawnFn = (cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return { on() {}, unref() {} };
    };
    const url = 'http://127.0.0.1:4777/?sessionId=abc';
    const chrome = openArcadeWindow(url, { spawnFn, platform: 'darwin', hasChrome: true, sessionMarker: 'sessionId=abc' });
    expect(chrome.cmd).toBe('/bin/sh');
    const sh = chrome.args[1];
    expect(sh).toContain('contains "sessionId=abc"'); // raise existing window for this session
    expect(sh).toContain('set index of w to 1');
    expect(sh).toContain(`--app=${url}`); // otherwise open a new app window
    expect(sh.indexOf('osascript')).toBeLessThan(sh.indexOf('open -na'));
    expect(calls[0].opts).toMatchObject({ detached: true, stdio: 'ignore' });
    const fallback = openArcadeWindow(url, { spawnFn, platform: 'darwin', hasChrome: false });
    expect(fallback.args).toEqual([url]);

    // window mode injects nothing into the transcript
    const out = buildHookStdout(
      'pre-invocation',
      { harness: 'antigravity', state: 'THINKING', displayMode: 'window', artifactDirectoryPath: '/tmp/x', invocationNum: 0 },
      { isPromptStart: true, clientActive: false, port: 4777 },
    );
    expect(out).toEqual({});
  });

  it('aggregates all conversations into one global game state (plays only when all live sessions are working)', () => {
    const now = Date.parse('2026-11-05T05:00:00Z');
    const iso = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
    const working = {
      a: { state: 'THINKING', lastEvent: 'PreInvocation', updatedAt: iso(5) },
      b: { state: 'TOOL_RUNNING', lastEvent: 'PreToolUse', detail: 'run_command', updatedAt: iso(2) },
      stale: { state: 'THINKING', lastEvent: 'PreInvocation', updatedAt: iso(3 * 3600) },
      oldDone: { state: 'IDLE', lastEvent: 'Stop', updatedAt: iso(2 * 3600) },
    };
    const g1 = computeGlobalState(working, { now });
    expect(g1.state).toBe('TOOL_RUNNING');
    expect(g1.active.sort()).toEqual(['a', 'b']);
    expect(g1.attention).toEqual([]);

    // a finishes -> game pauses and reports a needs attention
    const g2 = computeGlobalState({ ...working, a: { state: 'IDLE', lastEvent: 'Stop', lastUserInput: 'fix tests', updatedAt: iso(1) } }, { now });
    expect(g2.state).toBe('IDLE');
    expect(g2.attention[0]).toMatchObject({ id: 'a', reason: 'finished', lastUserInput: 'fix tests' });
    expect(g2.active).toEqual(['b']);

    // ack ("keep playing") dismisses finished turns before the ack -> b keeps the game running
    const g3 = computeGlobalState({ ...working, a: { state: 'IDLE', lastEvent: 'Stop', updatedAt: iso(1) } }, { now, ackAt: now });
    expect(g3.state).toBe('TOOL_RUNNING');
    // ...but the dismissed turn stays listed under the game as still waiting on the user
    expect(g3.attention).toEqual([]);
    expect(g3.waiting).toEqual([expect.objectContaining({ id: 'a', reason: 'finished', dismissed: true })]);

    // waiting rows carry the workspace name for the "Needs you" panel
    const gw = computeGlobalState({ c: { state: 'IDLE', lastEvent: 'Stop', workspaceRoot: '/home/dev/agent-skills', updatedAt: iso(1) } }, { now });
    expect(gw.waiting[0]).toMatchObject({ id: 'c', workspace: 'agent-skills', dismissed: false });

    // ask_question always needs attention, even after an ack
    const g4 = computeGlobalState({ ...working, b: { state: 'TOOL_RUNNING', detail: 'ask_question', updatedAt: iso(1) } }, { now, ackAt: now });
    expect(g4.state).toBe('IDLE');
    expect(g4.attention[0]).toMatchObject({ id: 'b', reason: 'question' });

    // nothing live -> idle
    expect(computeGlobalState({ stale: working.stale }, { now }).state).toBe('IDLE');

    const payload = withGlobalState({ state: 'THINKING', sessions: g2 && { ...working, a: { state: 'IDLE', lastEvent: 'Stop', updatedAt: iso(1) } } } as any, { now });
    expect(payload.scope).toBe('global');
    expect(payload.state).toBe('IDLE');
    expect(payload.attention).toHaveLength(1);
  });

  it('hands focus back to Antigravity on Stop / ask_question only when the game window is frontmost', () => {
    expect(isAttentionEvent('stop', {})).toBe(true);
    expect(isAttentionEvent('pre-tool-use', { detail: 'ask_question' })).toBe(true);
    expect(isAttentionEvent('pre-tool-use', { detail: 'run_command' })).toBe(false);
    expect(isAttentionEvent('pre-invocation', {})).toBe(false);
    const calls: any[] = [];
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { on() {}, unref() {} };
    };
    const r = focusAntigravityIfGameFront({ spawnFn, platform: 'darwin' });
    expect(r?.cmd).toBe('osascript');
    expect(calls[0].args[1]).toContain('frontApp is "Google Chrome"');
    expect(calls[0].args[1]).toContain('scope=global');
    expect(calls[0].args[1]).toContain('tell application "Antigravity" to activate');
    expect(focusAntigravityIfGameFront({ spawnFn, platform: 'linux' })).toBeNull();
  });

  it('persists the cross-session ack through disk reads and hook writes (regression: game stuck paused)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ack-'));
    const statePath = path.join(dir, 'state.json');
    try {
      fs.writeFileSync(statePath, JSON.stringify({ state: 'IDLE', sessions: {}, attentionAckAt: 12345 }));
      expect(readStateDisk(statePath).attentionAckAt).toBe(12345);
      const srv = createArcadeServer({ statePath });
      const before = Date.now();
      srv.updateState({ sessionId: 's1', state: 'THINKING', event: 'PreInvocation', ackAttention: true });
      const disk = readStateDisk(statePath);
      expect(disk.attentionAckAt).toBeGreaterThanOrEqual(before);
      srv.updateState({ sessionId: 's1', state: 'TOOL_RUNNING', event: 'PreToolUse' });
      expect(readStateDisk(statePath).attentionAckAt).toBe(disk.attentionAckAt);
      srv.server.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists waiting conversations under the game with an Open link wired to /api/focus', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-wait-'));
    const statePath = path.join(dir, 'state.json');
    try {
      const srv = createArcadeServer({ statePath });
      srv.updateState({ sessionId: 's1', state: 'IDLE', event: 'Stop', workspaceRoot: '/tmp/my-repo', lastUserInput: 'ship it' });
      const payload = withGlobalState(readStateDisk(statePath));
      expect(payload.waiting[0]).toMatchObject({ id: 's1', workspace: 'my-repo', lastUserInput: 'ship it', reason: 'finished' });
      srv.server.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
    expect(html).toContain('id="waiting-panel"');
    expect(html).toContain('/api/focus');
    const server = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'arcade-server.mjs'), 'utf8');
    expect(server).toContain("url.pathname === '/api/focus'");
  });

  it('tracks the shared game window over SSE and offers a reopen bar instead of reopening after the user closes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-win-'));
    const statePath = path.join(dir, 'state.json');
    const srv = createArcadeServer({ statePath });
    await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
    const port = (srv.server.address() as any).port;
    try {
      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/events?scope=global`, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(readStateDisk(statePath).gameWindow).toMatchObject({ open: true });
      expect(isGameWindowClosedByUser(readStateDisk(statePath))).toBe(false);
      expect(await (await fetch(`http://127.0.0.1:${port}/api/window`)).json()).toMatchObject({ open: true, clients: 1 });

      ctrl.abort(); // user closes the window
      await new Promise((r) => setTimeout(r, 100));
      const disk = readStateDisk(statePath);
      expect(disk.gameWindow).toMatchObject({ open: false });
      expect(isGameWindowClosedByUser(disk)).toBe(true);

      // no auto-open; the prompt-start hook asks the agent to stream a reopen link instead
      expect(shouldOpenArcadeWindow({ displayMode: 'window', harness: 'antigravity', isPromptStart: true, windowClosedByUser: true })).toBe(false);
      const out: any = buildHookStdout('pre-invocation', { harness: 'antigravity', displayMode: 'window', invocationNum: 0 }, { isPromptStart: true, windowClosedByUser: true, port: 4777 });
      expect(out.injectSteps[0].ephemeralMessage).toContain('[▶ Reopen Model Invaders](http://127.0.0.1:4777/open)');
      const open = await fetch(`http://127.0.0.1:${port}/open`, { redirect: 'manual' });
      expect(open.status).toBe(302);
      expect(open.headers.get('location')).toBe('/?scope=global');
      // window still open -> no reopen bar
      expect(buildHookStdout('pre-invocation', { harness: 'antigravity', displayMode: 'window', invocationNum: 0 }, { isPromptStart: true, windowClosedByUser: false })).toEqual({});
    } finally {
      srv.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('side pane shows the global list with conversation:// links and does not count as the game window', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
    expect(html).toContain('const IN_PANE =');
    expect(html).toContain('conversation://${it.id}');
    expect(html).toContain("'?scope=global&host=pane'");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-pane-'));
    const statePath = path.join(dir, 'state.json');
    const srv = createArcadeServer({ statePath });
    await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
    const port = (srv.server.address() as any).port;
    const ctrl = new AbortController();
    try {
      await fetch(`http://127.0.0.1:${port}/events?scope=global&host=pane`, { signal: ctrl.signal });
      await new Promise((r) => setTimeout(r, 50));
      expect(await (await fetch(`http://127.0.0.1:${port}/api/window`)).json()).toMatchObject({ open: false, clients: 0 });
    } finally {
      ctrl.abort();
      srv.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a second server instance (Antigravity-managed side pane) sees hook updates and acks via the shared state file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-multi-'));
    const statePath = path.join(dir, 'state.json');
    const hookSrv = createArcadeServer({ statePath });
    const paneSrv = createArcadeServer({ statePath });
    await new Promise<void>((r) => paneSrv.server.listen(0, '127.0.0.1', () => r()));
    const port = (paneSrv.server.address() as any).port;
    try {
      hookSrv.updateState({ sessionId: 'a', state: 'THINKING', event: 'PreInvocation' });
      hookSrv.updateState({ sessionId: 'b', state: 'IDLE', event: 'Stop', lastUserInput: 'done one' });
      let st: any = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
      expect(st.state).toBe('IDLE');
      expect(st.attention.map((x: any) => x.id)).toEqual(['b']);
      await new Promise((r) => setTimeout(r, 5));
      await fetch(`http://127.0.0.1:${port}/api/ack`, { method: 'POST' }); // Keep playing from the pane
      hookSrv.updateState({ sessionId: 'a', state: 'TOOL_RUNNING', event: 'PreToolUse' });
      st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
      expect(st.state).toBe('TOOL_RUNNING');
      expect(st.attention).toEqual([]);
    } finally {
      paneSrv.server.close();
      hookSrv.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
