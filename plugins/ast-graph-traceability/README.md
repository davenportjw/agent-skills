# `ast-graph-traceability` (deprecated)

This plugin is **deprecated and no longer registered**. It was an early fork of the AST GraphDB sidecar. It diverged from the canonical implementation, with an incompatible schema (`labels_json`), different CLI commands and stale output markers.

Use the canonical plugin instead: **[`plugins/ast-graph`](../ast-graph/README.md)** (docs: [`docs/skills/ast_graph.md`](../../docs/skills/ast_graph.md)).

```bash
ln -s "$PWD/plugins/ast-graph" ~/.gemini/config/plugins/ast-graph
```

**Migration:**
- Existing `<repo>/.ast-graph/ast.db` files created by this fork are migrated automatically. The canonical plugin detects the legacy schema, drops the derived tables and re-syncs.
- The MCP server name changed from `warehouse-ast-graph` to `ast-graph`. Tool names (`ast_symbol`, `ast_refs`, `ast_outline`, …) are unchanged.

The source of the fork is available in git history (removed after commit `cc5bad6`).
