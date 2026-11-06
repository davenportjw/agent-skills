#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STATE_PATH, PLUGIN_ROOT, UI_INDEX_PATH, readStateDisk, writeStateDisk } from './arcade-server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_SCRIPT = path.join(__dirname, 'arcade-server.mjs');
export const DEFAULTS_PATH = path.join(PLUGIN_ROOT, 'defaults.json');
export const GLOBAL_FLAGS_PATH = path.join(
  os.homedir(),
  '.config',
  'agent-skills',
  'thinking-arcade.json',
);

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function coerceArcadeFlagValue(rawValue, schema = {}) {
  const type = schema.type || 'string';
  if (type === 'boolean') {
    if (typeof rawValue === 'boolean') return { valid: true, value: rawValue };
    if (typeof rawValue === 'number') return { valid: true, value: rawValue !== 0 };
    if (typeof rawValue === 'string') {
      const norm = rawValue.trim().toLowerCase();
      if (['true', '1', 'on', 'yes', 'enabled'].includes(norm)) return { valid: true, value: true };
      if (['false', '0', 'off', 'no', 'disabled'].includes(norm)) return { valid: true, value: false };
    }
    return { valid: false, value: schema.value };
  }
  if (type === 'enum') {
    const str = String(rawValue ?? '').trim().toLowerCase();
    const options = Array.isArray(schema.options) ? schema.options : [];
    if (options.includes(str)) return { valid: true, value: str };
    return { valid: false, value: schema.value };
  }
  return { valid: true, value: String(rawValue ?? '') };
}

export function parseArcadeEnvOverrides(envStr = '') {
  const out = {};
  if (!envStr || typeof envStr !== 'string') return out;
  for (const part of envStr.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const eqIdx = token.indexOf('=');
    if (eqIdx === -1) {
      if (token.startsWith('no-') || token.startsWith('!')) {
        out[token.replace(/^(no-|!)/, '').trim()] = 'false';
      } else if (['window', 'inline', 'inline-follow', 'auxiliary', 'both', 'off'].includes(token.toLowerCase())) {
        out.display_mode = token.toLowerCase();
      } else {
        out[token] = 'true';
      }
    } else {
      const k = token.slice(0, eqIdx).trim();
      const v = token.slice(eqIdx + 1).trim();
      if (k) out[k] = v;
    }
  }
  return out;
}

/**
 * display_mode=window: opens Model Invaders in a standalone, chromeless app window (Chrome --app) on macOS,
 * falling back to the default browser. Detached + unref'd so the hook never blocks.
 * Returns the command that was launched (for tests / diagnostics).
 */
