# Agent Skills & Plugins Repository Guide (`AGENTS.md`)

This repository packages reusable multi-harness AI coding skills and plugins across **Google Antigravity (`agy`)**, **Claude Code (`claude`)**, and **OpenAI Codex CLI (`codex`)**:

- **`plugins/ast-graph-traceability`**: Multi-compiler AST & Cross-Layer Lineage GraphDB sidecar, stdio MCP server (`warehouse-ast-graph`), `SessionStart`/`PostToolUse` lifecycle hooks, rules (`rules/AGENTS.md`), and skill (`skills/ast-graph-traceability/SKILL.md`).
- **`.skills/*` & `.agents/skills/*`**: Standalone skills (`ast-graph-traceability`, `apple_container`, `gcp_auth`, `llm_tutor`, `session-journal`, `update_documentation`).
- **`.claude-plugin/marketplace.json`**: Claude Code plugin marketplace manifest (`claude plugin marketplace add davenportjw/agent-skills`).
- **`.agents/plugins.json` & `.agents/skills.json`**: Google Antigravity discovery manifests.
