# 🤖 Agent Skills: Developer-First Agentic Tooling

Welcome to the **Agent Skills** repository! This is a curated collection of global skills, scripts, and sidecar configurations designed to supercharge your pair-programming experience with agentic AI coding assistants.

These skills run **globally** inside your agent's App Data environment, enabling automated repository logging, workspace diagnostics, and developer-first workflows without polluting your codebase or Git history.

---

## 📚 Documentation

The full documentation for all skills is available on our [GitHub Pages site](https://jasondavenport.github.io/agent-skills/).

## 🛠 Available Skills

This repository includes the following curated skills:

* **`apple_container`**: Replaces Docker with Apple's native container CLI for local development, orchestration, and Kubernetes.
* **`gcp_auth`**: Implement and debug Google Cloud Authentication using Identity Platform, Firebase, and Cloud Run IAM.
* **`llm_tutor`**: A generic tutor skill that reads a curriculum YAML schema, adapts to user personas, and interactively guides learners.
* **`session-journal`**: Automatically logs, tracks, and summarizes active coding sessions and discussions inside your workspace.
* **`update_documentation`**: A skill to verify and update project documentation after changes or walkthrough creation.

---

## 🚀 Installation Guide

To install and load these skills into your active coding assistant's global environment, copy the desired directories into your App Data Directory's skills folder (e.g., `<global_agent_directory>/skills/`):

```bash
# Example: Install the update_documentation skill
cp -R .skills/update_documentation <global_agent_directory>/skills/update_documentation
```

For more complex skills like `session-journal`, additional setup may be required for sidecar daemons. Please see the [Documentation](https://jasondavenport.github.io/agent-skills/) for detailed installation steps per skill.


---

## 📄 License
This collection of skills is released under the **Apache-2.0 License**. Feel free to fork, modify, and share them with your teams!
