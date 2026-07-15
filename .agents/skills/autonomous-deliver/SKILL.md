---
name: autonomous-deliver
description: Execute one approved Spec Kit feature or task using Autonomous Harness. Use when implementation is in scope, the active feature has tasks, and the work needs tests, evidence, a structured handoff, and lifecycle-state updates.
---

# Autonomous Deliver

Implement one approved vertical slice and leave enough evidence for the next
agent to continue without chat history.

## Procedure

1. Read root instructions, `.autonomous/PROJECT.md`, `CONTEXT.md`,
   `GUARDRAILS.md`, `state.json`, the active phase manifest, and the active
   `specs/<number>-<slug>/tasks.md`.
2. Read handoffs for every blocking task. Stop when scope, prerequisites, or
   safety boundaries are unclear.
3. Confirm one in-scope vertical slice. Inspect existing project patterns and
   plan tests at the affected seam before editing.
4. Implement the smallest compliant change. Preserve existing conventions and
   do not make unrelated improvements.
5. Run the relevant tests. Save raw terminal output, screenshots, traces, or
   reports under `.autonomous/evidence/`.
6. Write the phase handoff as JSON with exactly these keys:

   ```json
   {
     "ticket_id": "",
     "status": "done",
     "changed_files": [],
     "tests_run": 0,
     "tests_passed": 0,
     "decisions": [],
     "blockers": [],
     "needs_review": true,
     "evidence_paths": []
   }
   ```

7. Update the phase manifest with handoff and evidence paths. If status is
   `blocked`, set the active milestone status to `blocked` in `state.json`.
   Otherwise keep it `in_progress` until a gate evaluates the work.

## Verify

- Every claimed test result has an evidence path.
- The handoff JSON parses and has all required keys.
- `state.json` changes only the active milestone fields owned by this work.
