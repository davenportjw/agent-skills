---
name: adaptive-learning
description: Interactive mastery-based learning journeys that embed <agent-embed> simulators, code diffs, and Mermaid diagrams directly inside native ask_question cards, validate answers via callback, and pivot to alternative teaching modalities when a learner misses a concept.
---

# Adaptive Learning Journeys (`adaptive-learning`)

This skill drives closed-loop, mastery-based learning journeys in Google Antigravity by combining:
1. **Rich Inline Modality Embedding inside `ask_question`**: Placing `<agent-embed src="file:///..."></agent-embed>`, ````diff` blocks, ````python` / ````json` snippets, and ````mermaid` diagrams directly inside `ask_question`'s `question` and `options` fields.
2. **Deterministic Callback Validation (`journey-engine.mjs`)**: Grading every `ask_question` response against a packaged curriculum DAG (`journeys/*.json`).
3. **Misconception-Driven Modality Pivoting**: When a learner misses a comprehension check, diagnosing the exact distractor misconception, switching to an **alternative representation modality** (`embed_simulator` → `diff_and_mermaid` or `execution_trace`), and re-asking an **isomorphic comprehension question**.

---

## 1. Packaged Learning Journeys

| Journey ID | Title | Core Concepts Covered |
| :--- | :--- | :--- |
| `agentic-ui-architectures` | **Journey 1: Agentic UI Architectures** | Declarative A2UI v0.9 JSONL component catalogs & JSON Pointer bindings vs. MCP Apps (`ui://` resources + `postMessage` JSON-RPC 2.0) vs. Gemini constrained decoding (`response_schema`). |
| `token-economics-and-ast-graph` | **Journey 2: Multi-Agent Token Economics & AST-Graph** | Subagent cold-start tax (`~8k–15k` tokens) vs. direct `ast_symbol`/`ast_refs` span lookups, high-entropy log quarantine in Flash subagents, and Context-Zero orthogonal cross-model validation. |
| `cloud-run-l4-and-vertex-inference` | **Journey 3: Cloud Run L4 GPU & Vertex AI Inference Architecture** | TTFT/cost crossover between Gemma 4 on Cloud Run L4 GPU (`min_instance_count=1`, `max_instance_request_concurrency=32`, `cpu_idle=false`) and Vertex AI Gemini 3.8 Flash, plus ADC auth and automated `try/finally` GCS/BigQuery benchmark teardown. |

---

## 2. Step-by-Step Execution Loop

### Step 1: List Journeys or Fetch Current Step
Run `journey-engine.mjs` passing the current conversation's `<artifactDirectoryPath>` so any bundled micro-widget (`widgets/*.html`) is automatically synced and stamped with `file:///<artifactDirectoryPath>/...`:

```bash
# List all available journeys and mastery status
node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs list

# Fetch the current active step (primary or remediation modality) for a journey
node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs step agentic-ui-architectures "<artifactDirectoryPath>"
```

### Step 2: Render the Step Directly via `ask_question`
Take `askQuestionPayload` (`question`, `options`, `is_multi_select: false`) from `journey-engine.mjs step` and pass it directly to the `ask_question` tool:
- Do **not** add `(Recommended)` to comprehension check options.
- If `syncedWidgetPath` is non-null, the `question` field already contains `<agent-embed src="file:///<artifactDirectoryPath>/<widget>.html"></agent-embed>` so the interactive simulator renders directly inside the `ask_question` header!

### Step 3: Validate the Callback Response & Branch
When `ask_question` returns `A1: <selected_option_text>`, validate it deterministically:

```bash
node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs validate \
  "<journeyId>" \
  "<nodeId>" \
  "<selected_option_text>" \
  "<artifactDirectoryPath>"
```

- **If `passed: true`**:
  - Congratulate the learner concisely and immediately present `nextStep.askQuestionPayload` via `ask_question` (until `nextStep.completed === true`).
- **If `passed: false` (`actionRequired: "PIVOT_MODALITY_AND_REASK"`)**:
  - Output the `diagnosis` explaining *why* that distractor was a trap.
  - Immediately invoke `ask_question` with `remediationStep.askQuestionPayload`, which presents the concept using a **different visual/code modality** (e.g., an annotated ````diff` and ````mermaid` diagram embedded in the question header) and asks an **isomorphic comprehension question**!

---

## 3. Authoring Custom Journeys On the Fly

When a user asks to learn a topic not yet in `journeys/*.json`:
1. Follow the exact 2-modality node schema in `journeys/agentic-ui-architectures.json`:
   - `primaryModality`: Interactive `<agent-embed>` micro-widget (`<200px` height) or code walkthrough embedded inside `ask_question`.
   - `misconceptions`: Map each wrong option index (`"1"`, `"2"`) to a clear diagnostic explanation.
   - `remediationModality`: A contrasting representation (`diff_and_mermaid_in_question` or `execution_trace_in_question`) + an isomorphic question testing the same invariant from a new angle.