export function openArcadeWindow(url, options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const platform = options.platform || process.platform;
  const chromeApp = options.chromeApp || '/Applications/Google Chrome.app';
  const hasChrome = options.hasChrome !== undefined ? options.hasChrome : fs.existsSync(chromeApp);
  let cmd;
  let args;
  if (platform === 'darwin' && hasChrome) {
    // Chrome hands `open -na` off to its running process, which creates the window WITHOUT activating Chrome,
    // so it lands behind Antigravity. Also, occluded windows get their timers throttled, so poll-based
    // "client active" checks are unreliable. Instead: look for an existing window for this session via
    // AppleScript; raise it if found, otherwise open a new --app window; then bring it to the front.
    const marker = String(options.sessionMarker || url).replace(/["\\]/g, '');
    const raise =
      `tell application "Google Chrome"\n` +
      `  set found to false\n` +
      `  repeat with w in windows\n` +
      `    if (URL of active tab of w) contains "${marker}" then\n` +
      `      set index of w to 1\n` +
      `      set found to true\n` +
      `      exit repeat\n` +
      `    end if\n` +
      `  end repeat\n` +
      `  if found then activate\n` +
      `  return found\n` +
      `end tell`;
    const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const script =
      `r=$(osascript -e ${q(raise)} 2>/dev/null); ` +
      `if [ "$r" != "true" ]; then ` +
      `open -na ${q(chromeApp)} --args ${q(`--app=${url}`)} --window-size=520,720; ` +
      `sleep 1.5; osascript -e ${q(raise)} >/dev/null 2>&1; fi`;
    cmd = '/bin/sh';
    args = ['-c', script];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
    child?.on?.('error', () => {});
    child?.unref?.();
  } catch {
    // never fail the hook because a window could not be opened
  }
  return { cmd, args };
}

/**
 * When a conversation needs the user (turn finished or ask_question), hand focus back to Antigravity,
 * but only if the game window is the frontmost window (never steal focus from other apps).
 */
export function focusAntigravityIfGameFront(options = {}) {
  const spawnFn = options.spawnFn || spawn;
  if ((options.platform || process.platform) !== 'darwin') return null;
  const script =
    `tell application "System Events" to set frontApp to name of first application process whose frontmost is true\n` +
    `if frontApp is "Google Chrome" then\n` +
    `  tell application "Google Chrome" to set u to URL of active tab of front window\n` +
    `  if u contains "127.0.0.1:" and u contains "scope=global" then tell application "Antigravity" to activate\n` +
    `end if`;
  try {
    const child = spawnFn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    child?.on?.('error', () => {});
    child?.unref?.();
  } catch {}
  return { cmd: 'osascript', script };
}

/** True when this event means a conversation now needs the user. */
export function isAttentionEvent(eventArg, transition = {}) {
  const ev = String(eventArg || '').toLowerCase();
  if (ev === 'stop') return true;
  if ((ev === 'pre-tool-use' || ev === 'pretooluse') && transition.detail === 'ask_question') return true;
  return false;
}

/** True when the hook should open the arcade window for this event. */
// clientActive is intentionally ignored: occluded Chrome windows throttle polling, and openArcadeWindow
// dedupes by raising an existing window for the session instead of opening a second one.
/** True when the shared game window was open and the user closed it (never auto-reopen then). */
export function isGameWindowClosedByUser(state = {}) {
  const gw = state && state.gameWindow;
  return Boolean(gw && gw.open === false && gw.closedAt);
}

export function shouldOpenArcadeWindow({ displayMode, harness, isPromptStart, windowClosedByUser = false }) {
  return displayMode === 'window' && harness === 'antigravity' && Boolean(isPromptStart) && !windowClosedByUser;
}

/**
 * Resolves Thinking Arcade option flags across 4 tiers:
 *   1. THINKING_ARCADE_FLAGS env var (e.g. "display_mode=auxiliary" or "auxiliary")
 *   2. Workspace override (<workspaceRoot>/.agents/thinking-arcade.json)
 *   3. Global user config (~/.config/agent-skills/thinking-arcade.json)
 *   4. Plugin defaults.json
 */
export function resolveArcadeFlags(options = {}) {
  const defaultsPath = options.defaultsPath || DEFAULTS_PATH;
  const globalConfigPath = options.globalConfigPath || GLOBAL_FLAGS_PATH;
  const workspaceRoot = options.workspaceRoot || '';
  const workspaceConfigPath =
    options.workspaceConfigPath ||
    (workspaceRoot ? path.join(workspaceRoot, '.agents', 'thinking-arcade.json') : '');
  const envString =
    options.envFlags !== undefined ? options.envFlags : process.env.THINKING_ARCADE_FLAGS || '';

  const defaultsDoc = readJsonSafe(defaultsPath) || { flags: {} };
  const schemaFlags = defaultsDoc.flags || {};

  const globalDoc = readJsonSafe(globalConfigPath);
  const globalFlags = (globalDoc && (globalDoc.flags || globalDoc)) || {};

  const workspaceDoc = workspaceConfigPath ? readJsonSafe(workspaceConfigPath) : null;
  const workspaceFlags = (workspaceDoc && (workspaceDoc.flags || workspaceDoc)) || {};

  const envFlags = parseArcadeEnvOverrides(envString);

  const values = {};
  const details = {};

  for (const [name, schema] of Object.entries(schemaFlags)) {
    let val = schema.value;
    let source = 'default';

    if (name in globalFlags) {
      const coerced = coerceArcadeFlagValue(globalFlags[name], schema);
      if (coerced.valid) {
        val = coerced.value;
        source = 'global';
      }
    }
    if (name in workspaceFlags) {
      const coerced = coerceArcadeFlagValue(workspaceFlags[name], schema);
      if (coerced.valid) {
        val = coerced.value;
        source = 'workspace';
      }
    }
    if (name in envFlags) {
      const coerced = coerceArcadeFlagValue(envFlags[name], schema);
      if (coerced.valid) {
        val = coerced.value;
        source = 'env';
      }
    }

    values[name] = val;
    details[name] = {
      name,
      type: schema.type || 'string',
      options: schema.options || null,
      defaultValue: schema.value,
      value: val,
      source,
      description: schema.description || '',
    };
  }

  return {
    values,
    details,
    paths: {
      defaultsPath,
      globalConfigPath,
      workspaceConfigPath: workspaceConfigPath || null,
    },
  };
}

export function setArcadeFlag(flagName, rawValue, options = {}) {
  const defaultsPath = options.defaultsPath || DEFAULTS_PATH;
  const defaultsDoc = readJsonSafe(defaultsPath) || { flags: {} };
  const schema = (defaultsDoc.flags || {})[flagName];
  if (!schema) {
    const known = Object.keys(defaultsDoc.flags || {}).join(', ');
    throw new Error(`Unknown Thinking Arcade flag "${flagName}". Available flags: ${known}`);
  }
  const coerced = coerceArcadeFlagValue(rawValue, schema);
  if (!coerced.valid) {
    const allowed = schema.options ? ` (${schema.options.join(' | ')})` : '';
    throw new Error(
      `Invalid value "${rawValue}" for flag "${flagName}" of type ${schema.type}${allowed}`,
    );
  }

  const scope = options.scope === 'workspace' ? 'workspace' : 'global';
  let targetPath = options.globalConfigPath || GLOBAL_FLAGS_PATH;
  if (scope === 'workspace') {
    const wsRoot = options.workspaceRoot || process.cwd();
    targetPath =
      options.workspaceConfigPath || path.join(wsRoot, '.agents', 'thinking-arcade.json');
  }

  const existing = readJsonSafe(targetPath) || { flags: {} };
  const nextFlags =
    existing.flags && typeof existing.flags === 'object' ? { ...existing.flags } : { ...existing };
  nextFlags[flagName] = coerced.value;

  writeJsonSafe(targetPath, { flags: nextFlags });
  return {
    flag: flagName,
    value: coerced.value,
    scope,
    configPath: targetPath,
  };
}

export function resetArcadeFlags(options = {}) {
  const scope = options.scope === 'workspace' ? 'workspace' : 'global';
  let targetPath = options.globalConfigPath || GLOBAL_FLAGS_PATH;
  if (scope === 'workspace') {
    const wsRoot = options.workspaceRoot || process.cwd();
    targetPath =
      options.workspaceConfigPath || path.join(wsRoot, '.agents', 'thinking-arcade.json');
  }
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }
  return { scope, configPath: targetPath };
}

/**
 * Normalizes hook stdin across Google Antigravity, Claude Code, and OpenAI Codex CLI.
 */
export function parseMultiHarnessHookStdin(rawStdin = '') {
  const trimmed = (rawStdin || '').trim();
  let payload = {};
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed;
      }
    } catch {
      payload = {};
    }
  }

  // Detect active harness
  let harness = 'antigravity';
  if (
    typeof payload.hook_event_name === 'string' ||
    typeof payload.session_id === 'string' ||
    typeof payload.transcript_path === 'string'
  ) {
    harness = payload.codex_version || payload.turn_id ? 'codex' : 'claude-code';
  } else if (typeof payload.turnId === 'string' || typeof payload.threadId === 'string') {
    harness = 'codex';
  }

  const toolCall = payload.toolCall && typeof payload.toolCall === 'object' ? payload.toolCall : null;
  const toolName =
    (typeof toolCall?.name === 'string' ? toolCall.name : '') ||
    (typeof payload.tool_name === 'string' ? payload.tool_name : '') ||
    (typeof payload.toolName === 'string' ? payload.toolName : '');

  const artifactDirectoryPath =
    typeof payload.artifactDirectoryPath === 'string' ? payload.artifactDirectoryPath.trim() : '';

  const sessionId =
    (typeof payload.conversationId === 'string' ? payload.conversationId.trim() : '') ||
    (typeof payload.session_id === 'string' ? payload.session_id.trim() : '') ||
    (typeof payload.threadId === 'string' ? payload.threadId.trim() : '') ||
    (artifactDirectoryPath ? path.basename(artifactDirectoryPath) : '');

  const workspaceRoot =
    (Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === 'string'
      ? payload.workspacePaths[0].trim()
      : '') ||
    (typeof payload.cwd === 'string' ? payload.cwd.trim() : '');

  // Antigravity Stop hook passes `fullyIdle` (false if background tasks or subagents are still running!)
  const fullyIdle = payload.fullyIdle !== undefined ? Boolean(payload.fullyIdle) : true;
  const terminationReason =
    typeof payload.terminationReason === 'string' ? payload.terminationReason : '';
  const initialNumSteps =
    typeof payload.initialNumSteps === 'number' ? payload.initialNumSteps : undefined;
  const invocationNum =
    typeof payload.invocationNum === 'number'
      ? payload.invocationNum
      : initialNumSteps !== undefined
        ? 0
        : undefined;
  const stepIdx = typeof payload.stepIdx === 'number' ? payload.stepIdx : undefined;
  const lastUserInput =
    typeof payload.lastUserInput === 'string' ? payload.lastUserInput : undefined;

  return {
    harness,
    sessionId,
    toolName,
    artifactDirectoryPath,
    workspaceRoot,
    fullyIdle,
    terminationReason,
    invocationNum,
    initialNumSteps,
    stepIdx,
    lastUserInput,
    payload,
  };
}

