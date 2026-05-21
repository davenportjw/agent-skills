---
name: session-journal
description: |
  Logs and tracks active programming sessions and user discussions in a local hidden `.local/sessions/` directory.
  Maintains a rolling `SESSION-INDEX.md` across all sessions, highlighting key decisions, active threads, and content opportunities.
  Supports both manual updates and fully automated tracking via background sidecar.
  Automatically manages `.gitignore` to keep sessions local and out of public version control.
license: Apache-2.0
metadata:
  version: v2
  publisher: google
---

# Session Journal Skill

This skill enables the coding agent to automatically (or manually) log, track, and summarize active coding sessions and user discussions. It compiles local diaries for each session and keeps a master **Session Index** (`SESSION-INDEX.md`) updated. These materials are extremely useful for tracing project history, identifying tricky bugs/solutions, and cataloging ideas for educational blogs, videos, or open-source code examples.

To maintain workspace cleanliness, this skill automatically configures the repository's `.gitignore` file to ensure no session logs are accidentally checked into public version control.

---

## 🛠️ Setup & Directory Structure

Inside the active workspace, the session logs are stored in a local directory:
```text
<workspace_root>/
└── .local/
    └── sessions/
        ├── session_<conversation_id>.md  <-- Current active session journal
        ├── session_abcdef12-3456-7890.md <-- Past session journal
        └── SESSION-INDEX.md              <-- Master index & summary (AUTO-GENERATED / MANUAL HYBRID)
```

The workspace's `.gitignore` file is automatically appended with `.local/` to keep all logs entirely local to the user's system.

---

## 🔄 Step-by-Step Workflow

To ensure session logs and the session index stay updated and accurate, follow this workflow:

### Step 1: Initialize the Active Session Journal
At the start of the session, or immediately upon loading this skill:
1. Locate your active **Conversation ID** (from the prompt metadata or your conversation transcript).
2. Create a new markdown file: `.local/sessions/session_<conversation_id>.md`.
3. Fill out the frontmatter and structure using the **Session Journal Template** below. Set `status` to `In-Progress`.

### Step 2: Manage Git Exclusions
Ensure the `.local/` directory is ignored by checking/updating `.gitignore`. If `.local/` is not listed, append it.
*(If using the Python helper script, this is automated on every run).*

### Step 3: Log & Update as the Session Runs
As you perform work (editing files, fixing compiler warnings, passing tests, discovering undocumented project behavior):
1. **Log Key Decisions**: Document why a specific implementation pattern was chosen over another.
2. **Track Challenges**: Note when you encounter complex issues (e.g. tricky pointer errors in Go, container setup complications).
3. **Brainstorm Public Content**: Keep an eye out for features or bug-fixes that would make excellent blog posts, video tutorials, or open-source code templates.

*Note: If the background sidecar tracker is running, these updates are automatically compiled from your conversation transcript, but you should still manually customize the notes with extra depth when appropriate.*

### Step 4: Finalize and Compile Session Index
At key milestones during the session, or right before ending your turn:
1. Update the active journal file (`session_<conversation_id>.md`) and set the `status` to `Completed` (if the session's objective has been achieved) or keep it `In-Progress`.
2. Run the compiler script to automatically generate or update the master `SESSION-INDEX.md`:
   ```bash
   python3 .skills/session-journal/scripts/summarize.py --workspace <workspace_path> --conv-id <conversation_id>
   ```
3. **Document Cross-Session Themes & Active Threads**: Open the compiled `SESSION-INDEX.md` and inspect the list of prior sessions. Identify long-running patterns, recurring bugs, or overarching architectural themes. Document these inside the protected comment boundaries under the **🎯 Cross-Session Themes** and **🔄 Active Threads** sections to preserve them across automated runs.

---

## 📝 Session Journal Template

Use this exact structure for individual session markdown files (`.local/sessions/session_<conversation_id>.md`):

```markdown
---
id: "<conversation_id>"
title: "<High-Level Session Title / Focus>"
date: "<YYYY-MM-DD>"
status: "<In-Progress | Completed>"
summary: "<A clear 2-3 sentence summary of the session's objective and core achievements>"
challenges:
  - "<Core Challenge 1 or Tricky Bug solved>"
  - "<Core Challenge 2 or undocumented quirk>"
content_ideas:
  - "<Content Idea 1 (e.g., Blog: How to design a secure router in Go)>"
  - "<Content Idea 2 (e.g., Video: Automating session summaries with Python scripts)>"
---

# 📓 Session Journal: <High-Level Session Title>

**Branch**: `<current git branch>`
**Focus**: <one-line summary from the user's first message>

## 🎯 Objective / Focus
Describe the primary goal or issue that this session was created to address.

## 🗺️ Key Chronology & Steps
Provide a chronological or structured summary of what was discussed with the user, what decisions were made, and why:
- **Decision A**: Detailed explanation of technical choices.
- **Refactor B**: Why a specific file was cleaned up or redesigned.

## 🔧 Technical Challenges & Workarounds
Detail any particularly difficult bugs, undocumented system traits, or compiler gotchas encountered:
- **The Problem**: Describe the bug, error message, or behavior.
- **The Cause**: Why did this happen? Reference specific files or API limitations.
- **The Fix / Workaround**: Explain the exact code changes made to solve it. Provide concrete code examples if useful.

## 💡 Public Content Opportunities & Code Examples
Identify topics from this session that are highly educational or could be turned into public developer content:

### ✍️ Blog Post Ideas
- **Topic / Title**: E.g., "Avoiding Git Pollution: Creating Auto-Expiring Local Sessions"
- **Focus**: What developers will learn.
- **Key Snippet**: A short, copy-pasteable code block demonstrating the pattern.

### 🎥 Video Tutorial Concepts
- **Title/Outline**: E.g., "Live Coding: Setting up a Gemini AI Agent Skill"
- **Visual Walkthrough**: What you would show on screen (e.g., demonstrating the automated .gitignore update).

### 📦 Open-Source Snippets / Templates
- **Idea**: E.g., "A generic JSONL transcript parser in Python standard library"
- **Usage**: How other developers can reuse this snippet.
```

---

## 🎓 Content Opportunity Guidelines

When identifying topics for public content, look for:
- **"Aha!" Moments**: When you solved a bug that was not immediately obvious from documentation.
- **Elegant Solutions**: Implementation patterns that reduce code duplication (like the config monorepo strategy).
- **Toolchain Integrations**: Tricky command lines or automation scripts that save hours of manual work.
- **TDD Workflows**: Writing clean integration tests before implementing backend features.

### 🎯 Multi-Session / Cross-Session Themes
Sometimes, the best content ideas span multiple programming sessions. Look out for:
- **Multi-Session Bug Hunts**: Tricky race conditions, configuration drift, or memory leaks that took several sessions to track down and fix. Create a cohesive troubleshooting story detailing the steps, tools, and logical deductions that led to the solution.
- **Architectural Evolutions**: Substantial refactoring efforts (e.g., moving dashboard pages from generic templates to dynamic serving) that happen across multiple steps. Explain the "before and after" architectures and the engineering trade-offs.
- **Systemic Pain Points**: Recurring issues (like local environment credential locks or sandbox directory exclusions) that highlight the need for automated solutions. Write conceptual blogs on building robust developer tools.
