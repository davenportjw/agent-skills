# `adaptive-learning` — Mastery-Based Learning Journeys Plugin for Google Antigravity

`adaptive-learning` packages interactive, closed-loop learning journeys that render **`<agent-embed>` micro-simulators, `diff` blocks, syntax-highlighted code blocks, and Mermaid diagrams directly inside Antigravity's native `ask_question` cards**, validate learner responses via a deterministic callback engine (`scripts/journey-engine.mjs`), and automatically pivot to an alternative teaching modality (`remediationModality`) with an isomorphic comprehension question whenever a learner misses a concept.

## Packaged Journeys (`journeys/`)
1. **`agentic-ui-architectures`**: Google A2UI v0.9 (Declarative JSONL Component Catalogs & JSON Pointers) vs. MCP Apps (`ui://` resources + `window.parent.postMessage` JSON-RPC 2.0) vs. Gemini Constrained Decoding (`response_schema`).
2. **`token-economics-and-ast-graph`**: Subagent Cold-Start Tax (`~8k–15k` tokens) vs. Direct `ast-graph` Span Lookups, High-Entropy Log Quarantine, and Context-Zero Orthogonal Cross-Model Validation.
3. **`cloud-run-l4-and-vertex-inference`**: Gemma 4 on Cloud Run L4 GPU (`min_instance_count = 1`, `max_instance_request_concurrency = 32`, `cpu_idle = false`) vs. Vertex AI Gemini 3.8 Flash TTFT/cost crossover and automated `try/finally` GCS/BigQuery evaluation teardown.

## Bundled Reference Code (`examples/`)
- `examples/example1_a2ui_rollout.py`: Google Antigravity SDK (`google-antigravity`) + A2UI v0.9 JSONL streaming with strongly typed `CanaryDataModel` and `ToolContext` callbacks.
- `examples/mcp_ui_server.py` & `examples/example2_mcp_app_host.py`: FastMCP/MCPServer `ui://canary-studio/rollout-widget.html` resource + JSON-RPC 2.0 `postMessage` bridge.
- `examples/true_generated_a2ui_and_mcp_runtime.html`: Live interactive runtime comparing dynamic A2UI JSONL surface compilation and reactive `DataModel` updates vs. MCP Apps sandboxed iframe execution.
- `examples/eval_harness_teardown.py` & `examples/deploy/cloud_run_l4_service.tf`: Terraform configuration for Gemma 4 on Cloud Run L4 GPU and Python evaluation harness with guaranteed post-run GCS/BigQuery teardown.

## CLI & Testing Quick Reference
```bash
# List all packaged journeys and mastery progress
node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs list

# Fetch the active step (and sync its micro-widget into the conversation artifact dir)
node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs step agentic-ui-architectures "<artifactDir>"

# Validate an ask_question callback response
node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs validate agentic-ui-architectures wire_protocol_and_security "Option A" "<artifactDir>"

# Run plugin unit tests (Vitest) + Python example tests (uv pytest)
cd plugins/adaptive-learning && npm test
cd plugins/adaptive-learning/examples && uv run pytest
```