/**
 * Maps a lifecycle hook event into the target Thinking Arcade session state:
 *   - 'THINKING'
 *   - 'TOOL_RUNNING'
 *   - 'WAITING_FOR_APPROVAL'
 *   - 'IDLE'
 */
export function computeArcadeTransition(eventArg = '', rawStdin = '', flagOptions = {}) {
  const info = parseMultiHarnessHookStdin(rawStdin);
  const resolved = resolveArcadeFlags({
    ...flagOptions,
    workspaceRoot: flagOptions.workspaceRoot ?? info.workspaceRoot,
  });
  const flags = resolved.values;
  const ev = (eventArg || info.payload.hook_event_name || '').toLowerCase().trim();

  let state = 'THINKING';
  let eventLabel = eventArg || 'PreInvocation';
  let detail = info.toolName || '';

  if (ev === 'session-start' || ev === 'sessionstart') {
    state = 'IDLE';
    eventLabel = 'SessionStart';
    detail = 'Sidecar initialized';
  } else if (
    ev === 'pre-invocation' ||
    ev === 'preinvocation' ||
    ev === 'user-prompt-submit' ||
    ev === 'userpromptsubmit' ||
    ev === 'turn-started'
  ) {
    state = 'THINKING';
    eventLabel =
      info.harness === 'claude-code' || info.harness === 'codex'
        ? 'UserPromptSubmit'
        : 'PreInvocation';
    detail = 'Agent reasoning active';
  } else if (ev === 'pre-tool-use' || ev === 'pretooluse') {
    state = 'TOOL_RUNNING';
    eventLabel = 'PreToolUse';
    detail = info.toolName || 'tool_call';
  } else if (ev === 'post-tool-use' || ev === 'posttooluse') {
    state = 'THINKING';
    eventLabel = 'PostToolUse';
    detail = info.toolName ? `completed ${info.toolName}` : 'resuming reasoning';
  } else if (
    ev === 'permission-request' ||
    ev === 'permissionrequest' ||
    ev === 'notification'
  ) {
    state = 'WAITING_FOR_APPROVAL';
    eventLabel = 'PermissionRequest';
    detail = 'Waiting for user confirmation';
  } else if (ev === 'stop' || ev === 'subagent-stop' || ev === 'turn-completed') {
    // By default (keep_alive_on_subagents === false), always stop the game immediately when the response is done.
    // If the user explicitly enabled keep_alive_on_subagents === true and fullyIdle is false, keep it running.
    if (info.fullyIdle === false && flags.keep_alive_on_subagents === true) {
      state = 'THINKING';
      eventLabel = 'Stop (Subagents Running)';
      detail = 'Background tasks still active';
    } else {
      state = 'IDLE';
      eventLabel = 'Stop';
      detail = info.terminationReason || 'Turn complete';
    }
  }

  return {
    state,
    event: eventLabel,
    harness: info.harness,
    sessionId: info.sessionId,
    detail,
    artifactDirectoryPath: info.artifactDirectoryPath,
    workspaceRoot: info.workspaceRoot,
    fullyIdle: info.fullyIdle,
    invocationNum: info.invocationNum,
    initialNumSteps: info.initialNumSteps,
    stepIdx: info.stepIdx,
    lastUserInput: info.lastUserInput,
    displayMode: flags.display_mode || 'inline',
    spawnUfoOnToolUse: flags.spawn_ufo_on_tool_use !== false,
  };
}

