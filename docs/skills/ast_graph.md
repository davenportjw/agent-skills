# `ast-graph` Plugin

Coding agents waste time and money scanning thousands of lines of code just to find where a symbol lives, what mutates a field, or what breaks when you change a shared schema.

`ast-graph` indexes your repo into a local graph (`.ast-graph/ast.db`) so agents jump straight to exact line spans, upstream callers, and covering tests instead of paging through whole files.

## Why It Matters

Every codebase and task is different, but in practice we see:

- ~70%–90% fewer context tokens: less budget spent on code search and file reading compared to raw `grep` and chunked file reads.
- 5x–15x fewer lines read per task: agents read surgical `startLine–endLine` ranges instead of 800-line file chunks.
- ~3.8 KB max tool responses: query outputs are summary-first and capped so tool results never blow up your context window.
- Faster verification loops: maps edits directly to the specific tests that cover those symbols (`vitest`, `pytest`, `go test`) instead of running the full suite on every turn.

## Language Support & Depth

Not every file type gets the same level of analysis. Here is what is supported and to what extent:

| Tier | Languages / Files | What Works | Limitations |
| :--- | :--- | :--- | :--- |
| Full AST + Call & Test Graph | TypeScript, JavaScript (`.ts`, `.tsx`, `.js`, `.mjs`), Python (`.py`), Go & Templ (`.go`, `.templ`), Rust (`.rs`) | Definitions, exact line spans, callers/callees, property reads vs. writes (`ast_refs`), upstream blast radius, and test mapping (`vitest`, `pytest`, `go test`, `cargo test`). | Python indexing requires `python3` on `PATH`. Go and Rust use fast source-level parsers rather than cross-crate compiler type resolution. |
| Polyglot Structural & Cross-Layer | Java (`.java`), Kotlin (`.kt`, `.kts`), C# (`.cs`), Ruby (`.rb`), Elixir (`.ex`, `.exs`), PHP (`.php`), C/C++ (`.c`, `.cc`, `.cpp`, `.h`, `.hpp`), Swift (`.swift`), Zig (`.zig`), WebAssembly/WIT (`.wat`, `.wit`) | Multi-line `startLine–endLine` spans for classes, structs, traits, interfaces, modules, methods, functions, and tests; links Spring Boot, ASP.NET, Rails, Phoenix, Laravel, and Symfony routes, ORM tables, and env vars. | Lexical/block-scoped analysis without full cross-file compiler symbol resolution. |
| API Contracts, SQL & Infra Lineage | Protobuf (`.proto`), GraphQL (`.graphql`, `.gql`), SQL (`.sql`, `.sqlx`), Terraform/HCL (`.tf`, `.hcl`, `.tfvars`), Dockerfile (`Dockerfile`, `Containerfile`) | Links frontend calls, RPC services, GraphQL operations, backend routes, schemas, SQL tables/views/FKs, Docker stages, Terraform resources, and environment variables (`CONFIGURES_ENV`) via `ast_lineage`. | Matches standard framework decorators and static route/table strings. Custom router wrappers or dynamically built URLs won't auto-link. |
| Composite Web & Styles | HTML, Jinja2, Vue, Svelte, Astro, CSS | Parses embedded `<script>` blocks via the TS compiler, maps DOM landmarks, and outlines CSS rules/sections. | Template control flow is mapped as structural landmarks, not a full dataflow graph. |
| Outline Only (On-Demand) | Markdown, YAML, JSON, TOML | `ast_outline` returns heading and top-level key line ranges so agents can read specific sections of large config/doc files. | Not stored in the symbol graph (`ast_search` and `ast_refs` do not query inside these files). |

### Other Practical Limits

- Static analysis only: runtime reflection, dynamic imports, and metaprogramming won't show up in the call graph.
- Symbols, not string literals: use `ast-graph` for code structure and identifiers. For UI copy, log messages, or raw text searches, standard `grep -rn` is still the right tool.
- Zero repo pollution: stores the index in `<repo>/.ast-graph/` and adds it to `.git/info/exclude` automatically so `git status` stays clean.

## Installation

### Claude Code

```bash
claude plugin marketplace add davenportjw/agent-skills
claude plugin install ast-graph@davenportjw-agent-skills
```

