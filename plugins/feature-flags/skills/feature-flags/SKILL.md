---
name: feature-flags
description: Inspect, toggle, or reset runtime feature flags for the feature-flags plugin across workspace (.agents/feature-flags.json) or global (~/.config/agent-skills/feature-flags.json) scopes. Activate when the user asks to view, enable, disable, or configure plugin feature flags (such as read_only_mode, release_channel, prod_deploy_guard, prefer_uv_pytest, or strict_tdd).
---

# Runtime Feature Flags Skill (`feature-flags`)

This skill manages the hierarchical runtime feature flags evaluated by the `feature-flags` plugin's lifecycle hooks (`SessionStart`, `PreInvocation`, and `PreToolUse`).

Because `PreInvocation` injects active flag directives via transient `ephemeralMessage` payloads and `PreToolUse` reads the state file on every matched tool call, **toggling a flag takes effect immediately on the very next turn**—no IDE or CLI restart required.

## Flag Precedence Hierarchy (Highest to Lowest)

1. **Environment Override**: `AGY_PLUGIN_FLAGS="read_only_mode=true,release_channel=experimental"`
2. **Workspace Scope**: `<workspace-root>/.agents/feature-flags.json` (team/repo-specific)
3. **Global User Scope**: `~/.config/agent-skills/feature-flags.json` (machine-wide personal defaults)
4. **Plugin Defaults**: `plugins/feature-flags/defaults.json`

## Built-In Flags

| Flag | Type | Default | What It Controls |
| :--- | :--- | :--- | :--- |
| `release_channel` | `"stable" \| "beta" \| "experimental"` | `"stable"` | Injects channel-specific workflow instructions via `PreInvocation`. |
| `read_only_mode` | `boolean` | `false` | Hard-blocks file mutation tools (`write_file`, `edit_file`) in `PreToolUse`. |
| `prod_deploy_guard` | `"allow" \| "ask" \| "deny"` | `"ask"` | Gates production deploy commands (`gcloud run deploy`, `terraform apply`, `kubectl apply`) in `PreToolUse`. |
| `prefer_uv_pytest` | `boolean` | `true` | Rewrites bare `pytest` commands to `uv run pytest` via `PreToolUse` argument `overwrite`. |
| `strict_tdd` | `boolean` | `false` | Injects an `ephemeralMessage` requiring a failing test before code edits. |

## CLI Commands

Run the companion CLI script [`flags-cli.mjs`](../../scripts/flags-cli.mjs) against the active workspace (`--workspace <repo-root>`) or globally (`--global`):

```bash
# 1. List all flags, effective values, and inheritance sources
node ~/.gemini/config/plugins/feature-flags/scripts/flags-cli.mjs list --workspace "$(pwd)"

# 2. Enable or disable a boolean flag for the current workspace
node ~/.gemini/config/plugins/feature-flags/scripts/flags-cli.mjs enable read_only_mode --workspace "$(pwd)"
node ~/.gemini/config/plugins/feature-flags/scripts/flags-cli.mjs disable read_only_mode --workspace "$(pwd)"

# 3. Set an enum flag in the global user config
node ~/.gemini/config/plugins/feature-flags/scripts/flags-cli.mjs set release_channel experimental --global

# 4. Reset a single flag or clear all workspace overrides
node ~/.gemini/config/plugins/feature-flags/scripts/flags-cli.mjs reset read_only_mode --workspace "$(pwd)"
node ~/.gemini/config/plugins/feature-flags/scripts/flags-cli.mjs reset --workspace "$(pwd)"
```
