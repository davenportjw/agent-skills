---
trigger: always_on
description: Multi-Repo AST & Cross-Layer Lineage GraphDB Sidecar rules for TypeScript/JS, Python, Go/Templ, Rust, Terraform/HCL, SQL, Dockerfile, Protobuf, GraphQL, Java, Kotlin, C#, Ruby, Elixir, PHP, C/C++, Swift, Zig, and WASM/WIT repositories.
---

# AST GraphDB Traceability Rules (`ast-graph`)

Always use the **AST GraphDB Plugin** (`ast-graph` MCP server or `node ~/.gemini/config/plugins/ast-graph/dist/cli.js` CLI) for code navigation, property read/write localization, cross-layer lineage tracing, upstream blast-radius analysis, and targeted test selection instead of blind multi-file greps or chunk-reading large files.

## 1. Per-Repository Isolation & Zero Cross-Contamination
- Every repository owns its own isolated SQLite WAL database at `<repo-root>/.ast-graph/ast.db` and assessment manifest at `<repo-root>/.ast-graph/manifest.json`.
- `.ast-graph/` is automatically excluded via `<repo-root>/.git/info/exclude` so git status stays clean without modifying committed `.gitignore` files.
- When working across multiple repositories, pass `workspace: "<repo-name-or-path>"` to `ast_*` MCP tools or `--workspace <path>` to the CLI.
- If a tool returns `NO_WORKSPACE` or `UNKNOWN_WORKSPACE`, retry with `workspace` set to one of the listed repos. Do not fall back to grep. The server never defaults to the plugin install directory.

## 2. Strict Anti-Chunking & AST-First Lookup Mandate
1. **NEVER Chunk-Read or Shell-Slice Large Files**: Never call `view_file` / `read_file` without `StartLine` and `EndLine` on files larger than 250 lines, never page through files in 800-line chunks (`1-800`, `801-1600`, ...), and **never use bash `sed -n X,Yp`, `cat`, `head`, or `tail` via `run_command` to bypass `ast_outline` + `read_file`**.
2. **Sequential AST-First Lookup (No Regex Structural Outlines)**: Run `ast_symbol`, `ast_refs`, `ast_outline`, or `ast_search` **first** instead of `grep -n "function|class|interface|def "`. Read the `=== TARGET SUMMARY ===` block directly under the header line for exact `filePath#L<start>-L<end>` spans, then call `read_file` on only that exact line range (`<= 250` lines).
3. **Zero-Lookup Turn-1 Invocation (Call Directly Without Schema Reads)**:
   - **MCP (`call_mcp_tool` with `ServerName: "ast-graph_ast-graph"`, no schema read needed)**:
     - `ToolName: "ast_outline"`, `Arguments: { "filePaths": ["path/a.ts", "path/b.ts"], "filter": "optional", "workspace": "<repo>" }`
     - `ToolName: "ast_search"`, `Arguments: { "queries": ["symA", "symB"], "kind": "optional", "workspace": "<repo>" }`
     - `ToolName: "ast_symbol"`, `Arguments: { "queries": ["symA", "symB"], "workspace": "<repo>" }`
     - `ToolName: "ast_refs"`, `Arguments: { "targets": ["propOrSymbol"], "workspace": "<repo>" }`
     - `ToolName: "ast_blast_radius"`, `Arguments: { "target": "symOrFile", "workspace": "<repo>" }`
     - `ToolName: "ast_tests_for"`, `Arguments: { "target": "symOrFile", "workspace": "<repo>" }`
     - `ToolName: "ast_lineage"`, `Arguments: { "target": "POST /api/route or Schema", "workspace": "<repo>" }`
   - **CLI in `run_command` (when chaining inside a shell command)**:
     - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js outline <file1> [file2...] [--filter <kw>] --workspace <repo>`
     - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js symbol <sym1> [sym2...] --workspace <repo>`
     - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js search <q1> [q2...] --workspace <repo>`
     - `node ~/.gemini/config/plugins/ast-graph/dist/cli.js refs <prop> --workspace <repo>`
4. **Targeted Test Selection**: Before running a full test suite, run `ast_tests_for` or `ast_blast_radius` to obtain the exact language-aware test command (`npx vitest run ...`, `uv run pytest ...`, or `go test ...`).
5. **Batch Symbols, Grep Literals Only**: For several identifiers, pass `queries: [...]` / `filePaths: [...]` (or multiple CLI args) in a single call instead of `grep "a\|b\|c"`. Reserve `grep -rn` / `rg` strictly for string literals, UI copy, CSS values, and log text that are not code symbols.
