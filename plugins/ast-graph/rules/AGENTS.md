---
trigger: always_on
description: Multi-Repo AST & Cross-Layer Lineage GraphDB Sidecar rules for TypeScript/JS, Python, Go/Templ, Rust, Terraform/HCL, SQL, Dockerfile, Protobuf, GraphQL, Java, Kotlin, C#, Ruby, Elixir, PHP, C/C++, Swift, Zig, and WASM/WIT repositories.
---

# AST GraphDB Traceability Rules (`ast-graph`)

Always use the **AST GraphDB Plugin** (`node ~/.gemini/config/plugins/ast-graph/dist/cli.js` CLI primary; `ast-graph` MCP server optional when mounted) for code navigation, property read/write localization, cross-layer lineage tracing, upstream blast-radius analysis, and targeted test selection instead of blind multi-file greps or paging blindly through files.

## 1. Per-Repository Isolation & Zero Cross-Contamination
- Every repository owns its own isolated SQLite WAL database at `<repo-root>/.ast-graph/ast.db` and assessment manifest at `<repo-root>/.ast-graph/manifest.json`.
- `.ast-graph/` is automatically excluded via `<repo-root>/.git/info/exclude` so git status stays clean without modifying committed `.gitignore` files.
- Always pass `--workspace <repo-path>` to the CLI (or `workspace: "<repo-name-or-path>"` if using MCP). Git worktrees and nested clones are separate repos with their own index: pass the worktree path as `--workspace <path-to-worktree>`; the parent index never contains `.worktrees/` files.
- `[index busy]` means another session is re-indexing; results come from the last committed index and are safe to use. `INDEX_BUILDING` means the first index is still being built: retry the same call shortly instead of switching to grep.
- If an MCP call returns `NO_WORKSPACE` or `UNKNOWN_WORKSPACE`, retry with `--workspace` via CLI or the listed repo name. Do not fall back to grep.

## 2. AST-First Lookup & Smart Read Sizing
1. **AST-First Lookup (No Regex Structural Outlines)**: Run `outline`, `symbol`, `refs`, or `search` **first** instead of `grep -n "function|class|interface|def "`, and never use bash `sed -n X,Yp`, `cat`, `head`, or `tail` to slice source files when `read_file` with `StartLine`/`EndLine` works directly.
2. **Size `read_file` to the Task (No Blind Chunking, No 250-Line Micro-Slicing Loops)**:
   - **Targeted edits (default)**: Read the `=== TARGET SUMMARY ===` spans from `outline`/`symbol`/`refs`, then call `read_file` on just that exact symbol span (typically `<= 250` lines). Never call `read_file` without `StartLine`/`EndLine` on large files (`> 250` lines) just to scan them.
   - **Coupled visual/procedural files & long symbols (`> 250` lines)**: When authoring or debugging tightly coupled code where global context matters (e.g., Three.js scenes, shaders/TSL, Blender procedural builders, large render/layout pipelines, or single functions/modules longer than 250 lines), **read the full symbol or up to `<= 800` contiguous lines in one `read_file` call** after outlining. Never chop one file into dozens of sequential 250-line micro-reads (`1-250`, `251-500`, `501-750`, ...).
3. **Primary Invocation — CLI via `run_command` (Works Universally in Solo Sessions, Subagents, and Native Swarm Workers)**:
   - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js outline <file1> [file2...] [--filter <kw>] [--limit <n>] --workspace <repo>`
   - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js symbol <sym1> [sym2...] --workspace <repo>`
   - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js search <q1> [q2...] [--kind <kind>] --workspace <repo>`
   - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js refs <prop1> [prop2...] --workspace <repo>`
   - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js blast <symOrFile> --workspace <repo>`
   - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js tests <symOrFile> --workspace <repo>`
   - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js lineage <routeOrSchema> --workspace <repo>`
   - *(If the repo defines `npm run ast:query`, that wraps the same CLI; in sessions where `call_mcp_tool` is mounted on `ast-graph_ast-graph`, `ast_outline`/`ast_symbol`/`ast_search`/`ast_refs`/`ast_blast_radius`/`ast_tests_for`/`ast_lineage` remain available as a secondary interface with no schema read needed.)*
4. **Targeted Test Selection**: Before running a full test suite, run `tests <symOrFile>` (or `blast <symOrFile>`) to obtain the exact language-aware test command (`npx vitest run ...`, `uv run pytest ...`, `go test ...`, or `cargo test ...`).
5. **Batch Symbols, Grep Literals Only**: Pass multiple targets in one CLI call (`outline f1 f2`, `symbol s1 s2`, `search q1 q2`, `refs p1 p2`) instead of `grep "a\|b\|c"`. Reserve `grep -rn` / `rg` strictly for string literals, UI copy, CSS values, and log text that are not code symbols.

## 3. Delegation: Put the CLI Line in Every Brief
- Subagents and swarm workers start fresh and often only see their brief. When you write a brief (`invoke_subagent` prompt or `swarm` `add`) for code work in a repo, **paste the exact CLI line with the worktree the worker will use**, e.g.:
  `Code navigation: use node ~/.gemini/config/plugins/ast-graph/dist/cli.js outline|symbol|refs|search|blast|tests <targets...> --workspace /abs/path/to/repo/.worktrees/<item> instead of grep/sed/cat.`
- Name the CLI, not MCP tool names (`ast_outline`, ...): the CLI works in every harness and worker, while MCP may be unmounted (or a stale server build) in a worker session.
- `WORKSPACE_NOT_FOUND` (exit 2) means the `--workspace` path does not exist (e.g. a removed worktree); run `git worktree list` and retry with a live path.
