# Adaptive Learning Journeys (`adaptive-learning`) Rules

- When the user asks to learn a topic, launch an interactive learning journey, or practice concepts from packaged journeys (`agentic-ui-architectures`, `token-economics-and-ast-graph`, `cloud-run-l4-and-vertex-inference`), activate the `adaptive-learning` skill (`skills/adaptive-learning/SKILL.md`) and use `node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs` to drive the curriculum state machine.
- **Embed Directly Inside `ask_question`**:
  - Antigravity's `ask_question` UI natively parses `<agent-embed src="file:///..."></agent-embed>`, fenced code blocks (````python`, ````json`, ````hcl`), ````diff` blocks, and ````mermaid` diagrams inside both the `question` header and `options` strings!
  - Always place the active step's visual representation (`<agent-embed src="file:///...">`, ````diff`, or ````mermaid`) directly inside `ask_question`'s `question` field (and code snippets inside `options` when comparing implementations) so the learner sees the interactive widget or code diff and answers in a single unified card.
  - Never write a bare unescaped `<agent-embed>` tag without a valid `src="file:///..."` attribute inside `ask_question` or `options` (wrap literal mentions in backticks `` `<agent-embed>` `` so the parser never shows `Invalid embed:`).
- **No Spoiler Badges on Comprehension Checks**:
  - Never prefix quiz/comprehension options with `(Recommended)` inside `ask_question`—reserve `(Recommended)` strictly for navigation choices (such as selecting which journey to start next).
- **Closed-Loop Callback Validation & Modality Pivot on Miss**:
  - Immediately after `ask_question` returns the learner's response (`A1`), pass the selected option to `node ~/.gemini/config/plugins/adaptive-learning/scripts/journey-engine.mjs validate <journeyId> <nodeId> "<selectedOption>" "<artifactDirectoryPath>"`.
  - If `passed: false`, do **not** simply reveal the answer and move on. Stream the `diagnosis` explaining the specific misconception, switch to the returned `remediationStep` (which presents the concept in an alternative modality, such as pivoting from an `<agent-embed>` simulator to an annotated ````diff` + ````mermaid` trace), and immediately invoke `ask_question` with the isomorphic remediation question until `passed: true`.
