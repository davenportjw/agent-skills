---
name: ast-graph-traceability
description: Queries and maintains the multi-repo, tamper-proof AST & Cross-Layer Lineage GraphDB (<repo>/.ast-graph/ast.db, SCIP + SQLite LPG) across TypeScript/JavaScript, Python, Go/Templ, Rust, Terraform/HCL, SQL, Dockerfile, Protobuf, GraphQL, Java, Kotlin, C#, Ruby, Elixir, PHP, C/C++, Swift, Zig, and WebAssembly/WIT repositories. Activate this skill whenever locating symbols, tracing property mutations (WRITES_PROPERTY/READS_PROPERTY), computing upstream blast radius, tracing cross-layer route/schema/SQL/Terraform/env lineage, or selecting targeted test suites.
---

# AST GraphDB Traceability Skill (`ast-graph-traceability`)

The **AST GraphDB Plugin** (`@agent-skills/ast-graph`) provides an isolated, tamper-proof SQLite Labeled Property Graph (`<repo>/.ast-graph/ast.db`) with Sourcegraph SCIP symbol URIs and FTS5 search for every git repository.

---

## 1. Supported Languages & Cross-Layer Adapters

1. **TypeScript / JavaScript (`ts-compiler`)**:
   - Supports npm/Wireit monorepos and single-package TS/TSX/JS/JSX repos (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `allowJs: true`, `jsx: Preserve`).
   - Extracts top-level and nested functions (including React component inner handlers like `App#handleCreateNewShow().`), classes, methods, interface & `type` alias properties, `READS_PROPERTY` (including object destructuring `const { prop } = obj`) / `WRITES_PROPERTY` (including assignment, mutating collection calls `.push`/`.splice`/`.set`/`.delete`, and object-literal property initializers), Zod schemas (`VALIDATES_SCHEMA`), Fastify HTTP/WebSocket routes (`HANDLES_ROUTE`), `fetch('/api/...')` client calls (`CALLS_ROUTE`), WebMCP `navigator.modelContext.registerTool` tools, and Vitest `describe`/`it`/`test` suites (`TESTS_SYMBOL`).
2. **Python (`python-ast`)**:
   - Single-pass `python3` `ast` batch extractor.
   - Extracts classes, top-level and nested functions/async functions (including factory-scoped FastAPI/Flask routes inside `create_app()`), methods, `self.<attr>` reads/writes, Pydantic `BaseModel` & `@dataclass` schemas, FastAPI/Flask routes (`@app.get`, `@router.post`), MCP tools (`@server.tool`, `@mcp.tool`), Jinja2 `TemplateResponse`, `os.getenv` / `os.environ.get` (`CONFIGURES_ENV`), embedded SQL table lineage (`scip-sql ddl sql 1.0.0 table:<name>#`), and `pytest` functions/classes (`uv run pytest`).
3. **Go & Templ (`go`)**:
   - Extracts Go packages, structs + fields + JSON tags, interfaces, generic functions & receiver methods (`[T any]`), field reads/writes, type usages (`REFERENCES` from composite literals `T{}`/`&pkg.T{}`, param/return types via `HAS_PARAMETER_TYPE`/`RETURNS_TYPE`, struct field and embedded types, interface method signatures, grouped `type ( ... )` specs and defined/alias types), receiver methods contained by their type across files, `http.HandleFunc` / `mux.HandleFunc` + Gin/Echo/Chi (`r.GET`, `r.POST`, etc.) routes, `os.Getenv` / `os.LookupEnv` (`CONFIGURES_ENV`), `*_test.go` `Test*`/`Benchmark*` cases (`go test`), and `.templ` components + HTMX `hx-get`/`hx-post`/`hx-delete` `CALLS_ROUTE` edges.
4. **Terraform / HCL (`terraform`)**:
   - Recursively discovers `.tf`, `.hcl`, and `.tfvars` files across `infra/`, `terraform/`, etc. using a heredoc- (`<<EOF` / `<<-EOF`), block-comment-, and string-aware brace scanner.
   - Extracts `resource`, `data`, `module`, `provider`, `variable`, `output`, `locals`, `.tfvars` assignments, container `image = "..."` (`PROVISIONS_SERVICE`), `env { name = "..." }` (`CONFIGURES_ENV` -> `scip-env global env 1.0.0 <NAME>#`), and cross-resource `REFERENCES_TF_RESOURCE` edges.
