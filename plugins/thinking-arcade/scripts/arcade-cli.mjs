#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STATE_PATH, PLUGIN_ROOT, readStateDisk } from './arcade-server.mjs';
import {
  notifySidecarDaemon,
  resetArcadeFlags,
  resolveArcadeFlags,
  setArcadeFlag,
} from './hook-handler.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_SCRIPT = path.join(__dirname, 'arcade-server.mjs');
const HOOK_SCRIPT = path.join(__dirname, 'hook-handler.mjs');

function getPort() {
  return Number(process.env.THINKING_ARCADE_PORT || 4777);
}

function fetchStatus(port = getPort()) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/api/status`, { timeout: 500 }, res => {
      let data = '';
      res.on('data', c => {
        data += c;
      });
      res.on('end', () => {
        try {
          resolve({ live: true, status: JSON.parse(data) });
        } catch {
          resolve({ live: false, status: readStateDisk() });
        }
      });
    });
    req.on('error', () => resolve({ live: false, status: readStateDisk() }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ live: false, status: readStateDisk() });
    });
  });
}

export function generateClaudeConfigSnippet(hookScriptPath = HOOK_SCRIPT) {
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hookScriptPath}" session-start`,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hookScriptPath}" user-prompt-submit`,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `node "${hookScriptPath}" pre-tool-use`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `node "${hookScriptPath}" post-tool-use`,
            },
          ],
        },
      ],
      Notification: [
        {
          matcher: 'permission_prompt',
          hooks: [
            {
              type: 'command',
              command: `node "${hookScriptPath}" permission-request`,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hookScriptPath}" stop`,
            },
          ],
        },
      ],
    },
  };
}

export function generateCodexConfigSnippet(hookScriptPath = HOOK_SCRIPT) {
  return {
    hooks: {
      SessionStart: [
        {
          type: 'command',
          command: `node "${hookScriptPath}" session-start`,
        },
      ],
      UserPromptSubmit: [
        {
          type: 'command',
          command: `node "${hookScriptPath}" user-prompt-submit`,
        },
      ],
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `node "${hookScriptPath}" pre-tool-use`,
            },
          ],
        },
      ],
      PermissionRequest: [
        {
          type: 'command',
          command: `node "${hookScriptPath}" permission-request`,
        },
      ],
      Stop: [
        {
          type: 'command',
          command: `node "${hookScriptPath}" stop`,
        },
      ],
    },
  };
}

