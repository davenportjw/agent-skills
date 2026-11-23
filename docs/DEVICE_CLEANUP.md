# Cross-Device Global Config Cleanup & Sync Notes

Apply these steps on other machines after pulling `agent-skills` so global agent rules stay in sync.

## 2026-11-23 — Simplify Cross-Family Review & Remove Redundant Skills

### 1. Remove retired global skills

The two standalone cross-family/delegation skills duplicated `~/.gemini/GEMINI.md` and enforced a rigid 6-stress-vector checklist that verifiers largely ignored in practice. Remove them:

```bash
rm -rf ~/.gemini/config/skills/adversarial-subagent-challenger \
       ~/.gemini/config/skills/subagent-delegated-execution
```

### 2. Replace `## Cross-Family Verification` in `~/.gemini/GEMINI.md`

Replace the `## Cross-Family Verification (Gemini <-> Claude Opus)` section in `~/.gemini/GEMINI.md` with:

```markdown
## Cross-Family Review (Gemini <-> Claude Opus)

For **big pieces of work or large plans** (multi-module features, architectural/implementation plans, high-risk refactors), get a blind review from an opposite-family frontier model:

- **Pairing**: **Gemini-authored** work is reviewed by frontier **Claude (Opus)**; **Claude-authored** work is reviewed by frontier **Gemini**. Discover live model IDs via `swarm{action:"models"}` (never hardcode version strings, and never use `invoke_subagent`, which stays in the same family).
- **How to run**: Spawn a fresh, read-only swarm worker via `swarm{action:"add", name:"reviewer", model:"<opposite-family-id>", workspace:"inherit", brief:"..."}` (no `fork`).
- **Blind intake & self-directed review**: Pass only the user's request, relevant repo rules, and the plan or `git diff` (plus test results or live URL/screenshots if UI). Omit author reasoning and rationalizations. Ask the reviewer to **read the request, build its own review plan for what matters most here, and evaluate against it** — do not force a rigid checklist.
- **Verdict & cap**: Ask for `APPROVED` or `REWORK_REQUESTED` with concrete findings, and report **`Author -> Reviewer`** in the final handoff (or **`VERIFICATION_BLOCKED`** with the exact error if the opposite family cannot run; never silently downgrade to same-family or `flash`). Cap at 1 review + 1 follow-up re-check per milestone so work does not loop indefinitely.
- **Skip for small work**: Skip cross-family review for read-only questions, routine small edits (1–3 files), copy/config tweaks, or intermediate prototypes/greyboxes meant for quick user feedback.
```

### 3. Pull repo-level workflow updates

- **`turflight`** (`main`, commit `7272a88`): `git pull` to pick up the streamlined 3-stage iterative 3D workflow in `AGENTS.md`, `docs/GAMEPLAY_RUBRIC.md`, and `docs/GAME_PRODUCTION_PLAYBOOK.md`.
