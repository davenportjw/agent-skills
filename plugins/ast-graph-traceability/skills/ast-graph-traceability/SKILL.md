---
name: ast-graph-traceability
description: >-
  Queries and maintains the multi-compiler AST & Cross-Layer Lineage GraphDB
  (.ast-graph/ast.db, SCIP + SQLite LPG) for symbol localization, upstream
  blast-radius analysis, protocol/route/Terraform lineage tracing, targeted
  Vitest test selection, and structural health benchmarking. Activate this skill
  whenever fixing bugs, refactoring shared symbols, modifying @warehouse/protocol
  Zod schemas, changing Fastify/WebSocket endpoints, selecting targeted tests,
  or analyzing architectural coupling and complexity.
---

# AST GraphDB Traceability & Targeted Fix Workflow (`@warehouse/ast-sidecar`)

The `warehouse` monorepo runs a multi-compiler **AST & Cross-Layer Lineage GraphDB Sidecar** ([`tools/ast-sidecar`](../../tools/ast-sidecar/src/index.ts)) backed by a git-ignored **SQLite Labeled Property Graph** (`.ast-graph/ast.db` in WAL mode with `FTS5` BM25 search and forward/reverse CSR B-Tree adjacency indexes) and deterministic **Sourcegraph SCIP Symbol URIs**.

Use the AST GraphDB **before** falling back to broad multi-file text greps or full-file dumps. Every query automatically verifies file freshness (`mtimeMs` + SHA-256) in `<2ms` and incrementally re-indexes any modified files (`<50ms`) before executing recursive CTE traversals.

---

## 1. When to Activate This Skill

Activate and follow this workflow whenever you are:
1. **Localizing a Bug or Investigating Behavior**: Finding exact definitions, signatures, JSDoc, callers, callees, and shortest dependency paths across `packages/*`, `apps/*`, `tools/*`, and `infra/*.tf`.
2. **Modifying Shared Code or Protocol Schemas**: Computing the transitive upstream blast radius (`CALLS`, `REFERENCES`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `VALIDATES_SCHEMA`) before changing `@warehouse/protocol`, `@warehouse/sim`, `@warehouse/armor`, `@warehouse/lobby`, `@warehouse/site`, or `@warehouse/client`.
3. **Tracing Cross-Layer Lineage**: Following a Zod protocol schema (`ZodSchema`), Fastify HTTP/WebSocket route (`RouteEndpoint`), or Terraform resource (`TerraformResource`) across client, lobby gateway, site engine, and Cloud Run infrastructure.
4. **Selecting Targeted Unit Tests**: Identifying the exact Vitest `describe`/`it`/`test` blocks (`TESTS_SYMBOL`, `TESTS_FILE`) that cover a modified symbol or its upstream blast radius.
5. **Auditing Structural Health & Fix Efficiency**: Measuring Robert C. Martin package coupling/instability ($C_a, C_e, I$), untested high-fan-in hubs, circular dependencies, and token/file reduction benchmarks.

---

## 2. Query Surfaces: MCP Tools & CLI Commands

Prefer calling the **MCP Server tools** (`warehouse-ast-graph`) directly when available (zero Node/shell process spawn overhead), or use the **root npm CLI scripts** (which connect to the local HTTP sidecar daemon on `http://127.0.0.1:4319` with a `50ms` connect / `2500ms` response timeout or open `.ast-graph/ast.db` directly in SQLite WAL mode with a cross-process `.ast-graph/sync.lock` guard):

