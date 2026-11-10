# `thinking-arcade` — Model Invaders

A small Space Invaders game that **plays while your coding agents are working** and **pauses when any conversation needs you**. A **Needs you** list under the game shows which conversations are waiting (finished, asking a question, or needing approval), with links back to each one.

Works with **Google Antigravity**, **Claude Code**, and **OpenAI Codex CLI**.

## How it works

| Piece | File | Role |
| :--- | :--- | :--- |
| Hooks | `hooks.json` → `scripts/hook-handler.mjs` | Turn lifecycle events into states: prompt start → `THINKING`, tool call → `TOOL_RUNNING`, permission prompt → `WAITING_FOR_APPROVAL`, turn end → `IDLE`. |
| Sidecar | `sidecars/arcade-daemon/sidecar.json` → `scripts/arcade-server.mjs` | Zero-dependency HTTP + SSE server on `127.0.0.1:4777`. Aggregates every conversation active in the last 30 minutes; state and scores live in `~/.config/agent-skills/thinking-arcade-state.json`. |
| Game | `ui/index.html` | Canvas game. Move with `←`/`→` or the mouse, fire with `Space` or click. Each tool call spawns a bonus UFO labeled with the tool name. |

**Pause and resume**
- The game pauses when a conversation finishes a turn, asks a question, or waits for approval.
- **Keep playing** (Enter) dismisses finished turns so you can play while other conversations work. Questions and approvals stay paused until answered.
- A new prompt resumes play automatically. Antigravity has no prompt-submit hook, so resume happens on the first model call of the turn, which can lag up to about a minute while a long conversation is compacted.

## Install

### Antigravity

```bash
# From a clone of this repo
ln -sfn "$(pwd)/plugins/thinking-arcade" ~/.gemini/config/plugins/thinking-arcade
```

Restart Antigravity. On each new prompt the agent shows a **▶ Open Model Invaders** link; click it to open the game in the right pane. Each **Needs you** row there links to its conversation. The pane belongs to one chat, so it closes when you switch chats.

Change where the game appears with `display_mode` (global, or per workspace in `.agents/thinking-arcade.json`):

```bash
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode <mode>
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs flags   # show resolved flags
```

| Mode | Behavior |
| :--- | :--- |
| `auxiliary` *(default)* | Link that opens the game in the right pane. |
| `window` | One shared app window, opened by the hook on prompt start. If you close it, the agent shows a reopen link instead of reopening it. |
| `inline` / `inline-follow` | Game embedded in chat on the first turn / on every turn. |
| `both` | Right-pane link plus inline embed. |
| `off` | Nothing shown; the server still runs at `http://127.0.0.1:4777`. |

### Claude Code

```bash
claude plugin marketplace add davenportjw/agent-skills
claude plugin install thinking-arcade@davenportjw-agent-skills
```

Or print hook config for `~/.claude/settings.json`:

```bash
node plugins/thinking-arcade/scripts/arcade-cli.mjs claude-config
```

Then open `http://127.0.0.1:4777/?scope=global` in a browser.

### Codex CLI

Print hook config for `~/.codex/hooks.json`:

```bash
node plugins/thinking-arcade/scripts/arcade-cli.mjs codex-config
```

With `codex app-server`, post `turn/started` as `{"state":"THINKING","harness":"codex"}` and `turn/completed` as `{"state":"IDLE","harness":"codex"}` to `POST /api/event`.

## HTTP API (`127.0.0.1:4777`)

| Endpoint | Purpose |
| :--- | :--- |
| `GET /` | Game (`?scope=global` for all conversations) |
| `GET /events` | SSE state stream |
| `GET /api/status` | Current state, including `active`, `attention`, `waiting` |
| `POST /api/event`, `POST /api/score` | State updates from hooks; score sync |
| `POST /api/ack` | Keep playing |
| `POST /api/focus` | Bring Antigravity to the front (macOS; override with `THINKING_ARCADE_FOCUS_APP`) |
| `GET /api/window`, `GET /open` | Window open/closed; reopen the game |

## Development

```bash
cd plugins/thinking-arcade
npm test   # vitest; run npm install in plugins/ast-graph first
```
