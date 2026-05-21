---
name: session-journal
description: |
  Logs and tracks active programming sessions and user discussions in a hidden `.sessions/` directory.
  Summarizes challenges faced and lists ideas/code samples for public educational content (blogs, videos, snippets).
  Automatically manages `.gitignore` to keep sessions local and out of public version control.
license: Apache-2.0
metadata:
  version: v1
  publisher: google
---

# Session Journal Skill

This skill enables the coding agent to automatically log, track, and summarize active coding sessions and user discussions. It compiles local diaries for each session and keeps a master **Executive Summary** updated. These materials are extremely useful for tracing project history, identifying tricky bugs/solutions, and cataloging ideas for educational blogs, videos, or open-source code examples.

To maintain workspace cleanliness, this skill automatically configures the repository's `.gitignore` file to ensure no session logs are accidentally checked into public version control.

---

## 🛠️ Setup & Directory Structure

Inside the active workspace, the session logs are stored in a hidden directory:
```text
<workspace_root>/
└── .sessions/
    ├── session_<conversation_id>.md  <-- Current active session journal
    ├── session_abcdef12-3456-7890.md <-- Past session journal
    └── executive_summary.md          <-- Master summary & index (AUTO-GENERATED)
```

The workspace's `.gitignore` file is automatically appended with `.sessions/` to keep all logs entirely local to the user's system.

---

## 🔄 Step-by-Step Workflow

To ensure session logs and the executive summary stay updated and accurate, follow this workflow **unconditionally** in every conversation:

### Step 1: Initialize the Active Session Journal
At the start of the session, or immediately upon loading this skill:
1. Locate your active **Conversation ID** (from the prompt metadata or your conversation transcript).
2. Create a new markdown file: `.sessions/session_<conversation_id>.md`.
3. Fill out the frontmatter and structure using the **Session Journal Template** below. Set `status` to `In-Progress`.

### Step 2: Manage Git Exclusions
Run the helper script to create directory structures and verify the `.gitignore` exclusion:
```bash
python3 <global_agent_directory>/skills/session-journal/scripts/summarize.py --workspace <workspace_path> --conv-id <conversation_id>
```

### Step 3: Log & Update as the Session Runs
As you perform work (editing files, fixing compiler warnings, passing tests, discovering undocumented project behavior):
1. **Log Key Decisions**: Document why a specific implementation pattern was chosen over another.
2. **Track Challenges**: Note when you encounter complex issues (e.g. tricky pointer errors in Go, unhandled middleware exceptions, container setup complications).
3. **Brainstorm Public Content**: Keep an eye out for features or bug-fixes that would make excellent blog posts, video tutorials, or open-source code templates.

### Step 4: Finalize and Compile Executive Summary
At key milestones during the session, or right before ending your turn:
1. Update the active journal file (`session_<conversation_id>.md`) and set the `status` to `Completed` (if the session's objective has been achieved) or keep it `In-Progress`.
2. Run the compiler script to automatically generate or update the master `executive_summary.md`:
   ```bash
   python3 <global_agent_directory>/skills/session-journal/scripts/summarize.py --workspace <workspace_path> --conv-id <conversation_id>
   ```
3. **Document Multi-Session Themes**: Open the compiled `executive_summary.md` and inspect the list of prior sessions. Identify long-running patterns, recurring bugs, or overarching architectural themes. Document these inside the protected comment boundaries under the **🎯 Multi-Session Themes & Consolidated Content** section:
   ```markdown
   <!-- START_CUSTOM_THEMES -->
   ### Theme Title (e.g., Zero Compile Warning Initiative)
   - **Pattern**: We solved compile warnings in session X, Y, and Z, leading to the creation of an automated policy.
   - **Consolidated Blog Idea**: "From Chaos to Zero: Building an Automated Zero-Warning Policy in Monorepos"
   <!-- END_CUSTOM_THEMES -->
   ```
   These comment boundaries tell the compiler daemon to preserve and carry over your manual theme logs completely intact when rebuilding the summary.
4. Verify that the script runs successfully and lists your new session in the master directory.

---

## 📝 Session Journal Template

Use this exact structure for individual session markdown files (`.sessions/session_<conversation_id>.md`):

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

## 🎯 Objective
Describe the primary goal or issue that this session was created to address.

## 🗺️ Key Discussions & Decisions
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
