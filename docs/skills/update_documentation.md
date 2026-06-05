# Update Documentation

A skill to verify and update project documentation after changes or walkthrough creation.

## Description

This skill ensures that the project's documentation remains in sync with the current state of the codebase, especially after significant changes or when a walkthrough artifact is created.

## Triggers

- Use this skill AFTER creating a walkthrough artifact.
- Use this skill AFTER performing significant architectural changes.
- Use this skill AFTER implementing new features that require setup instructions.
- Use this skill when asked to "update documentation" or "document recent changes."

## Instructions

1. **Analyze Changes:** Review the recent changes in the codebase or the content of the newly created walkthrough.
2. **Identify Documentation:** Identify the primary documentation files for the project.
    - Search for the main project `README.md` or system design files in the root directory.
    - Look for component-level documentation in subdirectories (e.g., `docs/`).
3. **Verify Accuracy:** Check if the document accurately reflects:
    - Current setup instructions
    - New or modified features
    - Architecture diagrams or descriptions
    - Configuration variables
4. **Update the Documentation Site (MkDocs):** If you are working in the `agent-skills` repository, you MUST update the central documentation in the `docs/` folder whenever skills are added, modified, or removed.
    - Check `mkdocs.yml` for navigation changes.
    - Create, delete, or modify the corresponding `docs/skills/*.md` files.
    - Verify your changes locally using `uv run --with mkdocs-material mkdocs build`.
5. **Update Other Docs:** If discrepancies are found elsewhere, utilize file writing tools to edit the documentation files:
    - Improve clarity
    - Fix outdated commands
    - Add new sections for new features
6. **Report:** Summarize the documentation updates performed to the user.
