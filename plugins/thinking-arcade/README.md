# `thinking-arcade` — Session-Gated "Model Invaders" Sidecar Game

**Thinking Arcade (`thinking-arcade`)** is a Space Invaders-inspired sidecar game (**Model Invaders**) that **only renders and unpauses while your coding agent is actively thinking or running tools**, and automatically pauses, blurs, and checkpoints your score the moment the agent finishes its turn or waits for your approval.

Built as a cross-platform reference plugin for **Google Antigravity**, **Claude Code / Claude Desktop**, and **OpenAI Codex CLI**.

---

## How the Session Gate Works

Pure MCP Apps only render reactively when the LLM decides to invoke a tool, and have no built-in way to know when the agent finishes its turn. `thinking-arcade` solves this by combining three layers:

1. **Deterministic Lifecycle Hooks (`hooks.json` / `settings.json`)**:
   - **Start / Unlock (`THINKING`)**: Fires on `PreInvocation` (Antigravity) or `UserPromptSubmit` / `turn/started` (Claude Code & OpenAI Codex).
   - **Tool Execution (`TOOL_RUNNING` + Bonus UFO)**: Fires on `PreToolUse` and spawns a bonus **Subagent UFO** labeled with the active tool name (e.g., `ast_symbol`, `run_command`).
   - **Human Approval Pause (`WAITING_FOR_APPROVAL`)**: Fires on `PermissionRequest` / `Notification (permission_prompt)` so the game pauses and alerts you that the agent is blocked waiting for confirmation.
   - **Turn Complete (`IDLE`)**: Fires on `Stop` / `turn/completed`. In Antigravity, `hook-handler.mjs` inspects `fullyIdle: boolean` on `stdin`—so if background tasks or subagents are still running (`fullyIdle: false`), the game stays unlocked until all background work completes!
2. **Persistent Local Sidecar Server (`scripts/arcade-server.mjs` + `sidecar.json`)**:
   - Runs a zero-dependency Node HTTP + Server-Sent Events (`SSE`) daemon on `http://127.0.0.1:4777`.
   - Broadcasts sub-10ms state transitions over `/events` and persists high scores and wave progress to `~/.config/agent-skills/thinking-arcade-state.json`.
3. **Model Invaders Canvas (`ui/index.html`)**:
   - Pilot the **Context Guardian** ship (`←`/`→` or mouse to move, `SPACE` or click to fire `ast_symbol` lasers) against descending waves of LLM anti-patterns:
     - `HALLUCIN` (30 pts)
     - `500_LOOP` (25 pts)
     - `CTX_DRIFT` (20 pts)
     - `RAW_GREP` (10 pts)
     - Bonus `SUBAGENT` UFO (100 pts — spawns whenever the agent calls a tool!)

---

## Directory Structure

```text
plugins/thinking-arcade/
├── plugin.json                              # Antigravity & Claude plugin manifest
├── hooks.json                               # SessionStart, PreInvocation, PreToolUse, PostToolUse, Stop
├── sidecars/
│   └── arcade-daemon/
│       └── sidecar.json                     # Managed Antigravity sidecar daemon config (port 4777)
├── ui/
│   └── index.html                           # Self-contained Model Invaders HTML5 Canvas + SSE client
├── scripts/
│   ├── arcade-server.mjs                    # Zero-dependency HTTP + SSE state & high-score server
│   ├── hook-handler.mjs                     # Multi-harness stdin parser (Antigravity, Claude, Codex)
│   └── arcade-cli.mjs                       # CLI for status, state simulation, and config generation
├── rules/
│   └── AGENTS.md                            # Always-on rule when plugin is enabled
├── skills/
│   └── thinking-arcade/
│       └── SKILL.md                         # On-demand skill for managing & embedding the arcade
└── test/
    └── thinking-arcade.test.ts              # Automated Vitest suite covering hooks, SSE server & CLI
```

---

## Installation & Setup Across Ecosystems

### 1. Google Antigravity (`agy` / Antigravity 2.0 / Antigravity IDE)

Link the plugin into your global Antigravity plugins directory and enable the sidecar:

```bash
# From a clone of this repo
ln -sfn "$(pwd)/plugins/thinking-arcade" ~/.gemini/config/plugins/thinking-arcade

# Start or check the sidecar daemon immediately (Antigravity also starts it from sidecar.json)
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs start
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs status
```

Restart Antigravity after linking so the new plugin directory is discovered.

#### Display modes (`display_mode` flag)

| Mode | Behavior |
| :--- | :--- |
| **`window`** *(default)* | One shared game window for all conversations, opened and raised by the hook on prompt start. No click, no chat output, no agent tool calls. |
| **`auxiliary`** | The agent streams a `▶ Open Model Invaders` pill (`sidecar://thinking-arcade/arcade-daemon/`); clicking it opens the Right Auxiliary Pane. |
| **`inline`** / **`inline-follow`** | Embeds `<agent-embed src="file://.../model_invaders_arcade.html">` in chat on turn 1 / on every turn. |
| **`both`** | Pill plus inline embed. |
| **`off`** | No auto-mounting; the daemon still serves `http://127.0.0.1:4777`. |

#### Window mode (default)

