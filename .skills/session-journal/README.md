# Session Journal

A skill that keeps running markdown journals for each coding session and maintains an executive summary index across sessions. Works with any AI coding agent that can read markdown and write files (Claude Code, Gemini CLI, OpenCode, etc.).

## What it does

When a session starts, the skill creates a timestamped markdown file under `.local/sessions/` and populates it with the current branch and a focus line from the user's first message. As work happens, it appends to the session file at natural breakpoints: finished tasks, bugs found, decisions made, surprising problems.

At session end (and at major milestones), it updates an executive summary index at `.local/sessions/SESSION-INDEX.md`. The summary tracks recent sessions, quick stats, active threads, key decisions, and content opportunities -- topics worth turning into blog posts, videos, or code examples.

All session data stays local. The skill adds `.local/` to `.gitignore` on first run so nothing gets committed.

## File layout

```
.skills/
  session-journal/
    SKILL.md          # The skill definition
    README.md         # This file

.local/
  sessions/
    SESSION-INDEX.md  # Executive summary index across all sessions
    session_2026-05-21-1045.md
    session_2026-05-21-1422.md
    ...
```

## Setup

The skill is self-activating for agents that support skill auto-discovery from a `.skills/` directory. For agents that don't, add a one-liner to the agent's instruction file:

- **Claude Code**: Add `@.skills/session-journal/SKILL.md` to your CLAUDE.md
- **Gemini CLI**: Add `@.skills/session-journal/SKILL.md` to your GEMINI.md
- **OpenCode**: Point to the skill in your agent config

No other setup required. The skill handles directory creation and gitignore management on first run.

## Session file format

Each session file has these sections:

- **Objective / Focus** -- what this session was created to address
- **Key Chronology & Steps** -- what tools and operations were run
- **Technical Challenges & Workarounds** -- detailed problems, causes, and fixes
- **Public Content Opportunities** -- customized templates for blogs, videos, and code snippets

## How it stays out of the way

Session notes update during natural pauses between tasks, not mid-flow. The skill won't interrupt you to ask about notes or prompt you for summaries. It folds updates into the gaps between work.