5. **SQL DDL (`sql-ddl`)**:
   - Discovers `.sql` and `.sqlx` files with a quote-, dollar-quote- (`$$...$$` / `$tag$...$tag$`), and comment-aware statement splitter plus balanced-paren column parser.
   - Extracts `CREATE TABLE` schemas and multi-word column types (`TIMESTAMP WITH TIME ZONE`, `NUMERIC(p, s)`, `ARRAY<...>`), inline and table-level `FOREIGN KEY ... REFERENCES` edges, Spanner `INTERLEAVE IN PARENT`, `CREATE VIEW` (`REFERENCES` source tables), `CREATE INDEX`, and `ALTER TABLE`.
6. **Dockerfile / Containerfile (`scip-docker`)**:
   - Parses `Dockerfile`, `Dockerfile.*`, and `Containerfile` with backslash continuation joining (`\`) while preserving 1-based `startLine`–`endLine` spans.
   - Extracts multi-stage `FROM ... AS <stage>` (`ServiceInstance`), `COPY --from=<stage>` (`REFERENCES`), `ENV` / `ARG` (`CONFIGURES_ENV` -> `scip-env global env 1.0.0 <NAME>#`), `EXPOSE` (`RouteEndpoint`), and `ENTRYPOINT` / `CMD` / `HEALTHCHECK`.
7. **API Contracts: Protobuf & GraphQL (`scip-contract`)**:
   - Parses `.proto` (`service`, `rpc`, `message` fields, `enum`, `google.api.http` REST bindings -> `HANDLES_ROUTE`, `VALIDATES_SCHEMA`, `EMITS_SCHEMA`) and `.graphql` / `.gql` (`type`, `interface`, `input`, `enum`, `union`, `scalar`, `Query` / `Mutation` / `Subscription` operations) with multi-line block spans.
8. **Rust (`scip-rust`)**:
   - Parses `.rs` files using a lifetime- (`'a`, `'static`), char-literal- (`'{'`), raw-string- (`r#"..."#`), and comment-safe brace scanner.
   - Extracts `struct` + fields, `enum`, `trait`, `impl Trait for Type` (`IMPLEMENTS`), `fn`, inline `mod` blocks (including `#[cfg(test)] mod tests { ... }` `TestSuite` + inner `#[test]` / `#[tokio::test]` / `#[rstest]` `TestCase` nodes with `TESTS_FILE` and `TESTS_SYMBOL` edges for `cargo test`), `macro_rules!`, `const`/`static`, `type`, Actix-web & Axum routes (`HANDLES_ROUTE`), `std::env::var` (`CONFIGURES_ENV`), and `sqlx::query!` SQL table references (`REFERENCES`).
9. **Polyglot Structural & Cross-Layer Adapter (`scip-polyglot`)**:
   - Supports **Java** (`.java`), **Kotlin** (`.kt`, `.kts`), **C#** (`.cs`), **Ruby** (`.rb`), **Elixir** (`.ex`, `.exs`), **PHP** (`.php`), **C/C++** (`.c`, `.cc`, `.cpp`, `.h`, `.hpp`), **Swift** (`.swift`), **Zig** (`.zig`), and **WebAssembly / WIT** (`.wat`, `.wit`).
   - Computes multi-line 1-based `startLine`–`endLine` spans (brace-delimited, `def`/`class`/`module ... end` for Ruby/Elixir, and S-expression parens for WAT) and links Spring Boot / ASP.NET / Rails / Phoenix / Laravel / Symfony routes (`HANDLES_ROUTE`), JPA / EF / ActiveRecord / Ecto ORM tables (`REFERENCES`), and environment variables (`CONFIGURES_ENV`).
10. **Web Composite & Universal Structural Outlines (`web-composite`)**:
   - Demultiplexes `.html`, `.htm`, `.jinja`, `.jinja2`, `.njk`, `.astro`, `.vue`, and `.svelte` files: delegates `<script>` blocks to TypeScript's AST parser with exact 1-based line offsets, `<style>` blocks to the CSS structural parser, and extracts DOM/template landmarks (`TemplateLandmark`), `fetch` / `hx-*` `CALLS_ROUTE` edges, and WebMCP tool registrations.
   - Parses `.css` stylesheets into `StylesheetSection`, `CssAtRule`, and grouped selector spans, and provides on-demand `DocumentSection` structural outlines for `.md`, `.yaml`/`.yml`, `.json`, and `.toml` files.

---

## 2. Per-Repo Storage & Anti-Tamper Isolation

- Each repository stores its graph strictly inside `<repo-root>/.ast-graph/ast.db` alongside `<repo-root>/.ast-graph/manifest.json`.
- On first assessment or sync, `.ast-graph/` is automatically appended to `<repo-root>/.git/info/exclude` (never dirtying `git status` or committed `.gitignore` files).
- `AstGraphDatabase.verifyRepoBinding()` validates `canonicalRoot` and `repoId` in the SQLite `meta` table on every connection. If the repo's *own* `<root>/.ast-graph/ast.db` was stamped for a different path (moved/renamed checkout or worktree), derived data is dropped and the DB is rebound and rebuilt; a database outside `<root>/.ast-graph/` that belongs to another repository still throws `[TAMPER_PROTECTION]`.
- Nested checkouts (any subdirectory with its own `.git`: `.worktrees/*`, submodules, vendored clones) plus `node_modules`, `.git`, `.ast-graph` are never indexed into the parent; target a worktree with `workspace: "<worktree-path>"`.
- One writer per repo across all processes (MCP sessions, hooks, daemon, CLI): `.ast-graph/sync.lock` holds `{pid, host, startedAt, heartbeatAt}`. Non-owners answer from the last committed index (`[index busy]` prefix); with no index yet they return `INDEX_BUILDING` (retry). Dead-PID locks are taken over immediately; live owners silent for 10 min are treated as hung.
- WAL is checkpointed/truncated after every sync (`journal_size_limit` 64 MB), history tables are capped, and SQLite freelist pages auto-compact (`VACUUM` + FTS5 `optimize`) when free pages exceed 16 MB / 25%. Snapshot exports (`export.cypher`, `snapshot.jsonl`) are opt-in only: CLI `export` / `sync --export`, or `ast_sync export:true`.
- Git lifecycle sync: `last_git_head` detects branch switches/pulls/rebases across all queries (including single-file `ast_outline`); new `.worktrees/*` checkouts seed in-place from their parent repo's `ast.db` (~10 ms); `PreToolUse`/`PostToolUse` hooks clean `<worktree>/.ast-graph` prior to `git worktree remove` (without `--force`), close stale MCP SQLite handles, and prune deleted checkouts from `ast-graph-workspaces.json` (also available via `cli.js prune`).
- Hooks build a missing index in a detached background `sync --no-export` and return immediately; queries during that build return `INDEX_BUILDING` (retry shortly, don't fall back to grep).
- Repo-specific query aliases live in a committed `<root>/ast-graph.config.json` (`{"aliases": {"oldName": ["newName"]}}`); they are never applied to exact lookups and are shown as labelled suggestions. The plugin has no built-in aliases.

---

## 3. Primary CLI Usage (Fast-Path, Universal Across Solo, Subagents & Swarms)

Read-only CLI queries skip loading TypeScript/adapters whenever the SQLite index is clean on the current Git HEAD (~150–180 ms cold start vs ~650 ms before) and work identically in solo sessions, subagents, and native swarm workers:

```bash
# Assess a repository and write <repo>/.ast-graph/manifest.json
node ~/.gemini/config/plugins/ast-graph/dist/cli.js assess --workspace /path/to/repo

# Full or incremental sync
node ~/.gemini/config/plugins/ast-graph/dist/cli.js sync --workspace /path/to/repo

# Query symbols, property references, file outlines, search, lineage, blast radius, and tests
node ~/.gemini/config/plugins/ast-graph/dist/cli.js outline <File1> [File2...] [--filter <kw>] [--limit <n>] --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js symbol <Sym1> [Sym2...] --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js search <Q1> [Q2...] [--kind <kind>] --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js refs <Prop1> [Prop2...] --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js lineage <SchemaOrRouteOrTable> --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js blast <SymbolOrFile> --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js tests <SymbolOrFile> --workspace /path/to/repo
```

**Delegating?** Subagents and swarm workers usually only see their brief. Paste the exact CLI line with the worker's worktree path into every brief for code work, e.g. `Code navigation: node ~/.gemini/config/plugins/ast-graph/dist/cli.js outline|symbol|refs|search|blast|tests <targets...> --workspace /abs/repo/.worktrees/<item> (not grep/sed/cat).` A nonexistent `--workspace` path now fails with `WORKSPACE_NOT_FOUND` (exit 2) instead of creating an empty index.

The SessionStart hook injects the same CLI line, the repo root, and linked worktrees into the session (Antigravity `injectSteps` / Claude Code `additionalContext`). Disable with `AST_GRAPH_SESSION_HINT=0`.

---

## 4. Optional MCP Tools (`ast-graph`)

All MCP tools accept an optional `workspace` parameter (repository path or registered repository name):

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

### Workspace Resolution

When `workspace` is omitted, the target repository is resolved in this order:

1. An absolute file path in the arguments (its enclosing repo).
2. The client's MCP workspace roots (`roots/list`). One root becomes the default; with several, the server probes them for the symbol or file.
3. The server's launch directory (`AST_GRAPH_WORKSPACE` / `--workspace` / cwd), but **only if it is not a plugin install directory** (this plugin's root, `~/.gemini/config/plugins`, `~/.claude/plugins`, `~/.codex/plugins`).
4. A probe of registered repos (`~/.gemini/config/ast-graph-workspaces.json` or `AST_GRAPH_REGISTRY_PATH`, plus `~/GitHub/*/.ast-graph`) for a matching relative path or symbol.

If none of these match, the tool returns `NO_WORKSPACE` with the list of known repositories. A `workspace` value that is not an existing path or a registered repo name returns `UNKNOWN_WORKSPACE`. The server never silently queries the plugin directory.

### Schema Versioning

`ast.db` carries `PRAGMA user_version` (also `meta.schema_version`); the current version is `AstGraphDatabase.SCHEMA_VERSION`. On open:

- **Older or legacy layouts** (for example, the `labels_json` column from older forks): the derived index tables are dropped, the repo binding in `meta` is kept, and the next query runs a full cold sync automatically.
- **A newer version** (written by a newer plugin build): the open is refused with `SCHEMA_TOO_NEW`. Upgrade the plugin, or delete `.ast-graph/`.

### Output Contract (compact, summary-first, inline-budgeted)

- Every text result is **at most about 3.8 KB** (4.6 KB for multi-target batches), so agent harnesses keep it inline instead of spilling it to a file.
- Line 1 is the header (`[repo=…] [AST …]`). It is followed **immediately** by the `=== TARGET SUMMARY ===` block (top match, exact `filePath#L<start>-L<end>`, recommended `read_file` range or test command), then `--- details ---`.
- When a top-level symbol in `outline` or `symbol` is a large container (`> 250` lines, such as `createApp` or `App`), `Recommended Action` points to the first bounded inner symbol (`<= 250` lines) or a capped 200-line window for targeted edits. For coupled visual/procedural files (Three.js scenes, shaders, Blender builders) or long symbols where holistic context is needed, agents may read the full symbol or up to `<= 800` contiguous lines in one `read_file` call instead of repeating 250-line micro-reads.
- When results exceed the budget, only detail lines are dropped. The footer says how many lines were omitted and where the full output was saved: `<repo>/.ast-graph/last/<command>.txt`.
- `ast_outline` prints the file path once in the header. Detail lines carry only `L<start>-L<end>` spans. `ast_search` groups hits under each file path and ranks primary source code symbols ahead of `StylesheetSection` rules, docs/mockups, and test files.
- Default limits: search 15, outline 65 (30 per file in batches), refs 25 per category, symbol 20. Narrow with `filter`, `kind`, or `limit` rather than raising the limit.
- **Batch instead of grep alternations.** `ast_search`, `ast_symbol`, and `ast_refs` accept `queries: [...]` / `targets: [...]`. Each batch item keeps its own summary within a shared budget.
- Zero-result diagnostics:
  - `NOT INDEXED` (run `ast_sync` with `paths`).
  - `Kinds present in this repo: …` for an unmatched `kind`.
  - A `grep -rn` recommendation for string literals / UI copy / log text, which are not symbols.
- TypeScript class members report `exp` only when public. `private`, `protected`, and `#private` members are not marked exported.
