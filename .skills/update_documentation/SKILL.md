---
name: update_documentation
description: A skill to verify and update project documentation after changes or walkthrough creation.
---

# Update Documentation

<description>
This skill ensures that the project's documentation remains in sync with the current state of the codebase, especially after significant changes or when a walkthrough artifact is created.
</description>

<triggers>
- Use this skill AFTER creating a walkthrough artifact.
- Use this skill AFTER performing significant architectural changes.
- Use this skill AFTER implementing new features that require setup instructions.
- Use this skill when asked to "update documentation" or "document recent changes."
</triggers>

<instructions>
1. **Analyze Changes:** Review the recent changes in the codebase or the content of the newly created walkthrough.
2. **Identify Documentation:** Identify the primary documentation files for the project.
    - Search for the main project `README.md` or system design files in the root directory.
    - Look for component-level documentation in subdirectories (e.g., `docs/`).
3. **Verify Accuracy:** Check if the document accurately reflects:
    - Current setup instructions
    - New or modified features
    - Architecture diagrams or descriptions
    - Configuration variables
4. **Update:** If discrepancies are found, utilize file writing tools to edit the documentation files:
    - Improve clarity
    - Fix outdated commands
    - Add new sections for new features
5. **Report:** Summarize the documentation updates performed to the user.
</instructions>
