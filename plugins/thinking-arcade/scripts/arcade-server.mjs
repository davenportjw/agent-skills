#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PLUGIN_ROOT = path.resolve(__dirname, '..');
export const UI_INDEX_PATH = path.join(PLUGIN_ROOT, 'ui', 'index.html');
/** macOS app activated by POST /api/focus (override with THINKING_ARCADE_FOCUS_APP). */
export const FOCUS_APP_NAME = process.env.THINKING_ARCADE_FOCUS_APP || 'Antigravity';
export const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  '.config',
  'agent-skills',
  'thinking-arcade-state.json',
);

/**
 * Safely reads JSON from disk; returns fallback if missing or malformed.
 */
export function readStateDisk(statePath = DEFAULT_STATE_PATH) {
  try {
    if (!fs.existsSync(statePath)) {
      return {
        state: 'IDLE',
        lastEvent: 'init',
        harness: 'antigravity',
        detail: '',
        score: 0,
        highScore: 0,
        wave: 1,
        lives: 3,
        updatedAt: new Date().toISOString(),
        history: [],
      };
    }
    const raw = fs.readFileSync(statePath, 'utf8').trim();
    if (!raw) throw new Error('empty');
    const parsed = JSON.parse(raw);
    return {
      state: parsed.state || 'IDLE',
      lastEvent: parsed.lastEvent || 'init',
      harness: parsed.harness || 'antigravity',
      sessionId: parsed.sessionId || '',
      detail: parsed.detail || '',
      artifactDirectoryPath: parsed.artifactDirectoryPath || '',
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      score: Number(parsed.score) || 0,
      highScore: Number(parsed.highScore) || 0,
      wave: Number(parsed.wave) || 1,
      lives: parsed.lives !== undefined ? Number(parsed.lives) : 3,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      history: Array.isArray(parsed.history) ? parsed.history.slice(-25) : [],
      // Cross-session "keep playing" ack; must survive every hook/daemon read-modify-write cycle
      attentionAckAt: Number(parsed.attentionAckAt) || 0,
      // Shared game window lifecycle ({ open, clients, openedAt, closedAt }); written by the daemon only
      gameWindow: parsed.gameWindow && typeof parsed.gameWindow === 'object' ? parsed.gameWindow : null,
    };
  } catch {
    return {
      state: 'IDLE',
      lastEvent: 'init',
      harness: 'antigravity',
      detail: '',
      score: 0,
      highScore: 0,
      wave: 1,
      lives: 3,
      updatedAt: new Date().toISOString(),
      history: [],
    };
  }
}

/**
 * Persists sidecar state & high score to disk.
 */
export function writeStateDisk(nextState, statePath = DEFAULT_STATE_PATH) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2) + '\n', 'utf8');
  } catch {
    // Ignore read-only filesystem errors in restricted sandboxes
  }
  return nextState;
}

/**
 * Creates the Thinking Arcade HTTP + SSE sidecar server instance.
 */
/**
 * Cross-session aggregation for the single global game window (display_mode=window).
 * - attention: a conversation finished its turn (Stop) after the last ack, is asking the user a question
 *   (ask_question tool running), or is waiting for approval.
 * - active: a conversation is thinking or running tools.
 * Game plays only while at least one conversation is active and none needs attention.
 * Sessions not updated within `windowMs` are ignored (stale/abandoned).
 */
export function computeGlobalState(sessions = {}, options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? 30 * 60 * 1000;
  const ackAt = Number(options.ackAt) || 0;
  const active = [];
  const attention = [];
  const waiting = [];
  let latest = 0;
  let anyTool = false;
  for (const [id, sess] of Object.entries(sessions || {})) {
    if (!sess) continue;
    const t = Date.parse(sess.updatedAt || '') || 0;
    if (!t || now - t > windowMs) continue;
    latest = Math.max(latest, t);
    const asking = sess.state === 'TOOL_RUNNING' && sess.detail === 'ask_question';
    const approval = sess.state === 'WAITING_FOR_APPROVAL';
    const doneTurn = sess.state === 'IDLE' && sess.lastEvent === 'Stop';
    const finished = doneTurn && t > ackAt;
    if (asking || approval || doneTurn) {
      const item = {
        id,
        reason: asking ? 'question' : approval ? 'approval' : 'finished',
        lastUserInput: String(sess.lastUserInput || '').slice(0, 80),
        workspace: sess.workspaceRoot ? path.basename(sess.workspaceRoot) : '',
        updatedAt: sess.updatedAt,
        dismissed: !(asking || approval || finished),
      };
      // `waiting` lists every conversation awaiting the user (incl. dismissed finished turns);
      // only un-dismissed items in `attention` pause the game.
      waiting.push(item);
      if (!item.dismissed) attention.push(item);
    } else if (sess.state === 'THINKING' || sess.state === 'TOOL_RUNNING') {
      active.push(id);
      if (sess.state === 'TOOL_RUNNING') anyTool = true;
    }
  }
  const byRecent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
  attention.sort(byRecent);
  waiting.sort(byRecent);
  const state = attention.length ? 'IDLE' : active.length ? (anyTool ? 'TOOL_RUNNING' : 'THINKING') : 'IDLE';
  const detail = attention.length
    ? `${attention.length} conversation${attention.length > 1 ? 's' : ''} waiting for you`
    : active.length
      ? `${active.length} conversation${active.length > 1 ? 's' : ''} in progress`
      : 'All conversations idle';
  return {
    state,
    detail,
    active,
    attention,
    waiting,
    updatedAt: latest ? new Date(Math.max(latest, ackAt)).toISOString() : '',
  };
}

