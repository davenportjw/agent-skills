# `thinking-arcade` Plugin (Model Invaders Sidecar)

`plugins/thinking-arcade` is a cross-harness reference plugin that turns agent wait time into a **session-gated Space Invaders sidecar game ("Model Invaders")**. The game **only renders and unpauses while the agent is actively thinking or executing tools**, and automatically blurs, pauses, and saves your high score the moment the turn ends or blocks on human permission.

## Architecture: Hooks + Sidecar Daemon + SSE Canvas

| Layer | Component | Role |
| :--- | :--- | :--- |
| **1. Lifecycle Gate** | `hooks.json` (`scripts/hook-handler.mjs`) | Intercepts `SessionStart`, `PreInvocation` / `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, and `Stop` across Antigravity, Claude Code, and Codex CLI. |
| **2. Managed Sidecar** | `sidecars/arcade-daemon/sidecar.json` (`scripts/arcade-server.mjs`) | Zero-dependency Node HTTP + SSE server on `127.0.0.1:4777` that broadcasts real-time state (`THINKING`, `TOOL_RUNNING`, `WAITING_FOR_APPROVAL`, `IDLE`) and persists scores to `~/.config/agent-skills/thinking-arcade-state.json`. |
| **3. Game Canvas** | `ui/index.html` | HTML5 Canvas Space Invaders game where you pilot the **Context Guardian** (`ast_symbol` laser) against `HALLUCIN`, `500_LOOP`, `CTX_DRIFT`, `RAW_GREP`, and bonus `SUBAGENT` UFOs spawned on live `PreToolUse` events. |

## Cross-Session Behavior

- **One global game window** (`/?scope=global`, the default `window` mode) aggregates every live conversation: it plays while any conversation is working and pauses as soon as one needs you (turn finished, `ask_question`, or a permission prompt).
- **Needs you** list under the game shows each waiting conversation. In the window, **Open ↗** focuses Antigravity (`POST /api/focus`, override the app with `THINKING_ARCADE_FOCUS_APP`) and copies the prompt; in the Right Auxiliary Pane each row is a `conversation://<id>` link that jumps to that chat.
- **Keep playing** (`POST /api/ack`) dismisses the current waiting set and resumes play; a new prompt also auto-acknowledges.
- **Close detection**: the window is tracked over SSE. After you close it the hook does not reopen it; instead the agent prints a `▶ Reopen Model Invaders` link (`GET /open`).
- **Multi-instance sync**: every server instance (the CLI daemon and the Antigravity-managed pane copy) re-reads the shared state file, so all views stay consistent.

## HTTP API (`127.0.0.1:4777`)

| Method & Path | Purpose |
| :--- | :--- |
| `GET /events?scope=global` | SSE stream of aggregate state (includes `waiting`). |
| `GET /api/status` | Current state snapshot. |
| `POST /api/ack` | Keep playing — acknowledge waiting conversations. |
| `POST /api/focus` | Bring the agent app to the front. |
| `GET /api/window` | Whether the game window is open. |
| `GET /open` | Redirect to the global game window. |

## Multi-Marketplace Installation (Antigravity, Claude Code, OpenAI Codex)

### 1. Google Antigravity (`agy`)
```bash
ln -sfn "$(pwd)/plugins/thinking-arcade" ~/.gemini/config/plugins/thinking-arcade
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs start

# Where the game renders (window [default] | auxiliary | inline | inline-follow | both | off):
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode window
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode auxiliary
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs flags
```

### 2. Claude Code & Claude Desktop (`claude`)
Install directly from the repository's `.claude-plugin/marketplace.json`:
```bash
claude plugin marketplace add davenportjw/agent-skills
claude plugin install thinking-arcade@davenportjw-agent-skills
```
Or output the `~/.claude/settings.json` hook configuration (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification: permission_prompt`, `Stop`):
```bash
node plugins/thinking-arcade/scripts/arcade-cli.mjs claude-config
```

### 3. OpenAI Codex CLI (`codex`)
Output the `~/.codex/hooks.json` configuration (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`):
```bash
node plugins/thinking-arcade/scripts/arcade-cli.mjs codex-config
```