/**
 * Copies the self-contained Model Invaders HTML AND its .metadata.json sidecar
 * into the conversation's artifact directory so Antigravity immediately registers
 * and displays it in the Right Auxiliary Pane (Artifacts tab).
 *
 * Only rewrites the HTML file on boundary transitions (newlyCreated, IDLE -> THINKING on turn start,
 * or Stop -> IDLE) so mid-turn PreToolUse/PostToolUse hooks never reload the iframe mid-wave.
 */
export function syncArtifactIfPresent(artifactDirectoryPath = '', transition = null, options = {}) {
  if (!artifactDirectoryPath) return { dest: null, newlyCreated: false };
  try {
    fs.mkdirSync(artifactDirectoryPath, { recursive: true });
    const dest = path.join(artifactDirectoryPath, 'model_invaders_arcade.html');
    const metaDest = `${dest}.metadata.json`;
    let alreadyInjected = false;
    if (fs.existsSync(metaDest)) {
      try {
        const prevMeta = JSON.parse(fs.readFileSync(metaDest, 'utf8'));
        alreadyInjected = Boolean(prevMeta && prevMeta.embedPromptInjected === true);
      } catch {
        alreadyInjected = false;
      }
    }

    const shouldRewriteHtml =
      !alreadyInjected ||
      !fs.existsSync(dest) ||
      options.forceWrite === true;

    if (shouldRewriteHtml) {
      let html = fs.readFileSync(UI_INDEX_PATH, 'utf8');
      if (transition && typeof transition === 'object') {
        const disk = readStateDisk();
        const statePayload = JSON.stringify({
          state: transition.state || 'THINKING',
          lastEvent: transition.event || 'PreInvocation',
          harness: transition.harness || 'antigravity',
          sessionId: transition.sessionId || path.basename(artifactDirectoryPath),
          detail: transition.detail || '',
          score: disk.score || 0,
          highScore: disk.highScore || 0,
          wave: disk.wave || 1,
          lives: disk.lives !== undefined ? disk.lives : 3,
          updatedAt: new Date().toISOString(),
        });
        html = html.replace(
          /\/\*__ARCADE_STATE_START__\*\/[\s\S]*?\/\*__ARCADE_STATE_END__\*\//,
          `/*__ARCADE_STATE_START__*/${statePayload}/*__ARCADE_STATE_END__*/`,
        );
      }
      fs.writeFileSync(dest, html, 'utf8');

      const metaPayload = {
        summary:
          'Live Model Invaders (Thinking Arcade) Space Invaders sidecar game wired via SSE to 127.0.0.1:4777. Pilot the Context Guardian ship against descending waves of HALLUCIN, 500_LOOP, CTX_DRIFT, RAW_GREP, and bonus SUBAGENT UFOs while the agent is thinking or executing tools.',
        updatedAt: new Date().toISOString(),
        userFacing: true,
        embedPromptInjected: true,
      };
      fs.writeFileSync(metaDest, JSON.stringify(metaPayload, null, 2) + '\n', 'utf8');
    }

    return { dest, newlyCreated: !alreadyInjected };
  } catch {
    return { dest: null, newlyCreated: false };
  }
}

