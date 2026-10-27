# `@agent-skills/ast-graph` — Multi-Repo AST & Cross-Layer Lineage GraphDB Plugin

A self-contained **Antigravity Plugin** (`plugin.json` + `mcp_config.json` + `hooks.json` + `skills/` + `rules/`) that builds and queries a **per-repository, tamper-proof SQLite Labeled Property Graph (`<repo>/.ast-graph/ast.db`)** with Sourcegraph SCIP symbol URIs across TypeScript/JavaScript, Python, Go/Templ, Terraform HCL, and SQL DDL.

---

## Key Capabilities

1. **Project Assessor & Auto-Configurator (`ast_assess`)**:
   - Inspects any repository to detect languages, frameworks (`Fastify`, `FastAPI`, `Flask`, `Go net/http`, `Templ/HTMX`, `Zod`, `Pydantic`, `WebMCP`, `Terraform`, `SQL DDL`), and test runners (`vitest`, `uv run pytest`, `go test`).
   - Writes `<repo>/.ast-graph/manifest.json` and automatically appends `.ast-graph/` to `<repo>/.git/info/exclude` so git working trees remain 100% clean.
2. **Strict Per-Repository Isolation & Anti-Tamper Guard**:
   - Every repository's SQLite database (`<repo>/.ast-graph/ast.db`) stores `canonicalRoot` and `repoId` (`sha256(realpath(repoRoot))`) in its `meta` table.
   - `verifyRepoBinding()` rejects any attempt to open or write a database from a mismatched repository (`[TAMPER_PROTECTION]`).
3. **5 Multi-Compiler Adapters**:
   - **TypeScript / JavaScript (`ts-compiler`)**: Functions, classes, methods, `READS_PROPERTY` / `WRITES_PROPERTY`, Zod schemas, Fastify routes, `fetch('/api/...')` `CALLS_ROUTE` edges, WebMCP tools, and Vitest test lineage.
   - **Python (`python-ast`)**: Classes, functions, methods, `self.<attr>` reads/writes, Pydantic `BaseModel` & `@dataclass` schemas, FastAPI/Flask routes, MCP tools, Jinja2 templates, embedded SQL table lineage, and `pytest` suites.
   - **Go & Templ (`go`)**: Go packages, structs + fields, interfaces, methods, `http.HandleFunc` routes, `*_test.go` tests, and `.templ` components + HTMX `hx-get`/`hx-post`/`hx-delete` `CALLS_ROUTE` edges.
   - **Terraform (`terraform`)**: Recursive `.tf` discovery across `infra/` and `terraform/`, resources, variables, outputs, and `PROVISIONS_SERVICE` edges.
   - **SQL DDL (`sql-ddl`)**: `CREATE TABLE` schemas and columns (`scip-sql ddl sql 1.0.0 table:<name>#`).

---

## Installation

```bash
cd plugins/ast-graph
npm install
npm run build
ln -sfn "$(pwd)" ~/.gemini/config/plugins/ast-graph
```
