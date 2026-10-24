# AST GraphDB Traceability & Targeted Verification Rule

When investigating bugs, tracing cross-package dependencies, modifying Zod protocol schemas, refactoring shared code, or selecting tests:

1. **Query the AST GraphDB First (`warehouse-ast-graph` MCP or `ast:query` CLI)**:
   - Before running broad multi-file text searches or reading large source files, query the local AST GraphDB (`.ast-graph/ast.db`) using the `ast-graph-traceability` skill (`ast_*` MCP tools or `npm run ast:query -- <command>`):
     - **Locate symbol & call neighborhood**: `ast_symbol` (`npm run ast:query -- symbol <SymbolName>`)
     - **Locate property/field reads & writes**: `ast_refs` (`npm run ast:query -- refs <PropName>`)
     - **Outline symbols in a file (with optional filter)**: `ast_outline` (`npm run ast:query -- outline <FilePath> [--filter <substr>]`)
     - **Fuzzy-search symbols across workspace**: `ast_search` (`npm run ast:query -- search <Query> [--kind <Kind>]`)
     - **Compute upstream blast radius before editing**: `ast_blast_radius` (`npm run ast:query -- blast-radius <SymbolOrFile>`)
     - **Trace protocol / route / Terraform lineage**: `ast_lineage` (`npm run ast:query -- lineage <SchemaOrRoute>`)
     - **Find shortest dependency path**: `ast_shortest_path` (`npm run ast:query -- path <FromSymbol> <ToSymbol>`)
   - **Strict Anti-Chunking & Sequential AST-First Mandate**:
     - **NEVER** call `read_file` / `view_file` without `StartLine` and `EndLine` on files larger than 250 lines, and **NEVER** page through large files in sequential 800-line chunks (`1-800`, `801-1600`, ...).
     - **NEVER** fire speculative `read_file` / `view_file` calls in parallel with an AST query. Run the AST query **first**, obtain the exact `filePath#L<start>-L<end>`, and then read only that surgical line range (`StartLine`–`EndLine`).

2. **Targeted Test Selection (`ast_tests_for` / `tests-for`)**:
   - After modifying any file or symbol, call `ast_tests_for` (or `npm run ast:query -- tests-for <SymbolOrFile>`) and execute the linked test suites immediately for fast verification before running full workspace builds.

3. **Keep `.ast-graph/` Synchronized & Git-Ignored**:
   - `.ast-graph/` is automatically maintained by the `PostToolUse` lifecycle hook (`hooks.json`), the sidecar daemon (`:4319`), and lazy pre-query `mtime` synchronization.
   - Never commit `.ast-graph/` artifacts (`ast.db`, `export.cypher`, `snapshot.jsonl`, `benchmark-report.json`) to Git.