/**
 * Builds the stdout JSON response expected by the calling agent harness.
 */
export function buildHookStdout(eventArg = '', transition = {}, options = {}) {
  const ev = (eventArg || '').toLowerCase().trim();
  const port = options.port || Number(process.env.THINKING_ARCADE_PORT || 4777);
  const displayMode = (
    options.displayMode ||
    transition.displayMode ||
    resolveArcadeFlags({ workspaceRoot: transition.workspaceRoot }).values.display_mode ||
    'inline'
  ).toLowerCase();

  const artifactFile = transition.artifactDirectoryPath
    ? path.join(transition.artifactDirectoryPath, 'model_invaders_arcade.html')
    : '';
  const embedBlock = artifactFile
    ? `\n\n<agent-embed src="file://${artifactFile}"></agent-embed>`
    : '';

  // 1. SessionStart: Inject a zero-context-pollution systemMessage banner in Antigravity (unless display_mode is 'off')
  //    NOTE: By default never populate `systemMessage.metadata` (map<string, string>): some language_server builds'
  //    dropUnsupportedFields panic on map values and discard the entire hook result. The opt-in
  //    `banner_user_markdown` flag sends the documented `metadata.user_markdown` for SessionStart only.
  if (ev === 'session-start' || ev === 'sessionstart') {
    if (transition.harness === 'antigravity' && displayMode !== 'off') {
      const bannerUserMarkdown =
        options.bannerUserMarkdown !== undefined
          ? options.bannerUserMarkdown
          : resolveArcadeFlags({ workspaceRoot: transition.workspaceRoot }).values.banner_user_markdown === true;
      const bannerText = `👾 **Thinking Arcade** — [▶ Open Model Invaders](sidecar://thinking-arcade/arcade-daemon/) · [http://127.0.0.1:${port}](http://127.0.0.1:${port}) (\`display_mode=${displayMode}\`) — unpauses automatically while the agent is thinking.${displayMode === 'inline' || displayMode === 'both' ? embedBlock : ''}`;
      if (bannerUserMarkdown) {
        // Experimental (flag `banner_user_markdown`): documented user_markdown renders inline + always visible
        // and is never read by the model. Some builds panic on map<string,string> metadata and drop the result.
        return {
          injectSteps: [
            {
              systemMessage: {
                systemMessage: `Thinking Arcade sidecar active (display_mode=${displayMode}).`,
                metadata: { user_markdown: bannerText },
              },
            },
          ],
        };
      }
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: bannerText,
            },
          },
        ],
      };
    }
    return {};
  }

  // 1b. PreInvocation: Mount the UI according to `display_mode`:
  //       - 'auxiliary' (default): at prompt start, instruct the agent to stream the sidecar:// pill before any tool call (click opens the Right Auxiliary Pane); no artifact edits
  //       - 'inline': instruct the agent on turn 1 (newlyCreated) to render `<agent-embed>` inline in chat
  //       - 'inline-follow': instruct the agent on every user prompt to re-pin `<agent-embed>` at the bottom of the latest response
  //       - 'both': instruct the agent to do both
  //       - 'window': no injected steps; main() opens a standalone app window on prompt start
  //       - 'off': do not inject any UI steps
  const isFollowMode = displayMode === 'inline-follow';
  const isPromptStart =
    options.isPromptStart !== undefined
      ? Boolean(options.isPromptStart)
      : transition.invocationNum !== undefined
        ? transition.invocationNum === 0
        : Boolean(options.newlyCreated);
  const shouldTriggerMount =
    displayMode === 'inline'
      ? Boolean(options.newlyCreated || isPromptStart)
      : isFollowMode || displayMode === 'auxiliary' || displayMode === 'both'
        ? isPromptStart
        : false;

  // window mode: the user closed the game window -> offer a one-click reopen bar instead of reopening it
  if (
    (ev === 'pre-invocation' || ev === 'preinvocation') &&
    transition.harness === 'antigravity' &&
    displayMode === 'window' &&
    isPromptStart &&
    options.windowClosedByUser
  ) {
    return {
      injectSteps: [
        {
          ephemeralMessage: `[THINKING_ARCADE display_mode=window window=closed]: The user closed the Model Invaders window, so it was NOT reopened. In your VERY FIRST model turn, BEFORE any tool call, output this exact markdown link as standalone preamble text (not in a code block): [▶ Reopen Model Invaders](http://127.0.0.1:${port}/open) — Do not make any tool call for the game, do not repeat the link in your final reply, and never claim the game is open.`,
        },
      ],
    };
  }

  if (
    (ev === 'pre-invocation' || ev === 'preinvocation') &&
    transition.harness === 'antigravity' &&
    displayMode !== 'off' &&
    shouldTriggerMount &&
    options.injectOnFirstPreInvocation !== false
  ) {
    const injectSteps = [];

    if (artifactFile) {
      if (displayMode === 'inline') {
        injectSteps.push({
          ephemeralMessage: `[THINKING_ARCADE display_mode=inline]: The Model Invaders artifact is already synced at ${artifactFile}. Include <agent-embed src="file://${artifactFile}"></agent-embed> at the top of your response so the user can play Model Invaders inline in chat while you work (do NOT call write_file on it).`,
        });
      } else if (displayMode === 'inline-follow') {
        injectSteps.push({
          ephemeralMessage: `[THINKING_ARCADE display_mode=inline-follow]: Re-pin the Model Invaders arcade at the very bottom of this response by including <agent-embed src="file://${artifactFile}"></agent-embed> at the end of your reply (do NOT call write_file on it; state is already synced).`,
        });
      } else if (displayMode === 'auxiliary' && isPromptStart && !options.clientActive) {
        injectSteps.push({
          // The pill is preamble text emitted BEFORE any tool call (final-reply text only renders after all work
          // completes). No artifact edit: the pill opens the sidecar view directly, and edit_file on the artifact
          // never opened the pane; it only added a no-op tool call that pollutes transcripts.
          ephemeralMessage: `[THINKING_ARCADE display_mode=auxiliary]: In your VERY FIRST model turn, BEFORE making any tool call, output this exact markdown link as standalone preamble text (not in a code block) so it streams to the user immediately while you work: [▶ Open Model Invaders](sidecar://thinking-arcade/arcade-daemon/) — clicking this pill opens the Right Auxiliary Pane. Do NOT call edit_file/write_file on any Model Invaders artifact or make any other tool call for the game; hooks manage it fully. Do NOT defer the link to your final reply and do not repeat it there. The pane does NOT open automatically, so never claim it is already open. Do NOT include <agent-embed> inline in your chat response.`,
        });
      } else if (displayMode === 'both' && isPromptStart) {
        injectSteps.push({
          ephemeralMessage: `[THINKING_ARCADE display_mode=both]: BEFORE any tool call, output the markdown link [▶ Open Model Invaders](sidecar://thinking-arcade/arcade-daemon/) (clicking it opens the Right Auxiliary Pane; do NOT edit or write any Model Invaders artifact) AND include <agent-embed src="file://${artifactFile}"></agent-embed> inline in your response.`,
        });
      }
    }

    return injectSteps.length > 0 ? { injectSteps } : {};
  }

  // 2. PreToolUse: Always allow the tool to proceed without interference
  if (ev === 'pre-tool-use' || ev === 'pretooluse') {
    if (transition.harness === 'antigravity') {
      return { decision: 'allow' };
    }
    return {};
  }

  // 3. Stop: Allow normal termination
  if (ev === 'stop') {
    if (transition.harness === 'antigravity') {
      return { decision: 'allow' };
    }
    return {};
  }

  return {};
}

