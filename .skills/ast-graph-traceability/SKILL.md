---
name: ast-graph-traceability
description: Queries and maintains the multi-repo, tamper-proof AST & Cross-Layer Lineage GraphDB (<repo>/.ast-graph/ast.db, SCIP + SQLite LPG) across TypeScript/JavaScript, Python, Go/Templ, Terraform, and SQL repositories. Activate this skill whenever locating symbols, tracing property mutations (WRITES_PROPERTY/READS_PROPERTY), computing upstream blast radius, tracing cross-layer route/schema/SQL/Terraform lineage, or selecting targeted Vitest, Pytest, or Go test suites.
---

# AST GraphDB Traceability Skill (`ast-graph-traceability`)

The **AST GraphDB Plugin** (`@agent-skills/ast-graph`) provides an isolated, tamper-proof SQLite Labeled Property Graph (`<repo>/.ast-graph/ast.db`) with Sourcegraph SCIP symbol URIs and FTS5 search for every git repository.

---

## 1. Supported Languages & Cross-Layer Adapters

1. **TypeScript / JavaScript (`ts-compiler`)**:
   - Supports npm/Wireit monorepos and single-package TS/JS repos (`allowJs: true`).
   - Extracts functions, classes, methods, properties, `READS_PROPERTY` / `WRITES_PROPERTY`, Zod schemas (`VALIDATES_SCHEMA`), Fastify HTTP/WebSocket routes (`HANDLES_ROUTE`), `fetch('/api/...')` client calls (`CALLS_ROUTE`), WebMCP `navigator.modelContext.registerTool` tools, and Vitest `describe`/`it`/`test` suites (`TESTS_SYMBOL`).
2. **Python (`python-ast`)**:
   - Single-pass `python3` `ast` batch extractor.
   - Extracts classes, functions, async functions, methods, `self.<attr>` reads/writes, Pydantic `BaseModel` & `@dataclass` schemas, FastAPI/Flask routes (`@app.get`, `@router.post`), MCP tools (`@server.tool`, `@mcp.tool`), Jinja2 `TemplateResponse`, embedded SQL table lineage (`scip-sql ddl sql 1.0.0 table:<name>#`), and `pytest` functions/classes (`uv run pytest`).
3. **Go & Templ (`go`)**:
   - Extracts Go packages, structs + fields + JSON tags, interfaces, functions, receiver methods, field reads/writes, `http.HandleFunc` / `mux.HandleFunc` routes, `*_test.go` `Test*`/`Benchmark*` cases (`go test`), and `.templ` components + HTMX `hx-get`/`hx-post`/`hx-delete` `CALLS_ROUTE` edges.
4. **Terraform HCL (`terraform`)**:
   - Recursively discovers `.tf` files across `infra/`, `terraform/`, etc.
   - Extracts `resource`, `data`, `variable`, `output`, `locals`, cross-resource `REFERENCES_TF_RESOURCE` edges, and `PROVISIONS_SERVICE` links to Cloud Run services.
5. **SQL DDL (`sql-ddl`)**:
   - Discovers `.sql` files and extracts `CREATE TABLE` schemas and columns (`scip-sql ddl sql 1.0.0 table:<name>#`), linking them to Python/TS/Go SQL queries in `ast_lineage`.
6. **Web Composite & Universal Structural Outlines (`web-composite`)**:
   - Demultiplexes `.html`, `.htm`, `.jinja`, `.jinja2`, `.njk`, `.astro`, `.vue`, and `.svelte` files: delegates `<script>` blocks to TypeScript's AST parser with exact 1-based line offsets, `<style>` blocks to the CSS structural parser, and extracts DOM/template landmarks (`TemplateLandmark`), `fetch` / `hx-*` `CALLS_ROUTE` edges, and WebMCP tool registrations.
   - Parses `.css` stylesheets into `StylesheetSection`, `CssAtRule`, and grouped selector spans, and provides on-demand `DocumentSection` structural outlines for `.md`, `.yaml`/`.yml`, `.json`, and `.toml` files.

---

## 2. Per-Repo Storage & Anti-Tamper Isolation

- Each repository stores its graph strictly inside `<repo-root>/.ast-graph/ast.db` alongside `<repo-root>/.ast-graph/manifest.json`.
- On first assessment or sync, `.ast-graph/` is automatically appended to `<repo-root>/.git/info/exclude` (never dirtying `git status` or committed `.gitignore` files).
- `AstGraphDatabase.verifyRepoBinding()` validates `canonicalRoot` and `repoId` in the SQLite `meta` table on every connection and throws a `[TAMPER_PROTECTION]` error if a database is ever pointed at a mismatched repository.

---

## 3. MCP Tools (`ast-graph`)

All MCP tools accept an optional `workspace` parameter (repository path or repository name such as `"warehouse"`, `"electric-sheep"`, `"smartrouter"`, `"the-davenporter"`):

- `ast_assess`: Inspect workspace languages, frameworks, test runners, and verify `.ast-graph/manifest.json` + `.git/info/exclude`.
- `ast_symbol`: Resolve symbol definitions, signatures, callers, callees, and covering tests (supports batch `queries: [...]`).
- `ast_refs`: Locate exact `WRITES_PROPERTY` (mutations) and `READS_PROPERTY` (reads) for fields/properties/symbols.
- `ast_outline`: List all symbols and exact `startLine-endLine` spans in one or more files without chunk-reading.
- `ast_search`: FTS5/substring search across symbol names, qualified names, and signatures.
- `ast_blast_radius`: Compute k-hop upstream impact and minimal covering test commands (`vitest`, `uv run pytest`, `go test`).
- `ast_tests_for`: Return direct and transitive test cases covering a symbol or file.
- `ast_lineage`: Trace end-to-end cross-layer lineage across schemas, SQL tables, HTTP/WS/HTMX routes, and Terraform resources.
- `ast_shortest_path`: Find the shortest dependency chain between two symbols.
- `ast_analyze`: Compute package coupling/instability, untested hubs, dead exports, and cycles.
- `ast_sync`: Trigger incremental or full synchronization.

---

## 4. CLI Usage

```bash
# Assess a repository and write <repo>/.ast-graph/manifest.json
node ~/.gemini/config/plugins/ast-graph/dist/cli.js assess --workspace /path/to/repo

# Full or incremental sync
node ~/.gemini/config/plugins/ast-graph/dist/cli.js sync --workspace /path/to/repo

# Query symbols, property references, file outlines, lineage, blast radius, and tests
node ~/.gemini/config/plugins/ast-graph/dist/cli.js symbol <SymbolName> --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js refs <PropertyName> --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js outline <FilePath> --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js lineage <SchemaOrRouteOrTable> --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js blast-radius <SymbolOrFile> --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js tests-for <SymbolOrFile> --workspace /path/to/repo
```
