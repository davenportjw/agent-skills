# AST GraphDB Traceability (`ast-graph-traceability`)

The **AST GraphDB Traceability** plugin (`plugins/ast-graph-traceability`) and skill (`.skills/ast-graph-traceability`) provide a multi-compiler **AST & Cross-Layer Lineage GraphDB Sidecar** backed by a local SQLite Labeled Property Graph (`.ast-graph/ast.db` in WAL mode with `FTS5` BM25 search and CSR B-Tree adjacency indexes) and deterministic **Sourcegraph SCIP Symbol URIs**.

## Features

- **11 Zero-Overhead MCP Tools (`warehouse-ast-graph`)**: `ast_symbol`, `ast_refs`, `ast_outline`, `ast_search`, `ast_blast_radius`, `ast_tests_for`, `ast_lineage`, `ast_shortest_path`, `ast_analyze`, `ast_benchmark`, and `ast_sync`.
- **Automatic `<50ms` Incremental Hooks (`hooks.json`)**: Keeps `.ast-graph/ast.db` synchronized on `SessionStart` and after every `PostToolUse` file edit (`write_file`, `edit_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`).
- **Multi-Compiler SCIP Adapters**: Supports TypeScript/JavaScript (`ts.Program`), Zod schemas, Fastify HTTP/WebSocket routes, Vitest suites, Terraform HCL (`*.tf`), and Python (`ast`).

## Installation

```bash
cp -R plugins/ast-graph-traceability ~/.gemini/config/plugins/ast-graph-traceability
```