/**
 * Posts the state transition to the running sidecar HTTP daemon (or spawns it if not running).
 */
export async function notifySidecarDaemon(transition, options = {}) {
  const port = options.port || Number(process.env.THINKING_ARCADE_PORT || 4777);
  const host = options.host || '127.0.0.1';
  const statePath = options.statePath || DEFAULT_STATE_PATH;

  // Always update the disk state immediately so state is consistent even before HTTP completes
  const disk = readStateDisk(statePath);
  const nowIso = new Date().toISOString();
  const nextSessions = { ...(disk.sessions || {}) };
  if (transition.sessionId) {
    const prevSess = nextSessions[transition.sessionId] || {};
    nextSessions[transition.sessionId] = {
      ...prevSess,
      state: transition.state,
      lastEvent: transition.event,
      detail: transition.detail,
      artifactDirectoryPath:
        transition.artifactDirectoryPath || prevSess.artifactDirectoryPath || '',
      lastUserInput:
        transition.lastUserInput !== undefined
          ? transition.lastUserInput
          : prevSess.lastUserInput,
      lastToolStepIdx:
        typeof transition.stepIdx === 'number'
          ? transition.stepIdx
          : prevSess.lastToolStepIdx,
      workspaceRoot: transition.workspaceRoot || prevSess.workspaceRoot || '',
      updatedAt: nowIso,
    };
  }
  const updated = {
    ...disk,
    state: transition.state,
    lastEvent: transition.event,
    harness: transition.harness,
    detail: transition.detail,
    artifactDirectoryPath: transition.artifactDirectoryPath || disk.artifactDirectoryPath || '',
    sessions: nextSessions,
    // A new prompt means the user is back in Antigravity: dismiss turns that finished before now.
    attentionAckAt: transition.ackAttention ? Date.now() : disk.attentionAckAt || 0,
    updatedAt: nowIso,
    history: [
      ...(disk.history || []),
      {
        ts: nowIso,
        state: transition.state,
        event: transition.event,
        harness: transition.harness,
        sessionId: transition.sessionId || '',
        detail: transition.detail,
      },
    ].slice(-25),
  };
  writeStateDisk(updated, statePath);

  const postOnce = () =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(transition);
      const req = http.request(
        {
          hostname: host,
          port,
          path: '/api/event',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 350,
        },
        res => {
          res.resume();
          resolve(true);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      req.write(body);
      req.end();
    });

  try {
    await postOnce();
    return { notified: true, spawned: false };
  } catch {
    if (options.autoSpawn !== false) {
      try {
        const child = spawn(process.execPath, [SERVER_SCRIPT], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, THINKING_ARCADE_PORT: String(port) },
        });
        child.unref();
      } catch {
        // Ignore spawn failure
      }
    }
    return { notified: false, spawned: options.autoSpawn !== false };
  }
}

