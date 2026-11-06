# `feature-flags` — Runtime Feature Flags Plugin for Antigravity & Claude Code

A reference plugin demonstrating how to build **mid-session, zero-restart feature flags** inside the Antigravity Plugin Spec by combining **Option 2 (`hooks.json` lifecycle hooks)** with **Option 1 (hierarchical external JSON state + companion CLI/skill)**.

## Why This Pattern Works

In the Antigravity Plugin Spec, `plugin.json` is an all-or-nothing bundle toggle (`"disabled": true | false`). To give users granular feature flags that switch agent behavior, gate tools, or rewrite tool arguments on the fly without restarting the IDE:

1. **Workspace-Aware State Resolution (`stdin` `workspacePaths[0]`)**:
   Hook commands execute with their working directory set to the **plugin directory**, not the user's repository. `scripts/hook-handler.mjs` reads `workspacePaths[0]` (Antigravity) or `cwd` (Claude Code) from `stdin` and resolves flags across 4 tiers:
   - `AGY_PLUGIN_FLAGS` environment variable (`highest`)
   - `<workspace>/.agents/feature-flags.json` (project/team scope)
   - `~/.config/agent-skills/feature-flags.json` (user global scope)
   - `defaults.json` (`lowest`)
2. **Zero Transcript Bloat (`PreInvocation` `ephemeralMessage`)**:
   Emitting `systemMessage` inside `PreInvocation` appends a permanent message to the conversation transcript on every turn. Instead, `hook-handler.mjs` emits `systemMessage` only once at `SessionStart`, and uses transient `ephemeralMessage` steps on `PreInvocation`—so flag changes take effect on the very next turn with zero context bloat.
3. **Hard Tool Gating & Argument Rewriting (`PreToolUse`)**:
   - `read_only_mode=true` returns `{"decision": "deny"}` on file mutation tools (`write_file`, `edit_file`) while `PreInvocation` simultaneously tells the model not to call them.
   - `prod_deploy_guard` (`"allow" | "ask" | "deny"`) gates `run_command` calls matching `gcloud run deploy`, `terraform apply`, or `kubectl apply`.
   - `prefer_uv_pytest=true` uses `PreToolUse` `"overwrite"` to rewrite bare `pytest ...` commands into `uv run pytest ...`.

## Directory Layout

```text
plugins/feature-flags/
├── plugin.json                      # Plugin manifest (ships disabled: true as an example template)
├── defaults.json                    # Flag definitions, types, allowed enum options, and defaults
├── hooks.json                       # SessionStart, PreInvocation, and PreToolUse hook bindings
├── assets/logo.svg                  # Plugin icon
├── rules/AGENTS.md                  # Always-on rule when the plugin is enabled
├── skills/feature-flags/SKILL.md    # Companion skill for conversational flag management
├── scripts/
│   ├── hook-handler.mjs             # Fast (<10ms) zero-dependency ESM hook processor
│   └── flags-cli.mjs                # CLI to list, get, set, enable, disable, and reset flags
└── test/
    └── feature-flags.test.ts        # Automated Vitest suite covering all hook contracts & CLI
```

## Quick Usage

```bash
# View current flags for a workspace
node plugins/feature-flags/scripts/flags-cli.mjs list --workspace /path/to/repo

# Enable read_only_mode for a workspace
node plugins/feature-flags/scripts/flags-cli.mjs enable read_only_mode --workspace /path/to/repo

# Switch global release channel to experimental
node plugins/feature-flags/scripts/flags-cli.mjs set release_channel experimental --global

# Reset workspace overrides
node plugins/feature-flags/scripts/flags-cli.mjs reset --workspace /path/to/repo
```