/** Payload for global-scope clients: top-level state/detail become the cross-session aggregate. */
export function withGlobalState(cur, options = {}) {
  const g = computeGlobalState(cur.sessions, { ...options, ackAt: cur.attentionAckAt });
  return {
    ...cur,
    scope: 'global',
    state: g.state,
    detail: g.detail,
    lastEvent: g.attention.length ? 'Stop' : cur.lastEvent,
    updatedAt: g.updatedAt || cur.updatedAt,
    global: g,
    active: g.active,
    attention: g.attention,
    waiting: g.waiting,
  };
}

export function createArcadeServer(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  let current = readStateDisk(statePath);
  // Global game window = open SSE connections from `/?scope=global` pages. A previous daemon's
  // connections are gone, so an "open" record from disk is reset to unknown (not user-closed).
  const windowClients = new Set();
  if (current.gameWindow && current.gameWindow.open) {
    current = { ...current, gameWindow: { ...current.gameWindow, open: false, clients: 0, closedAt: null } };
    writeStateDisk(current, statePath);
  }
  function setGameWindow(open) {
    const disk = readStateDisk(statePath);
    const nowIso = new Date().toISOString();
    const prev = current.gameWindow || disk.gameWindow || {};
    const gameWindow = open
      ? { open: true, clients: windowClients.size, openedAt: prev.open ? prev.openedAt : nowIso, closedAt: null }
      : { open: false, clients: 0, openedAt: prev.openedAt || null, closedAt: nowIso };
    current = { ...disk, ...current, sessions: { ...(current.sessions || {}), ...(disk.sessions || {}) }, gameWindow };
    writeStateDisk(current, statePath);
  }
  const sseClients = new Set();

  // The state file is the source of truth shared by every server instance. Antigravity runs its own copy of this
  // server for the side pane (on a port it assigns), which never receives hook POSTs; without re-reading the file
  // that instance served a frozen snapshot (no cross-session updates, "Keep playing" never reflected).
  function refreshFromDisk() {
    const disk = readStateDisk(statePath);
    current = {
      ...current,
      ...disk,
      sessions: { ...(current.sessions || {}), ...(disk.sessions || {}) },
      attentionAckAt: Math.max(Number(disk.attentionAckAt) || 0, Number(current.attentionAckAt) || 0),
      gameWindow: disk.gameWindow || current.gameWindow || null,
    };
    return current;
  }
  let lastDiskMtime = 0;
  const diskWatch = setInterval(() => {
    try {
      const m = fs.statSync(statePath).mtimeMs;
      if (m !== lastDiskMtime) {
        lastDiskMtime = m;
        broadcast(refreshFromDisk());
      }
    } catch { /* state file not created yet */ }
  }, 500);
  diskWatch.unref?.();

  function broadcast(payload) {
    const frame = `data: ${JSON.stringify(withGlobalState(payload))}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function markClientPoll(reqSessionId) {
    if (!reqSessionId) return;
    const nowMs = Date.now();
    current.sessions = current.sessions || {};
    const prevSess = current.sessions[reqSessionId] || {};
    const prevPoll = Number(prevSess.lastClientPollAt) || 0;
    current.sessions[reqSessionId] = {
      ...prevSess,
      lastClientPollAt: nowMs,
    };
    if (nowMs - prevPoll > 1200) {
      const disk = readStateDisk(statePath);
      disk.sessions = disk.sessions || {};
      disk.sessions[reqSessionId] = {
        ...(disk.sessions[reqSessionId] || {}),
        ...current.sessions[reqSessionId],
        lastClientPollAt: nowMs,
      };
      writeStateDisk(disk, statePath);
    }
  }

  function updateState(patch = {}) {
    const disk = readStateDisk(statePath);
    const nextScore = typeof patch.score === 'number' ? patch.score : (disk.score || current.score);
    const nextHigh = Math.max(
      disk.highScore || current.highScore || 0,
      typeof patch.highScore === 'number' ? patch.highScore : 0,
      nextScore,
    );
    const isScoreOnly = !patch.state && !patch.event && !patch.lastEvent;
    const nowIso = new Date().toISOString();
    const entry = {
      ts: nowIso,
      state: patch.state || disk.state || current.state,
      event: patch.event || patch.lastEvent || disk.lastEvent || current.lastEvent,
      harness: patch.harness || disk.harness || current.harness,
      sessionId: patch.sessionId || disk.sessionId || current.sessionId || '',
      detail: patch.detail ?? disk.detail ?? current.detail,
    };
    const history = isScoreOnly
      ? disk.history || current.history || []
      : [...(disk.history || current.history || []), entry].slice(-25);

    const nextSessions = { ...(current.sessions || {}), ...(disk.sessions || {}) };
    if (patch.sessionId) {
      const prevSess = nextSessions[patch.sessionId] || {};
      nextSessions[patch.sessionId] = {
        ...prevSess,
        state: patch.state || prevSess.state || entry.state,
        lastEvent: patch.event || patch.lastEvent || prevSess.lastEvent || entry.event,
        detail: patch.detail !== undefined ? patch.detail : prevSess.detail,
        artifactDirectoryPath:
          patch.artifactDirectoryPath || prevSess.artifactDirectoryPath || '',
        lastUserInput:
          patch.lastUserInput !== undefined ? patch.lastUserInput : prevSess.lastUserInput,
        lastToolStepIdx:
          typeof patch.stepIdx === 'number' ? patch.stepIdx : prevSess.lastToolStepIdx,
        workspaceRoot: patch.workspaceRoot || prevSess.workspaceRoot || '',
        updatedAt: isScoreOnly ? prevSess.updatedAt || nowIso : nowIso,
      };
    }

    const { ackAttention, ...patchRest } = patch;
    current = {
      ...disk,
      ...current,
      ...patchRest,
      attentionAckAt: ackAttention
        ? Date.now()
        : Math.max(Number(disk.attentionAckAt) || 0, Number(current.attentionAckAt) || 0),
      state: entry.state,
      sessions: nextSessions,
      lastEvent: entry.event,
      score: nextScore,
      highScore: nextHigh,
      updatedAt: isScoreOnly ? disk.updatedAt || current.updatedAt || nowIso : nowIso,
      history,
    };
    writeStateDisk(current, statePath);
    broadcast(current);
    return current;
  }

  const requestHandler = (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    // CORS headers for local webviews / artifacts
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'thinking-arcade', state: current.state }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      refreshFromDisk();
      const reqSessionId = url.searchParams.get('sessionId') || '';
      if (reqSessionId) markClientPoll(reqSessionId);
      const sessionOverride =
        reqSessionId && current.sessions && current.sessions[reqSessionId]
          ? current.sessions[reqSessionId]
          : null;
      const payload = sessionOverride
        ? {
            ...current,
            sessionId: reqSessionId,
            state: sessionOverride.state || current.state,
            lastEvent: sessionOverride.lastEvent || current.lastEvent,
            detail: sessionOverride.detail ?? current.detail,
            updatedAt: sessionOverride.updatedAt || current.updatedAt,
          }
        : withGlobalState(current);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state.svg') {
      const reqSessionId = url.searchParams.get('sessionId') || '';
      if (reqSessionId) markClientPoll(reqSessionId);
      const sessionOverride =
        reqSessionId && current.sessions && current.sessions[reqSessionId]
          ? current.sessions[reqSessionId]
          : null;
      const activeState = sessionOverride ? sessionOverride.state : current.state;
      const widthMap = {
        IDLE: 1,
        THINKING: 2,
        TOOL_RUNNING: 3,
        WAITING_FOR_APPROVAL: 4,
      };
      const w = widthMap[activeState] || 1;
      const h = Math.max(1, Math.min(9999, Number(current.highScore) || 1));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="none"/></svg>`;
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(svg);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(withGlobalState(current))}\n\n`);
      sseClients.add(res);
      // Only the standalone window counts; the Antigravity side pane (host=pane) must not suppress the reopen bar
      // or make the hook try to raise a Chrome window that does not exist.
      const isGameWindow = url.searchParams.get('scope') === 'global' && url.searchParams.get('host') !== 'pane';
      if (isGameWindow) {
        windowClients.add(res);
        setGameWindow(true);
      }
      req.on('close', () => {
        sseClients.delete(res);
        if (isGameWindow && windowClients.delete(res) && windowClients.size === 0) setGameWindow(false);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/window') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...(current.gameWindow || { open: false, closedAt: null }), clients: windowClients.size }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/open') {
      // "Reopen" bar link in chat (shown only after the user closed the game window).
      res.writeHead(302, { Location: '/?scope=global' });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/focus') {
      // "Open" link from the waiting-conversations list: bring Antigravity to the front.
      // Antigravity exposes no per-conversation deep link, so this activates the app only.
      if (process.platform !== 'darwin') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'focus is only supported on macOS' }));
        return;
      }
      execFile('open', ['-a', FOCUS_APP_NAME], (err) => {
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err ? { ok: false, error: String(err.message || err) } : { ok: true, app: FOCUS_APP_NAME }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ack') {
      // "Keep playing": dismiss finished-turn attention up to now (questions/approvals stay until answered)
      const disk = readStateDisk(statePath);
      const ackIso = new Date().toISOString();
      current = { ...disk, ...current, sessions: { ...(current.sessions || {}), ...(disk.sessions || {}) }, attentionAckAt: Date.now(), updatedAt: ackIso };
      writeStateDisk(current, statePath);
      broadcast(current);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, global: withGlobalState(current).global }));
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/api/event' || url.pathname === '/api/score')) {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          parsed = {};
        }
        const status = updateState(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status }));
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/preload.js') {
      const sdkPreload = path.join(
        os.homedir(),
        '.gemini',
        'antigravity',
        'lib',
        'node_modules',
        'sidecar_sdk',
        'preload.js',
      );
      let js = `window.sidecar = window.sidecar || { ui: { toggleAuxPane(r) { window.parent.postMessage({ type: 'toggle-aux-pane', payload: r }, '*'); } } };`;
      try {
        if (fs.existsSync(sdkPreload)) {
          js = fs.readFileSync(sdkPreload, 'utf8');
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(js);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/_sidecar/get-conversation-metadata') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: '' } } } }));
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const html = fs.readFileSync(UI_INDEX_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Failed to load UI: ${err.message}`);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  };

  const server = http.createServer(requestHandler);

  // Sync external state file changes (from hook-handler.mjs) so any sidecar web port instance broadcasts SSE immediately
  const diskSyncTimer = setInterval(() => {
    try {
      const disk = readStateDisk(statePath);
      if (disk.updatedAt && disk.updatedAt !== current.updatedAt) {
        current = disk;
        broadcast(current);
      }
    } catch {}
  }, 250);
  if (typeof diskSyncTimer.unref === 'function') {
    diskSyncTimer.unref();
  }

  server.on('close', () => clearInterval(diskWatch));
  return { server, requestHandler, updateState, getState: () => current };
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
if (isMain) {
  const port = Number(process.env.THINKING_ARCADE_PORT || 4777);
  const sidecarWebPort = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
  const host = process.env.THINKING_ARCADE_HOST || '127.0.0.1';
  const { server, requestHandler } = createArcadeServer();

  // If Antigravity injected ANTIGRAVITY_SIDECAR_WEB_PORT for the native Aux Pane UI, always bind it
  if (sidecarWebPort && sidecarWebPort !== port) {
    const webServer = http.createServer(requestHandler);
    webServer.on('error', err => {
      console.error('[thinking-arcade] Aux Pane Web UI server error:', err);
    });
    webServer.listen(sidecarWebPort, host, () => {
      console.log(
        `[thinking-arcade] Antigravity Aux Pane Web UI listening on http://${host}:${sidecarWebPort}`,
      );
    });
  }

  server.on('error', err => {
    if (err && err.code === 'EADDRINUSE') {
      // If ANTIGRAVITY_SIDECAR_WEB_PORT is bound in this process, stay alive for the Aux Pane UI!
      if (sidecarWebPort && sidecarWebPort !== port) {
        return;
      }
      process.exit(0);
    }
    console.error('[thinking-arcade] Server error:', err);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`[thinking-arcade] Model Invaders sidecar listening on http://${host}:${port}`);
  });
}