The MCP server and hooks install the one runtime dependency (`typescript`) into the plugin cache on first start. If you installed the old `ast-graph-traceability` plugin, run `claude plugin uninstall ast-graph-traceability@davenportjw-agent-skills` first.

### Google Antigravity

`dist/` is committed, so you only need the runtime dependency, then link the folder (the MCP config expects this exact path):

```bash
git clone https://github.com/davenportjw/agent-skills
cd agent-skills/plugins/ast-graph
npm install --omit=dev
ln -sfn "$(pwd)" ~/.gemini/config/plugins/ast-graph
```

Restart Antigravity after linking. If you have the old `~/.gemini/config/plugins/ast-graph-traceability` folder, remove it so the two don't both load. Don't also register a per-repo copy (for example an old `warehouse-ast-graph` MCP server or sidecar); the one global plugin serves every repo.

### OpenAI Codex CLI

Codex has no plugin hooks, so register the MCP server once in `~/.codex/config.toml` (or a repo's `.codex/config.toml`). Queries lazily re-sync changed files before answering, so no hook is required:

```toml
[mcp_servers.ast-graph]
command = "node"
args = ["--no-warnings", "/Users/<you>/.gemini/config/plugins/ast-graph/dist/mcp.js"]
```

## Multiple Repos, Worktrees & Concurrency

- One database per repo: each repository gets `<repo>/.ast-graph/ast.db`. A single MCP server process answers for any repo; tools take an optional `workspace` (name or path) and otherwise resolve from the session's roots/cwd.
- Repo boundaries: nested git checkouts (`.worktrees/*`, submodules, vendored clones) are never indexed into the parent. Query them with `workspace: "<path>"`; they get their own index.
- Moved or renamed checkouts are rebound automatically instead of failing a tamper check.
- Single writer: `.ast-graph/sync.lock` (PID + heartbeat) lets Claude Code, Antigravity, Codex, hooks, and CLI runs share one repo index. Non-owners answer from the last committed index (`[index busy]`); with no index yet they return `INDEX_BUILDING`.
- Hooks (Antigravity and Claude Code) re-index edited files after each write and watch Git lifecycle commands (`worktree add/remove/prune`, `switch/checkout/pull/merge/rebase/reset`, `init/clone`). New `.worktrees/<slug>` checkouts seed from the parent repo's `ast.db` in ~10 ms, `last_git_head` keeps branch switches in sync, and `PreToolUse` removes `<worktree>/.ast-graph` before `git worktree remove` so non-`--force` removals succeed cleanly while preserving dirty-file checks.
- Disk: the WAL is truncated after every sync (64 MB cap), SQLite freelist churn auto-vacuums above 16 MB / 25%, deleted checkouts auto-prune from `ast-graph-workspaces.json`, and the large `export.cypher` / `snapshot.jsonl` snapshots are only written when you ask (`export`, `sync --export`, `ast_sync export:true`).
- Repo-specific "did you mean" hints live in an optional `<repo>/ast-graph.config.json` (`{"aliases": {"OldName": ["newName"]}}`); suggestions are labelled and never returned as exact matches.

### Building from source

```bash
npm install
npm run build
npm test
```

### Optional CLI usage

```bash
# Index a repository (add --export to also write export.cypher / snapshot.jsonl)
node ~/.gemini/config/plugins/ast-graph/dist/cli.js sync --workspace /path/to/repo

# Look up a symbol, its blast radius, or covering tests
node ~/.gemini/config/plugins/ast-graph/dist/cli.js symbol <SymbolName> --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js blast-radius <SymbolOrFile> --workspace /path/to/repo
node ~/.gemini/config/plugins/ast-graph/dist/cli.js tests-for <SymbolOrFile> --workspace /path/to/repo
```

## Core MCP Tools

- `ast_symbol` / `ast_search`: Find definitions, signatures, callers, and callees.
- `ast_outline`: Get exact line spans for every symbol in a file before reading it.
- `ast_refs`: See where a property or field is read vs. mutated.
- `ast_blast_radius`: Check what breaks upstream before refactoring.
- `ast_tests_for`: Get the exact test command for the code you just touched.
- `ast_lineage`: Trace a schema, SQL table, or route across frontend, backend, and Terraform.
