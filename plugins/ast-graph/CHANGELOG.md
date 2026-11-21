# Changelog — `ast-graph`

## 2026-11-21 — CLI adoption in subagents & swarm workers

### Why
A transcript audit after the CLI-primary release (`6224b81`) showed most threads still navigated code with `grep`/`sed`/`cat`. Probes confirmed the cause: **Antigravity swarm workers (and subagents) do not receive plugin rules (`rules/AGENTS.md`) or plugin hooks** (no SessionStart message, no PostToolUse sync). They only see their brief plus the user's **global** agent instruction file.

### Changed
- **SessionStart CLI hint** (`src/hook-handler.ts`): the hook now injects a short message with the exact CLI command, `--workspace <root>` for each session root, every live linked worktree, and a reminder to copy the CLI line into delegation briefs. Uses Antigravity `injectSteps[].systemMessage` and Claude Code `hookSpecificOutput.additionalContext`. Disable with `AST_GRAPH_SESSION_HINT=0`.
- **`WORKSPACE_NOT_FOUND` guard** (`src/cli.ts`): a `--workspace` path that is missing or not a directory now exits `2` with `WORKSPACE_NOT_FOUND`. Previously it silently created the directory plus an empty `.ast-graph/ast.db` (e.g. for an already-removed worktree) and reported "FILE NOT INDEXED".
- **Rules & skill** (`rules/AGENTS.md` §3, `skills/ast-graph-traceability/SKILL.md`): briefs for subagents/swarm workers must paste the exact CLI line with the worker's worktree path, naming the CLI rather than MCP tool names.
- Tests: `test/session-hint-and-workspace.test.ts`.

### Action required: update your root (global) agent file
Because workers never see plugin rules or hooks, add this section to the global instruction file of each harness you use. That file is the only instruction source workers inherit:

| Harness | Global file |
|---|---|
| Google Antigravity | `~/.gemini/GEMINI.md` |
| Claude Code | `~/.claude/CLAUDE.md` |
| OpenAI Codex CLI | `~/.codex/AGENTS.md` |

```markdown
## Code Navigation (ast-graph)

- In any git repo, navigate code with the ast-graph CLI via `run_command` before grep/sed/cat:
  `node ~/.gemini/config/plugins/ast-graph/dist/cli.js outline|symbol|refs|search|blast|tests <targets...> --workspace <root>`
- In a worktree, `<root>` is the worktree path (`<repo>/.worktrees/<item>`), never the parent repo. `WORKSPACE_NOT_FOUND` (exit 2) means the path doesn't exist; check `git worktree list`.
- Batch targets in one call. Read only the line spans the CLI reports. Use grep/rg only for string literals, UI copy, CSS values, and log text.
- Briefs for subagents and swarm workers must include this CLI line with the worker's worktree path.
```

Also replace any references to MCP tool names (`ast_symbol`, `ast_refs`, `ast_outline`, `ast_blast_radius`) in global files or personal skills with the CLI equivalents (`symbol`, `refs`, `outline`, `blast`). For Claude Code / Codex installs, use your plugin's `dist/cli.js` path if it differs from `~/.gemini/config/plugins/ast-graph`.

Verified: after this change, a fresh Antigravity swarm worker given a plain "where is X defined / who calls it" question ran `cli.js symbol` and `cli.js refs` with the correct `--workspace` unprompted. Global-file edits apply to newly started sessions and workers only.
