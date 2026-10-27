# AST GraphDB Plugin (`ast-graph`)

The **AST GraphDB Plugin** (`plugins/ast-graph`) is a self-contained **Antigravity Plugin** (`plugin.json` + `mcp_config.json` + `hooks.json` + `skills/` + `rules/`) that builds and queries a **per-repository, tamper-proof SQLite Labeled Property Graph (`<repo>/.ast-graph/ast.db`)** with Sourcegraph SCIP symbol URIs across TypeScript/JavaScript, Python, Go/Templ, Terraform HCL, and SQL DDL.

---

## Architecture & Multi-Repo Isolation

1. **Project Assessor (`ast_assess`)**:
   - Inspects any repository to detect languages, frameworks (`Fastify`, `FastAPI`, `Flask`, `Go net/http`, `Templ/HTMX`, `Zod`, `Pydantic`, `WebMCP`, `Terraform`, `SQL DDL`), and test runners (`npx vitest run`, `uv run pytest`, `go test`).
   - Writes `<repo>/.ast-graph/manifest.json` and automatically appends `.ast-graph/` to `<repo>/.git/info/exclude` so git working trees remain 100% clean without modifying committed `.gitignore` files.
2. **Tamper-Proof Per-Repository Binding**:
   - Every repository's SQLite database (`<repo>/.ast-graph/ast.db`) stores `canonicalRoot` and `repoId` (`sha256(realpath(repoRoot))`) in its `meta` table.
   - `verifyRepoBinding()` rejects any attempt to open or write a database from a mismatched repository (`TAMPER_GUARD`).

---

## Multi-Language Compiler Adapters

| Adapter | Languages | Extracted Entities & Cross-Layer Edges |
| :--- | :--- | :--- |
| **`ts-compiler`** | TypeScript, JavaScript, ESM (`.ts`, `.js`, `.mjs`) | Functions, classes, methods, `READS_PROPERTY` / `WRITES_PROPERTY`, Zod schemas, Fastify routes, `fetch('/api/...')` `CALLS_ROUTE` edges, WebMCP tools, Vitest suites |
| **`python-ast`** | Python (`.py`) | Classes, functions, async functions, `self.<attr>` reads/writes, Pydantic `BaseModel` & `@dataclass` schemas, FastAPI/Flask routes, MCP tools, Jinja2 templates, embedded SQL table references, `pytest` suites |
| **`go`** | Go & Templ (`.go`, `.templ`) | Packages, structs + fields + tags, interfaces, receiver methods, field reads/writes, `HandleFunc` routes, `*_test.go` tests, `.templ` components + HTMX `hx-get`/`hx-post`/`hx-delete` `CALLS_ROUTE` edges |
| **`terraform`** | Terraform HCL (`.tf`) | Recursive `.tf` discovery across `infra/` and `terraform/`, resources, data sources, variables, outputs, `REFERENCES_TF_RESOURCE`, `PROVISIONS_SERVICE` |
| **`sql-ddl`** | SQL (`.sql`) | `CREATE TABLE` schemas and columns (`scip-sql ddl sql 1.0.0 table:<name>#`) |
| **`web-composite`** | HTML/Jinja2/Vue/Svelte/Astro & CSS (`.html`, `.jinja2`, `.css`) + Markdown/YAML/JSON/TOML fallback | Composite `<script>` TypeScript AST delegation (preserving 1-based line offsets), `<style>` & `.css` hierarchical `StylesheetSection` / `CssAtRule` spans, DOM/Jinja `TemplateLandmark` spans, `fetch` / `hx-*` `CALLS_ROUTE` edges, WebMCP tools, and fallback `DocumentSection` outlines for `.md`/`.yaml`/`.json`/`.toml` |

---

## Installation

```bash
cd plugins/ast-graph
npm install
npm run build
ln -sfn "$(pwd)" ~/.gemini/config/plugins/ast-graph
```
