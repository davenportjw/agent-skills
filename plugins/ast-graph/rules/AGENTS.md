---
trigger: always_on
description: Multi-Repo AST & Cross-Layer Lineage GraphDB Sidecar rules for TypeScript/JS, Python, Go/Templ, Terraform, and SQL repositories.
---

# AST GraphDB Traceability Rules (`ast-graph`)

Always use the **AST GraphDB Plugin** (`ast-graph` MCP server or `node ~/.gemini/config/plugins/ast-graph/dist/cli.js` CLI) for code navigation, property read/write localization, cross-layer lineage tracing, upstream blast-radius analysis, and targeted test selection instead of blind multi-file greps or chunk-reading large files.

## 1. Per-Repository Isolation & Zero Cross-Contamination
- Every repository owns its own isolated SQLite WAL database at `<repo-root>/.ast-graph/ast.db` and assessment manifest at `<repo-root>/.ast-graph/manifest.json`.
- `.ast-graph/` is automatically excluded via `<repo-root>/.git/info/exclude` so git status stays clean without modifying committed `.gitignore` files.
- When working across multiple repositories, pass `workspace: "<repo-name-or-path>"` to `ast_*` MCP tools or `--workspace <path>` to the CLI.

## 2. Strict Anti-Chunking & AST-First Lookup Mandate
1. **NEVER Chunk-Read Large Files**: Never call `view_file` / `read_file` without `StartLine` and `EndLine` on files larger than 250 lines, and never page through files in 800-line chunks (`1-800`, `801-1600`, ...).
2. **Sequential AST-First Lookup**: Run `ast_symbol`, `ast_refs`, `ast_outline`, or `ast_search` **first**, inspect the `=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===` block for exact `filePath#L<start>-L<end>` spans, and then read only that exact line range.
3. **Targeted Test Selection**: Before running a full test suite, run `ast_tests_for` or `ast_blast_radius` to obtain the exact language-aware test command (`npx vitest run ...`, `uv run pytest ...`, or `go test ...`).
