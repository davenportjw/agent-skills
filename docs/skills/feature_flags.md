# `feature-flags` Plugin

In the Antigravity Plugin Spec, a plugin (`plugin.json`) is an all-or-nothing unit: enabling it loads all bundled skills, rules, hooks, and MCP servers at once.

`plugins/feature-flags` is a reference plugin showing how to give users **granular, mid-session feature flags** by combining **Lifecycle Hooks (`hooks.json`)** with a **4-tier hierarchical state file** and a companion CLI/skill.

## Architecture: How It Avoids the 6 Hook Pitfalls

| Pitfall in Raw `hooks.json` | How `plugins/feature-flags` Solves It |
| :--- | :--- |
| **1. `PreToolUse` can block tools, but cannot hide them from the model's prompt** | Pairs `PreToolUse` hard blocks (`"decision": "deny"`) with a `PreInvocation` directive so the model knows `read_only_mode=true` is active before choosing a tool. |
| **2. `systemMessage` in `PreInvocation` appends to the transcript on every turn** | Uses `systemMessage` only once at `SessionStart`, and uses transient `ephemeralMessage` steps in `PreInvocation` so context never bloats across turns. |
| **3. Hook scripts run synchronously and block the agent loop** | Uses a zero-dependency Node ESM script (`scripts/hook-handler.mjs`) that reads local JSON files in `<10ms` and narrows `PreToolUse` matchers to specific tools. |
| **4. Hook `cwd` is the plugin directory, not the user's workspace** | Extracts `workspacePaths[0]` (Antigravity) or `cwd` (Claude Code) from the `stdin` JSON payload to locate `<workspace>/.agents/feature-flags.json`. |
| **5. `PreToolUse` `overwrite` is shallow-only and notifies the model** | Scopes argument rewriting (`prefer_uv_pytest`) to top-level `CommandLine` replacement (`pytest` -> `uv run pytest`) with a clear `reason`. |
| **6. Custom flags have no native UI toggle switch** | Ships a companion skill (`skills/feature-flags/SKILL.md`) and CLI (`scripts/flags-cli.mjs`) so users can toggle flags conversationally or from the terminal. |

## 4-Tier Flag Precedence

Flags are resolved on every hook invocation in the following order (highest to lowest):

1. **Environment Variable**: `AGY_PLUGIN_FLAGS="read_only_mode=true,release_channel=experimental"`
2. **Workspace Config**: `<repo-root>/.agents/feature-flags.json` (can be checked into VCS for team-wide defaults)
3. **User Global Config**: `~/.config/agent-skills/feature-flags.json` (persists across plugin updates)
4. **Plugin Defaults**: `plugins/feature-flags/defaults.json`

## Included Feature Flags

| Flag | Type | Default | Hook Event | Behavior |
| :--- | :--- | :--- | :--- | :--- |
| `release_channel` | `"stable" \| "beta" \| "experimental"` | `"stable"` | `SessionStart`, `PreInvocation` | Switches workflow instructions injected into the turn context. |
| `read_only_mode` | `boolean` | `false` | `PreInvocation`, `PreToolUse` | Denies `write_file`, `edit_file`, `write_to_file`, `replace_file_content`, and `multi_replace_file_content`. |
| `prod_deploy_guard` | `"allow" \| "ask" \| "deny"` | `"ask"` | `PreToolUse` | Gates `run_command` calls matching `gcloud run deploy`, `terraform apply`, `kubectl apply`, or `helm upgrade/install`. |
| `prefer_uv_pytest` | `boolean` | `true` | `PreToolUse` | Rewrites bare `pytest ...` commands to `uv run pytest ...` via `"overwrite"`. |
| `strict_tdd` | `boolean` | `false` | `PreInvocation` | Injects an `ephemeralMessage` requiring a failing test before implementation edits. |

## CLI Usage

```bash
# List active flags and where each value is inherited from
node plugins/feature-flags/scripts/flags-cli.mjs list --workspace "$(pwd)"

# Enable read_only_mode for the current repository
node plugins/feature-flags/scripts/flags-cli.mjs enable read_only_mode --workspace "$(pwd)"

# Set global release_channel to experimental
node plugins/feature-flags/scripts/flags-cli.mjs set release_channel experimental --global

# Reset workspace overrides
node plugins/feature-flags/scripts/flags-cli.mjs reset --workspace "$(pwd)"
```
