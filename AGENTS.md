# Agent Skills & Plugins Repository Guide (`AGENTS.md`)

This repository packages reusable multi-harness AI coding skills and plugins across **Google Antigravity (`agy`)**, **Claude Code (`claude`)**, and **OpenAI Codex CLI (`codex`)**:

- **`plugins/ast-graph`**: The canonical multi-repo AST & Cross-Layer Lineage GraphDB plugin. It includes a stdio MCP server (`ast-graph`), `SessionStart`/`PostToolUse` lifecycle hooks, rules (`rules/AGENTS.md`) and the `ast-graph-traceability` skill (`skills/ast-graph-traceability/SKILL.md`). `plugins/ast-graph-traceability` is a deprecated stub; do not add code there.
- **`.skills/*`**: Standalone skills (`apple_container`, `gcp_auth`, `llm_tutor`, `session-journal`, `update_documentation`).
- **`.claude-plugin/marketplace.json`**: Claude Code plugin marketplace manifest (`claude plugin marketplace add davenportjw/agent-skills`).
- **`.agents/plugins.json` & `.agents/skills.json`**: Google Antigravity discovery manifests.