| Operation | MCP Tool (`warehouse-ast-graph`) | CLI Command (`npm run ast:query -- ...`) | HTTP Daemon Endpoint (`127.0.0.1:4319`) |
| :--- | :--- | :--- | :--- |
| **Symbol Lookup & Neighborhood** (supports batch) | `ast_symbol` (`{ query, queries?, kind?, limit? }`) | `npm run ast:query -- symbol <sym1> [sym2...]` | `GET /symbol?q=<name>&kind=<kind>` |
| **Property / Field Read & Write References** (supports batch) | `ast_refs` (`{ target, targets?, limit? }`) | `npm run ast:query -- refs <prop1> [prop2...]` | `GET /refs?q=<propOrSymbol>&limit=40` |
| **File Symbol Outline** (supports batch) | `ast_outline` (`{ filePath, filePaths?, filter?, kind?, exportedOnly?, limit? }`) | `npm run ast:query -- outline <file1> [file2...] [--filter <substr>] [--kind <kind>] [--exported]` | `GET /outline?file=<path>&filter=<substr>` |
| **Fuzzy Symbol Search** | `ast_search` (`{ query, kind?, limit? }`) | `npm run ast:query -- search <query> [--kind <kind>] [--limit <n>]` | `GET /search?q=<query>&kind=<kind>` |
| **Transitive Blast Radius** | `ast_blast_radius` (`{ target, maxHops? }`) | `npm run ast:query -- blast-radius <symbolOrFile> [--hops 3]` | `GET /blast-radius?target=<idOrName>&hops=3` |
| **Targeted Vitest Selection** | `ast_tests_for` (`{ target }`) | `npm run ast:query -- tests-for <symbolOrFile>` | `GET /tests-for?target=<idOrFile>` |
| **Cross-Layer Lineage** | `ast_lineage` (`{ target }`) | `npm run ast:query -- lineage <schemaOrRouteOrTf>` | `GET /lineage?target=<schemaOrRoute>` |
| **Shortest Dependency Path** | `ast_shortest_path` (`{ from, to, maxHops? }`) | `npm run ast:query -- path <fromSymbol> <toSymbol>` | `GET /path?from=<symA>&to=<symB>` |
| **Incremental / Full Sync** | `ast_sync` (`{ full?, paths? }`) | `npm run ast:sync` (or `npm run ast:query -- sync [--full]`) | `POST /sync` |
| **Structural Health Report** | `ast_analyze` (`{}`) | `npm run ast:analyze` | `GET /analyze` |
| **Traceability Benchmark** | `ast_benchmark` (`{}`) | `npm run ast:benchmark` | `GET /metrics` |
| **OpenCypher / JSONL Export** | — | `npm run ast:export -- [--format cypher\|jsonl]` | — |

---

## 3. Strict Anti-Chunking, Batching & Contradiction Circuit-Breaker Mandate

1. **NEVER Chunk-Read Large Files**:
   - **NEVER** call `view_file` without `StartLine` and `EndLine` on files larger than 250 lines.
   - **NEVER** page through large files (`packages/sim/src/engine.ts` [7,030+ lines], `apps/client/src/main.ts`, `apps/site/src/server.ts`, etc.) in sequential 800-line chunks (`1-800`, `801-1600`, `1601-2400`, ...).
2. **Sequential AST-First Execution (No Speculative Parallel Reads)**:
   - **NEVER** fire speculative `view_file` calls in the same turn/parallel batch as an AST query.
   - Always execute `ast_symbol`, `ast_refs`, `ast_outline`, or `ast_search` (or `npm run ast:query -- symbol|refs|outline|search`) **first**, read the `=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===` block at the bottom of the output to get the exact `filePath#L<start>-L<end>`, and **then** call `view_file` once with that exact `StartLine` and `EndLine` (plus at most `±30` lines of context).
3. **Use `refs` (`ast_refs`) for State / Field Mutation & Read Tracking**:
   - Whenever investigating state bugs, timers, flags, or protocol fields (e.g., `runEndsAt`, `depletedRunVid`, `runStartedAt`), run:
     ```bash
     npm run ast:query -- refs runEndsAt depletedRunVid
     ```
     or call `ast_refs({ targets: ["runEndsAt", "depletedRunVid"] })` to immediately separate `WRITES_PROPERTY` (assignment/mutation sites) from `READS_PROPERTY` (read/guard sites) with exact enclosing method spans (`L<start>-L<end>`).
4. **Batch Multi-Target Queries Instead of Chaining Shell Commands**:
   - Pass multiple symbols, properties, or files in a single call (`npm run ast:query -- symbol symA symB symC`, `npm run ast:query -- refs propA propB`, `npm run ast:query -- outline fileA fileB`).
   - **NEVER** chain `npm run ast:query` with `&& git diff` or `&& git log` in the same shell command; a multi-hundred-line diff pushes the AST query result out of the 8KB inline tool preview window and forces extra `view_file` steps on `.system_generated/steps/*/output.txt`.
5. **Historical Contradiction Circuit-Breaker**:
   - If the AST graph shows that a user-reported bug or regression is **not** present in the current working tree (`HEAD`), run **at most ONE** bounded git pickaxe command (`git log -G"<symbolOrField>" -n 5 --oneline`) to check recent commits.
   - If the change is not in recent git history, **STOP** running `git log` / `git status` loops on the main thread. Either check `gcloud run revisions list` (if investigating a deployed service mismatch) or delegate session transcript archaeology (`~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl`) to the `research` subagent.

---

## 4. The 4-Step Traceability-Driven Fix Workflow

