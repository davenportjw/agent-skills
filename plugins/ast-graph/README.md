# `ast-graph`

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
| Full AST + Call & Test Graph | TypeScript, JavaScript (`.ts`, `.tsx`, `.js`, `.mjs`), Python (`.py`), Go & Templ (`.go`, `.templ`) | Definitions, exact line spans, callers/callees, property reads vs. writes (`ast_refs`), upstream blast radius, and test mapping (`vitest`, `pytest`, `go test`). | Python indexing requires `python3` on `PATH`. Go uses a fast source parser rather than full `go/types` cross-module type resolution. |
| Cross-Layer Lineage | Zod, Pydantic, Fastify, FastAPI, Flask, Go `HandleFunc`, HTMX (`hx-*`), browser `fetch()`, SQL (`.sql`), Terraform (`.tf`) | Links frontend calls to backend routes, schemas, SQL `CREATE TABLE` definitions, and Terraform resources via `ast_lineage`. | Matches standard framework decorators and static route strings. Custom router wrappers or dynamically built URLs won't auto-link. |
| Composite Web & Styles | HTML, Jinja2, Vue, Svelte, Astro, CSS | Parses embedded `<script>` blocks via the TS compiler, maps DOM landmarks, and outlines CSS rules/sections. | Template control flow is mapped as structural landmarks, not a full dataflow graph. |
| Outline Only (On-Demand) | Markdown, YAML, JSON, TOML | `ast_outline` returns heading and top-level key line ranges so agents can read specific sections of large config/doc files. | Not stored in the symbol graph (`ast_search` and `ast_refs` do not query inside these files). |
| Unsupported | Rust, Java, C/C++, C#, Ruby, PHP, Kotlin, Swift | None today. | Agents must fall back to standard `grep` / `rg` and file reads. |

### Other Practical Limits

- Static analysis only: runtime reflection, dynamic imports, and metaprogramming won't show up in the call graph.
- Symbols, not string literals: use `ast-graph` for code structure and identifiers. For UI copy, log messages, or raw text searches, standard `grep -rn` is still the right tool.
- Zero repo pollution: stores the index in `<repo>/.ast-graph/` and adds it to `.git/info/exclude` automatically so `git status` stays clean.

## Installation

### 1. Build the plugin

```bash
cd plugins/ast-graph
npm install
npm run build
```

### 2. Link into your agent harness

Google Antigravity:

```bash
ln -sfn "$(pwd)" ~/.gemini/config/plugins/ast-graph
```

Claude Code:

```bash
claude plugin marketplace add davenportjw/agent-skills
claude plugin install ast-graph@davenportjw-agent-skills
```

### 3. Optional CLI usage

```bash
# Index a repository
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
