# AST GraphDB Traceability (`ast-graph-traceability`)

An Antigravity & Claude Code plugin that provides a multi-compiler **AST & Cross-Layer Lineage GraphDB Sidecar** backed by a local SQLite Labeled Property Graph (`.ast-graph/ast.db` in WAL mode with `FTS5` BM25 search and CSR B-Tree adjacency indexes) and deterministic **Sourcegraph SCIP Symbol URIs**.

## Bundled Components

- **MCP Server (`mcp_config.json` -> `warehouse-ast-graph`)**: Exposes 11 zero-spawn-overhead MCP tools (`ast_symbol`, `ast_refs`, `ast_outline`, `ast_search`, `ast_blast_radius`, `ast_tests_for`, `ast_lineage`, `ast_shortest_path`, `ast_analyze`, `ast_benchmark`, `ast_sync`).
- **Lifecycle Hooks (`hooks.json`)**: Automatically runs incremental `<50ms` AST synchronization on `SessionStart` and after every `PostToolUse` file edit (`write_file`, `edit_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`).
- **Always-On Rule (`rules/AGENTS.md`)**: Enforces surgical AST-first symbol localization, anti-chunking guards on large files, and targeted Vitest test selection.
- **On-Demand Skill (`skills/ast-graph-traceability/SKILL.md`)**: Complete 4-step traceability workflow and multi-compiler adapter extension guide.

## Installation

Copy this plugin directory into `~/.gemini/config/plugins/ast-graph-traceability`:

```bash
cp -R plugins/ast-graph-traceability ~/.gemini/config/plugins/ast-graph-traceability
```