/**
 * True when a PreInvocation starts a new user turn. `invocationNum === 0` alone is not reliable
 * (it is not always reset per prompt), so a changed `lastUserInput` or a previously idle session
 * also counts. Prompt starts auto-acknowledge finished conversations so the game resumes.
 */
export function isPromptStartEvent(eventArg, transition, prevSession = {}, prevSessionState = 'IDLE') {
  const evNorm = String(eventArg || '').toLowerCase();
  if (evNorm !== 'pre-invocation' && evNorm !== 'preinvocation') return false;
  if (transition.invocationNum === 0) return true;
  if (prevSessionState === 'IDLE') return true;
  return (
    typeof transition.lastUserInput === 'string' &&
    transition.lastUserInput !== '' &&
    transition.lastUserInput !== prevSession.lastUserInput
  );
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
if (isMain) {
  const eventArg = process.argv[2] || 'pre-invocation';
  let rawStdin = '';
  try {
    rawStdin = fs.readFileSync(0, 'utf8');
  } catch {
    rawStdin = '';
  }

  const transition = computeArcadeTransition(eventArg, rawStdin);
  const disk = readStateDisk();
  const sessionArtifactDir =
    transition.sessionId && disk.sessions?.[transition.sessionId]?.artifactDirectoryPath
      ? disk.sessions[transition.sessionId].artifactDirectoryPath
      : '';
  const effectiveArtifactDir =
    transition.artifactDirectoryPath || sessionArtifactDir || '';
  if (effectiveArtifactDir && !transition.artifactDirectoryPath) {
    transition.artifactDirectoryPath = effectiveArtifactDir;
  }
  if (!transition.sessionId && effectiveArtifactDir) {
    transition.sessionId = path.basename(effectiveArtifactDir);
  }
  const prevSession =
    (transition.sessionId && disk.sessions?.[transition.sessionId]) || {};
  const prevSessionState = prevSession.state || disk.state || 'IDLE';
  const evNorm = eventArg.toLowerCase();
  const isPromptStart = isPromptStartEvent(eventArg, transition, prevSession, prevSessionState);
  const clientActive = Boolean(
    prevSession.lastClientPollAt &&
      Date.now() - Number(prevSession.lastClientPollAt) < 4000,
  );

  let newlyCreated = false;
  if (effectiveArtifactDir) {
    const syncRes = syncArtifactIfPresent(effectiveArtifactDir, transition, {
      forceWrite: false,
    });
    newlyCreated = Boolean(syncRes?.newlyCreated);
  }
  if (isPromptStart) transition.ackAttention = true;
  const windowClosedByUser = isGameWindowClosedByUser(disk);
  const stdoutPayload = buildHookStdout(eventArg, transition, {
    newlyCreated,
    isPromptStart,
    clientActive,
    windowClosedByUser,
  });

  const resolvedDisplayMode =
    transition.displayMode ||
    resolveArcadeFlags({ workspaceRoot: transition.workspaceRoot }).values.display_mode ||
    'window';
  if (
    shouldOpenArcadeWindow({
      displayMode: resolvedDisplayMode,
      harness: transition.harness,
      isPromptStart,
      clientActive,
      windowClosedByUser,
    })
  ) {
    // One global window shared by every conversation (state aggregated across sessions by the daemon).
    const port = Number(process.env.THINKING_ARCADE_PORT || 4777);
    openArcadeWindow(`http://127.0.0.1:${port}/?scope=global`, { sessionMarker: 'scope=global' });
  }
  if (resolvedDisplayMode === 'window' && transition.harness === 'antigravity' && isAttentionEvent(eventArg, transition)) {
    focusAntigravityIfGameFront();
  }

  notifySidecarDaemon(transition).finally(() => {
    process.stdout.write(JSON.stringify(stdoutPayload) + '\n');
  });
}
