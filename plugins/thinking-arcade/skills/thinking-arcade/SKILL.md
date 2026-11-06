---
name: thinking-arcade
description: Launches, inspects, and configures the Thinking Arcade (Model Invaders) session-gated sidecar game across Google Antigravity, Claude Code, and OpenAI Codex CLI. Activate when the user wants to play Model Invaders while the agent thinks, check the sidecar server on 127.0.0.1:4777, simulate lifecycle transitions, or configure hooks for Claude Code and Codex.
---

# Thinking Arcade (`thinking-arcade`) Skill

**Thinking Arcade (Model Invaders)** is a Space Invaders-inspired sidecar game where you pilot the **Context Guardian** ship (`ast_symbol` laser) against descending waves of LLM failure modes (`HALLUCIN`, `500_LOOP`, `CTX_DRIFT`, `RAW_GREP`, and bonus `SUBAGENT` UFOs).

Crucially, the game is **session-gated by agent lifecycle hooks**:
- **Unlocks & Renders (`THINKING` / `TOOL_RUNNING`)**: Immediately when the agent begins reasoning (`PreInvocation` / `UserPromptSubmit`) or executes a tool (`PreToolUse`).
- **Pauses for Human Input (`WAITING_FOR_APPROVAL`)**: When a tool call requires permission confirmation (`PermissionRequest` / `Notification: permission_prompt`).
- **Freezes & Checkpoints Score (`IDLE`)**: The instant the turn completes (`Stop` with `fullyIdle: true`, or `turn/completed`).

---

## 1. Quick Commands (`arcade-cli.mjs`)

Run the bundled CLI to start the daemon, check live state, or simulate hook transitions:

```bash
# Ensure the sidecar server is running on http://127.0.0.1:4777
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs start

# Inspect current session state, high score, and recent hook history
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs status

# Simulate lifecycle transitions (thinking | tool | approval | idle)
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs simulate thinking "Planning multi-file refactor"
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs simulate tool "ast_blast_radius"
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs simulate idle "Turn complete"
```

---

## 2. Option Flags (`display_mode`: Inline vs. Right Auxiliary Pane)

`thinking-arcade` supports a 4-tier option flag system (`THINKING_ARCADE_FLAGS` env var → `<workspace>/.agents/thinking-arcade.json` → `~/.config/agent-skills/thinking-arcade.json` → `defaults.json`):

| Flag | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `display_mode` | `enum` (`window` \| `auxiliary` \| `inline` \| `inline-follow` \| `both` \| `off`) | `"window"` | Controls where Model Invaders auto-mounts: **`window`** *(default; one shared app window for all conversations, raised by the hook on each new prompt with no click and no agent tool calls; plays while every live conversation is working, pauses and refocuses Antigravity when any conversation finishes or asks a question; Enter = keep playing via `POST /api/ack`; a **Needs you** list under the game shows waiting conversations, and its **Open ↗** button (`POST /api/focus`) brings Antigravity to the front; if you close the window it is not reopened automatically; the agent streams a `▶ Reopen Model Invaders` link to `/open` instead, and `GET /api/window` reports open/closed)*, **`auxiliary`** *( shows a one-click `▶ Open Model Invaders` pill that opens the Right Auxiliary Pane, where the game stays docked while chat scrolls; the pane cannot open without a click)*, **`inline`** *(embeds `<agent-embed>` inline on turn 1)*, **`inline-follow`** *(re-pins `<agent-embed>` at the bottom of the response on every turn with full score/wave/lives carry-over)*, **`both`**, or **`off`**. |
| `spawn_ufo_on_tool_use` | `boolean` | `true` | Spawns a bonus 100-pt Subagent UFO labeled with the active tool name whenever `PreToolUse` fires. |
| `keep_alive_on_subagents` | `boolean` | `false` | When `false` *(default)*, always stops the game immediately on `Stop`. When `true`, keeps the game unlocked if background subagents are still running (`fullyIdle === false`). |
| `banner_user_markdown` | `boolean` | `false` | *Experimental.* Sends the SessionStart banner as `systemMessage.metadata.user_markdown` so the `▶ Open Model Invaders` pill renders inline and always visible instead of inside a collapsed **Hook Json SessionStart** row. Some Antigravity builds drop the whole hook result when `metadata` is present; if no banner appears, run `arcade-cli.mjs set banner_user_markdown false`. |

```bash
# Switch between Right Auxiliary Pane (default), bottom-following inline embed, or one-time inline:
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode auxiliary
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode inline-follow
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode inline
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode both
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode off

# Set per-workspace or inspect all resolved flags:
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs mode auxiliary --workspace .
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs flags
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs set spawn_ufo_on_tool_use false
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs reset
```

---

## 3. Running in Claude Code & Claude Desktop

Claude Code (`claude`) and OpenAI Codex (`codex`) have large plugin and hook ecosystems. `thinking-arcade` natively parses their `stdin` hook payloads (`hook_event_name`, `session_id`, `tool_name`).

### Option A: Install via the Claude Code Plugin Marketplace
Because `thinking-arcade` is registered in `.claude-plugin/marketplace.json`, Claude Code users can install it directly:

```bash
claude plugin marketplace add davenportjw/agent-skills
claude plugin install thinking-arcade@davenportjw-agent-skills
```

### Option B: Wire `~/.claude/settings.json` Hooks Directly
Generate the exact JSON configuration for `~/.claude/settings.json`:

```bash
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs claude-config
```

In **Claude Desktop**, you can also expose `http://127.0.0.1:4777` as an **MCP App (`SEP-1865`)** using a `ui://thinking-arcade/invaders` resource URI so the game renders inside Claude Desktop's side panel and reacts to `UserPromptSubmit` and `Stop` hooks over SSE.

---

## 4. Running in OpenAI Codex CLI (`~/.codex/hooks.json`)

OpenAI Codex CLI supports command hooks in `~/.codex/hooks.json` (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`) as well as JSON-RPC streaming notifications (`turn/started`, `item/reasoning/textDelta`, `turn/completed`).

Generate the `~/.codex/hooks.json` configuration snippet:

```bash
node ~/.gemini/config/plugins/thinking-arcade/scripts/arcade-cli.mjs codex-config
```