function parseScopeFlags(args = []) {
  let scope = 'global';
  let workspaceRoot = process.cwd();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace' || a === '-w') {
      scope = 'workspace';
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        workspaceRoot = path.resolve(args[i + 1]);
        i++;
      }
    } else if (a === '--global' || a === '-g') {
      scope = 'global';
    } else {
      positional.push(a);
    }
  }
  return { scope, workspaceRoot, positional };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || 'status').toLowerCase();
  const port = getPort();

  if (cmd === 'start') {
    const check = await fetchStatus(port);
    if (check.live) {
      console.log(`Thinking Arcade sidecar is already running on http://127.0.0.1:${port}`);
      return;
    }
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, THINKING_ARCADE_PORT: String(port) },
    });
    child.unref();
    await new Promise(r => setTimeout(r, 350));
    const after = await fetchStatus(port);
    console.log(
      `Started Thinking Arcade sidecar on http://127.0.0.1:${port} (live=${after.live}, state=${after.status.state})`,
    );
    return;
  }

  if (cmd === 'status') {
    const { workspaceRoot } = parseScopeFlags(args.slice(1));
    const info = await fetchStatus(port);
    const resolvedFlags = resolveArcadeFlags({ workspaceRoot });
    console.log(
      JSON.stringify(
        {
          url: `http://127.0.0.1:${port}`,
          daemonLive: info.live,
          statePath: DEFAULT_STATE_PATH,
          flags: resolvedFlags.values,
          ...info.status,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === 'flags' || cmd === 'list') {
    const { workspaceRoot } = parseScopeFlags(args.slice(1));
    const resolved = resolveArcadeFlags({ workspaceRoot });
    console.log(JSON.stringify(resolved, null, 2));
    return;
  }

  if (cmd === 'mode') {
    const { scope, workspaceRoot, positional } = parseScopeFlags(args.slice(1));
    const targetMode = positional[0];
    if (!targetMode) {
      const resolved = resolveArcadeFlags({ workspaceRoot });
      console.log(
        `Current display_mode: ${resolved.values.display_mode} (source: ${resolved.details.display_mode?.source || 'default'})`,
      );
      return;
    }
    const res = setArcadeFlag('display_mode', targetMode, { scope, workspaceRoot });
    console.log(
      `Updated Thinking Arcade display_mode = "${res.value}" (${res.scope} -> ${res.configPath})`,
    );
    return;
  }

  if (cmd === 'get') {
    const { workspaceRoot, positional } = parseScopeFlags(args.slice(1));
    const flagName = positional[0];
    const resolved = resolveArcadeFlags({ workspaceRoot });
    if (!flagName || !(flagName in resolved.details)) {
      console.error(
        `Usage: arcade-cli.mjs get <${Object.keys(resolved.details).join('|')}>`,
      );
      process.exit(1);
    }
    console.log(JSON.stringify(resolved.details[flagName], null, 2));
    return;
  }

  if (cmd === 'set') {
    const { scope, workspaceRoot, positional } = parseScopeFlags(args.slice(1));
    const [flagName, rawValue] = positional;
    if (!flagName || rawValue === undefined) {
      console.error(
        'Usage: arcade-cli.mjs set <display_mode|spawn_ufo_on_tool_use|keep_alive_on_subagents> <value> [--global|--workspace [path]]',
      );
      process.exit(1);
    }
    const res = setArcadeFlag(flagName, rawValue, { scope, workspaceRoot });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'reset') {
    const { scope, workspaceRoot } = parseScopeFlags(args.slice(1));
    const res = resetArcadeFlags({ scope, workspaceRoot });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'simulate') {
    const rawState = (args[1] || 'thinking').toUpperCase();
    const detail = args.slice(2).join(' ') || 'CLI simulation';
    const stateMap = {
      THINKING: { state: 'THINKING', event: 'PreInvocation' },
      TOOL: { state: 'TOOL_RUNNING', event: 'PreToolUse' },
      TOOL_RUNNING: { state: 'TOOL_RUNNING', event: 'PreToolUse' },
      APPROVAL: { state: 'WAITING_FOR_APPROVAL', event: 'PermissionRequest' },
      WAITING_FOR_APPROVAL: { state: 'WAITING_FOR_APPROVAL', event: 'PermissionRequest' },
      IDLE: { state: 'IDLE', event: 'Stop' },
      STOP: { state: 'IDLE', event: 'Stop' },
    };
    const chosen = stateMap[rawState] || { state: 'THINKING', event: 'PreInvocation' };
    await notifySidecarDaemon({
      state: chosen.state,
      event: chosen.event,
      harness: 'cli',
      detail,
    });
    const info = await fetchStatus(port);
    console.log(
      `Transitioned Thinking Arcade -> ${info.status.state} (event=${info.status.lastEvent}, detail="${info.status.detail}")`,
    );
    return;
  }

  if (cmd === 'claude-config') {
    console.log(JSON.stringify(generateClaudeConfigSnippet(), null, 2));
    return;
  }

  if (cmd === 'codex-config') {
    console.log(JSON.stringify(generateCodexConfigSnippet(), null, 2));
    return;
  }

  console.log(`Usage: node scripts/arcade-cli.mjs <command>

Commands:
  start                        Ensure the Model Invaders sidecar daemon is running on 127.0.0.1:${port}
  status                       Show live sidecar daemon status, active session state, high score, and flags
  mode [inline|auxiliary|both|off] [--global|--workspace [path]]
                               Get or set where Model Invaders auto-renders (inline chat vs. Right Auxiliary Pane)
  flags [--workspace [path]]   List all Thinking Arcade option flags and resolution tiers
  get <flag>                   Inspect a single option flag and its active source
  set <flag> <value> [--global|--workspace [path]]
                               Set an option flag globally (~/.config/agent-skills/thinking-arcade.json) or per-workspace
  reset [--global|--workspace [path]]
                               Reset option flag overrides back to defaults.json
  simulate <thinking|tool|approval|idle> [detail]
                               Fire a simulated lifecycle transition to test the session gate
  claude-config                Output the ~/.claude/settings.json hook snippet for Claude Code
  codex-config                 Output the ~/.codex/hooks.json snippet for OpenAI Codex CLI
`);
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
if (isMain) {
  main();
}
