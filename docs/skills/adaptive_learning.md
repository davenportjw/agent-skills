# `adaptive-learning` Plugin (Mastery-Based Learning Journeys)

`plugins/adaptive-learning` packages interactive, closed-loop learning journeys that embed **`<agent-embed>` micro-simulators, `diff` blocks, syntax-highlighted code snippets, and Mermaid diagrams directly inside Antigravity's native `ask_question` cards**, grade answers via a deterministic callback engine (`scripts/journey-engine.mjs`), and pivot to an alternative representation modality (`remediationModality`) with an isomorphic comprehension question whenever a learner misses a concept.

## Architecture: Embedded Modality Cards + Callback Validator + Modality Pivot

| Layer | Component | Role |
| :--- | :--- | :--- |
| **1. Curriculum DAGs** | `journeys/*.json` | Defines concept nodes with a `primaryModality` (e.g., interactive `<agent-embed>` simulator or side-by-side code comparison), distractor-to-`misconceptionId` mappings, and a contrasting `remediationModality` (`diff` + `mermaid` execution trace). |
| **2. Micro-Widgets** | `widgets/*.html` | Compact `<200px` interactive HTML simulators synced into the active conversation's artifact directory so `<agent-embed src="file:///...">` renders directly inside `ask_question`. |
| **3. Callback Engine** | `scripts/journey-engine.mjs` | CLI & state machine (`list`, `step`, `validate`, `reset`) that persists mastery progress to `~/.config/agent-skills/adaptive-learning-state.json` and drives closed-loop remediation. |
| **4. Reference Code** | `examples/*` | Verified Google Antigravity SDK (`google-antigravity`) A2UI v0.9 + MCP Apps (`ui://`) Python scripts, interactive HTML runtime, Cloud Run L4 Terraform config, and `uv` pytest suite. |

## Packaged Learning Journeys

1. **`agentic-ui-architectures`**: Declarative A2UI v0.9 JSONL component catalogs & JSON Pointer bindings vs. MCP Apps (`ui://` resources + `window.parent.postMessage` JSON-RPC 2.0) vs. Gemini constrained decoding (`response_schema`).
2. **`token-economics-and-ast-graph`**: Subagent cold-start tax (`~8k–15k` tokens) vs. direct `ast-graph` span lookups (`ast_symbol`, `ast_refs`), high-entropy log quarantine in Flash subagents, and Context-Zero orthogonal cross-model validation.
3. **`cloud-run-l4-and-vertex-inference`**: Gemma 4 on Cloud Run L4 GPU (`min_instance_count = 1`, `max_instance_request_concurrency = 32`, `cpu_idle = false`) vs. Vertex AI Gemini 3.8 Flash TTFT/cost crossover and automated `try/finally` GCS/BigQuery benchmark teardown.

## Installation & Usage

```bash
ln -sfn /Users/jasondavenport/GitHub/agent-skills/plugins/adaptive-learning ~/.gemini/config/plugins/adaptive-learning

# List all packaged journeys and mastery status
node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs list

# Fetch the current active step (syncing its micro-widget into the conversation artifact dir)
node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs step agentic-ui-architectures "<artifactDir>"

# Validate an ask_question callback response
node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs validate agentic-ui-architectures wire_protocol_and_security "Option A" "<artifactDir>"
```