- **One window, every conversation.** The hook opens `http://127.0.0.1:4777/?scope=global` as a chromeless Chrome app window (`--app`, falling back to the default browser) and, on later prompts, raises the existing window via AppleScript instead of opening a duplicate. The first run may trigger a macOS Automation permission prompt for Google Chrome.
- **Cross-session gate.** The daemon aggregates every conversation updated in the last 30 minutes (`computeGlobalState` in `arcade-server.mjs`). The game **plays while every live conversation is working** and **pauses when any conversation needs you**: a finished turn, a pending `ask_question`, or an approval. On those events the hook hands focus back to Antigravity, but only if the game window is frontmost.
- **Keep playing.** A new prompt in any conversation dismisses turns that finished before it. Otherwise press **Enter** / **▶ Keep playing** (`POST /api/ack`, persisted as `attentionAckAt`) to keep playing while other conversations work. Pending questions and approvals stay paused until answered.
- **Needs you list.** Below the game, every conversation waiting on you is listed with its reason, last prompt, workspace, and age (`waiting` in the global payload; dismissed finished turns are dimmed). In the window, **Open ↗** (`POST /api/focus`) brings Antigravity to the front (`THINKING_ARCADE_FOCUS_APP` overrides the app name) and copies the prompt to the clipboard, because there is no documented per-conversation deep link for external windows.
- **Closing is respected.** The daemon tracks the window through its live connection (`/events?scope=global`; `gameWindow` in state, `GET /api/window`). After you close it, prompts don't reopen it; the agent streams a **▶ Reopen Model Invaders** link to `http://127.0.0.1:4777/open` instead. Reopening restores auto-raise.

#### Right Auxiliary Pane

Opened from the `▶ Open Model Invaders` pill, the pane shows the same cross-conversation view, and each **Needs you** row is a `conversation://<id>` link (**Go to chat →**) that switches Antigravity to that conversation. Antigravity scopes the pane to the current conversation, so it closes when you switch and needs a click to reopen. The pane connects with `host=pane` and never counts as the game window. Antigravity runs its own copy of `arcade-server.mjs` for the pane; every copy re-reads the shared state file, so all views stay in sync.

#### Session banner

On `SessionStart` the hook returns a `systemMessage` (never with `metadata`, which makes Antigravity drop the hook result) containing the `▶ Open Model Invaders` pill. It renders as a collapsible **Hook Json SessionStart** block.

```bash
# Switch display_mode globally (~/.config/agent-skills/thinking-arcade.json) or per-workspace (.agents/thinking-arcade.json)
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode window
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode inline
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode auxiliary
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode both
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode off

# Inspect all resolved option flags
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs flags
```

---

### 2. Claude Code & Claude Desktop (`claude`)

Claude Code and Claude Desktop represent one of the largest developer marketplaces for hooks and MCP Apps. `thinking-arcade` supports both **Claude Code Plugin Marketplace installation** and **direct `~/.claude/settings.json` hook wiring**.

#### Option A: Install via Claude Code Plugin Marketplace
```bash
claude plugin marketplace add davenportjw/agent-skills
claude plugin install thinking-arcade@davenportjw-agent-skills
```

#### Option B: Add Lifecycle Hooks to `~/.claude/settings.json`
Run `node plugins/thinking-arcade/scripts/arcade-cli.mjs claude-config` to generate the exact hook configuration for `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" session-start" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" user-prompt-submit" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" pre-tool-use" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" post-tool-use" }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" permission-request" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" stop" }
        ]
      }
    ]
  }
}
```

- **How it works in Claude Code / Desktop**: The moment you submit a prompt (`UserPromptSubmit`), `hook-handler.mjs` auto-spawns the sidecar daemon (if not already running) and broadcasts `state: "THINKING"` to `http://127.0.0.1:4777`. When Claude asks for tool permission (`Notification: permission_prompt`), the game auto-pauses with an approval banner. When Claude finishes (`Stop`), the game freezes and saves your high score.

---

### 3. OpenAI Codex CLI (`codex`)

OpenAI Codex CLI supports two integration modes:

#### Mode 1: Command Hooks (`~/.codex/hooks.json`)
Run `node plugins/thinking-arcade/scripts/arcade-cli.mjs codex-config` to generate the `~/.codex/hooks.json` configuration covering `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, and `Stop`:

```json
{
  "hooks": {
    "SessionStart": [
      { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" session-start" }
    ],
    "UserPromptSubmit": [
      { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" user-prompt-submit" }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" pre-tool-use" }
        ]
      }
    ],
    "PermissionRequest": [
      { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" permission-request" }
    ],
    "Stop": [
      { "type": "command", "command": "node \"/path/to/plugins/thinking-arcade/scripts/hook-handler.mjs\" stop" }
    ]
  }
}
```

#### Mode 2: JSON-RPC Streaming (`codex app-server`)
When running Codex in stateful JSON-RPC mode, forward `turn/started` and `item/reasoning/textDelta` notifications to `POST http://127.0.0.1:4777/api/event` with `{"state": "THINKING", "harness": "codex"}`, and forward `turn/completed` with `{"state": "IDLE", "harness": "codex"}`.


---

## HTTP API (`127.0.0.1:4777`)

| Endpoint | Purpose |
| :--- | :--- |
| `GET /` | Game UI (`?scope=global` = cross-session window; `?sessionId=` = single conversation) |
| `GET /events` | SSE state stream (`?scope=global` marks the game window; `&host=pane` marks the side pane) |
| `GET /api/status` | Current state; without `sessionId` returns the global aggregate (`state`, `active`, `attention`, `waiting`) |
| `POST /api/event`, `POST /api/score` | State transitions from hooks / score sync |
| `POST /api/ack` | Keep playing: dismiss finished turns up to now |
| `POST /api/focus` | Bring Antigravity to the front (macOS) |
| `GET /api/window` | Game window open/closed |
| `GET /open` | Redirect to the global game (reopen link) |

## Development

```bash
cd plugins/thinking-arcade
npm test   # vitest (uses the ast-graph plugin's dev install: npm install in plugins/ast-graph first)
```