### Step 1: Localize Symbol, State Field Mutations & Cross-Layer Lineage
Instead of reading entire files to find where a symbol, state field, or message type is handled:
```bash
# Inspect exact symbol signature, file/line span, outgoing callees, and incoming callers (supports multiple targets)
npm run ast:query -- symbol humanInteract startPersonalRun

# Locate all WRITES_PROPERTY (mutations) and READS_PROPERTY (reads) for class/interface/Zod fields
npm run ast:query -- refs runEndsAt depletedRunVid

# List all matching symbols & line ranges in a large file when the exact name is unknown
npm run ast:query -- outline packages/sim/src/engine.ts --filter interact

# Fuzzy-search across all workspace symbols
npm run ast:query -- search interact

# Trace a @warehouse/protocol Zod schema or HTTP/WS route across client, lobby, and site
npm run ast:query -- lineage ClientMessageSchema

# Find the shortest dependency chain between two symbols
npm run ast:query -- path parseClientMessage step
```
Read **only** the targeted file line ranges (`startLine`–`endLine`) returned in the `=== TARGET SUMMARY ===` footer.

### Step 2: Compute Upstream Blast Radius Before Editing
Before changing any function signature, class method, property, exported type, or Zod schema:
```bash
npm run ast:query -- blast-radius <symbolOrPropertyNameOrUri>
```
Review:
- **Impacted Nodes by Hop Distance (`hop = 1..3`)**: Every caller, property writer/reader, importer, or subtype across `@warehouse/sim`, `@warehouse/armor`, `@warehouse/lobby`, `@warehouse/site`, and `@warehouse/client`.
- **Impacted Workspace Packages**: Verify whether downstream packages need coordinated updates.
- **Covering Test Files**: Note the exact list of Vitest test files and `Recommended Test Command` returned in the `=== TARGET SUMMARY ===` footer.

### Step 3: Implement the Fix & Verify Incremental AST Sync
Apply your code changes using `replace_file_content` or `write_to_file`.
- In **Antigravity** (`.agents/hooks.json`) and **Claude Code** (`.claude/settings.json`), the `PostToolUse` hook (`hook-handler.js post-tool-use`) automatically re-indexes the edited file in `<50ms` (up to 32 dirty files per fast incremental batch).
- If running bulk shell changes, run `npm run ast:sync` to ensure `.ast-graph/ast.db` reflects all modifications and has zero new compiler diagnostics.

### Step 4: Run Targeted Tests & Measure Structural Health
1. Query and execute the exact Vitest test suites covering your modified symbols first for sub-second feedback:
   ```bash
   npm run ast:query -- tests-for <symbolOrFile>
   npx vitest run <returned-test-file-paths>
   ```
2. Run the structural analyzer to confirm zero circular dependencies, zero TypeScript compiler diagnostics, and no new high-fan-in untested hubs:
   ```bash
   npm run ast:analyze
   ```
3. When completing a cross-package feature or benchmark task, run the full test suite (`npm test`) and empirical benchmark (`npm run ast:benchmark`).

---

## 4. Multi-Compiler Extension Guide (`CompilerAdapter` & SCIP URI Convention)

The AST GraphDB schema is language-agnostic and supports concurrent multi-process writes via SQLite `WAL` mode (`busy_timeout = 5000`).

### SCIP Symbol URI Standard
Every node is uniquely identified by a deterministic SCIP URI:
$$\texttt{<scheme> <manager> <package> <version> <descriptor-chain>}$$

- **TypeScript (`ts.Program`)**: `scip-ts npm @warehouse/sim 0.1.0 src/engine.ts/SimEngine#step().`
- **Zod Protocol Contract**: `scip-contract zod @warehouse/protocol 0.1.0 ClientMessageSchema#`
- **HTTP / WebSocket Endpoint**: `scip-endpoint http @warehouse/lobby 0.1.0 POST:/api/join#`
- **Terraform HCL (`infra/*.tf`)**: `scip-tf hcl infra 1.0.0 infra/main.tf/resource:google_cloud_run_v2_service#lobby.`
- **Python (`ast` / `uv`)**: `scip-py uv pkg 0.1.0 module.py/ClassName#method().`

### Adding a New Compiler Adapter
To add a new language or compiler (e.g., Go, Rust, SQL, C++):
1. Implement `CompilerAdapter` in `tools/ast-sidecar/src/adapters/<lang>-adapter.ts`:
   - `name`: Unique adapter identifier (e.g. `'rust-syn'`).
   - `supports(filePath)`: File extension predicate.
   - `extract(filePaths, workspaceRoot)`: Parses files and returns a `CompilerGraphBatch` containing normalized `files` (with SHA-256 and `mtimeMs`), `nodes` (with SCIP `id`, `kind`, `labels`, `startLine`, `endLine`, `signature`, `complexity`, and `properties`), `edges` (`srcId`, `dstId`, `kind`, `filePath`, `line`), and `diagnostics`.
2. Register the adapter in `tools/ast-sidecar/src/index.ts`. No SQLite DDL migration is required because node metadata is stored in `JSONB`/JSON properties alongside the multi-label `node_labels` table and CSR edge indexes.
