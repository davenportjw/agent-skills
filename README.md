# Agent Skills & Plugins

Reusable plugins and skills for Google Antigravity, Claude Code, and OpenAI Codex.

The flagship plugin in this repo is [`ast-graph`](plugins/ast-graph): a local code graph that stops coding agents from burning tokens scanning whole files and repositories by hand.

## Why Use `ast-graph`

Left on their own, coding agents run broad `grep` searches and read thousands of lines of code in chunks just to find a definition, check who calls it, or figure out which tests to run. That makes sessions slow and expensive.

`ast-graph` builds a fast local index (`.ast-graph/ast.db`) for each repository so the agent gets exact line numbers, callers, upstream blast radius, and covering tests in milliseconds.

Every codebase and prompt is different, but typical results look like:

- ~70%–90% reduction in discovery tokens vs. raw `grep` and full-file chunk reading.
- 5x–15x fewer lines read per task: the agent reads only the exact `startLine–endLine` span it needs.
- Compact ~3.8 KB tool responses: summary-first outputs keep your context window clean over long sessions.
- Targeted test runs: runs only the tests linked to the changed code (`vitest`, `pytest`, `go test`) instead of the entire test suite.

## Language Support & Limitations

- Full AST, call graph, property reads/writes, & test mapping: TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.mjs`), Python (`.py`, requires `python3`), Go/Templ (`.go`, `.templ`), and Rust (`.rs`).
- Polyglot structural & cross-layer indexing: Java (`.java`), Kotlin (`.kt`, `.kts`), C# (`.cs`), Ruby (`.rb`), Elixir (`.ex`, `.exs`), PHP (`.php`), C/C++ (`.c`, `.cc`, `.cpp`, `.h`, `.hpp`), Swift (`.swift`), Zig (`.zig`), and WebAssembly/WIT (`.wat`, `.wit`).
- API contracts, SQL DDL, & infrastructure lineage: Protobuf (`.proto`), GraphQL (`.graphql`, `.gql`), SQL DDL (`.sql`, `.sqlx` — tables, columns, FKs, views, indexes), Terraform/HCL (`.tf`, `.hcl`, `.tfvars`), and Dockerfile (`Dockerfile`, `Containerfile`). Connects HTTP/RPC routes, schemas, SQL tables, container stages, and environment variables (`scip-env global env 1.0.0 <NAME>#`) across languages.
- Web & stylesheet structure: HTML, Jinja2, Vue, Svelte, Astro (delegates `<script>` blocks to the TS parser), and CSS.
- Section outlines only (`ast_outline`): Markdown, YAML, JSON, and TOML.

See [`plugins/ast-graph/README.md`](plugins/ast-graph/README.md) for the full support matrix and CLI usage.

## Quick Install

### `ast-graph` Plugin (Recommended)

```bash
git clone https://github.com/davenportjw/agent-skills.git
cd agent-skills/plugins/ast-graph
npm install
npm run build

# Link into Google Antigravity
ln -sfn "$(pwd)" ~/.gemini/config/plugins/ast-graph
```

For Claude Code:

```bash
claude plugin marketplace add davenportjw/agent-skills
claude plugin install ast-graph@davenportjw-agent-skills
```

### Standalone Skills

To install individual skills into your agent's global skills folder:

```bash
cp -R .skills/<skill_name> ~/.gemini/config/skills/<skill_name>
```

| Skill / Plugin | Purpose |
| :--- | :--- |
| [`ast-graph`](plugins/ast-graph) | Local code & cross-layer dependency graph (`ast_symbol`, `ast_outline`, `ast_refs`, `ast_blast_radius`, `ast_tests_for`, `ast_lineage`). |
| [`apple_container`](.skills/apple_container) | Replaces Docker with Apple's native container CLI on macOS. |
| [`gcp_auth`](.skills/gcp_auth) | Google Cloud authentication patterns for Identity Platform, Firebase, and Cloud Run IAM. |
| [`llm_tutor`](.skills/llm_tutor) | Interactive curriculum-driven technical tutor skill. |
| [`session-journal`](.skills/session-journal) | Tracks and summarizes active coding sessions locally in `.local/sessions/`. |
| [`update_documentation`](.skills/update_documentation) | Keeps project docs and tests in sync after code changes. |

## License

Apache-2.0
