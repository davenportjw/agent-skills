# 🤖 Agent Skills: Developer-First Agentic Tooling

Welcome to the **Agent Skills** repository! This is a curated collection of global skills, scripts, and sidecar configurations designed to supercharge your pair-programming experience with agentic AI coding assistants.

These skills run **globally** inside your agent's App Data environment, enabling automated repository logging, workspace diagnostics, and developer-first workflows without polluting your codebase or Git history.

---

## 🛠 Available Skills

This repository includes the following curated skills:

* **[apple_container](skills/apple_container.md)**: Replaces Docker with Apple's native container CLI for local development, orchestration, and Kubernetes.
* **[gcp_auth](skills/gcp_auth.md)**: Implement and debug Google Cloud Authentication using Identity Platform, Firebase, and Cloud Run IAM.
* **[llm_tutor](skills/llm_tutor.md)**: A generic tutor skill that reads a curriculum YAML schema, adapts to user personas, and interactively guides learners.
* **[session-journal](skills/session-journal.md)**: Automatically logs, tracks, and summarizes active coding sessions and discussions inside your workspace.
* **[update_documentation](skills/update_documentation.md)**: A skill to verify and update project documentation after changes or walkthrough creation.

---

## 🚀 Installation Guide

To install and load these skills into your active coding assistant's global environment, copy the desired directories into your App Data Directory's skills folder (e.g., `<global_agent_directory>/skills/`):

```bash
# Example: Install the update_documentation skill
cp -R .skills/update_documentation <global_agent_directory>/skills/update_documentation
```

For more complex skills like `session-journal`, additional setup may be required for sidecar daemons. Please see their specific documentation pages for detailed installation steps per skill.
