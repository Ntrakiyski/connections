---
name: autonomous-gate
description: Run an evidence-backed PRD, specification, code, or ship gate for an Autonomous Harness phase. Use when a feature needs a documented progression decision based on project constraints and verification evidence.
---

# Autonomous Gate

Evaluate one progression boundary. A pass is evidence-backed; missing evidence
is a failure, never an assumption.

## Procedure

1. Select exactly one mode: `prd`, `spec`, `code`, or `ship`.
2. Read the active artifact, root instructions, `.autonomous/PROJECT.md`,
   `CONTEXT.md`, `GUARDRAILS.md`, `state.json`, phase manifest, and available
   evidence.
3. Read `references/checklist-methodology.md` and the matching mode example:
   `prd-gate.md`, `spec-review.md`, `code-review.md`, or `ship-gate.md`.
   Derive specific yes-or-no checks from the current scope, architecture,
   design, testing rules, prior learnings, and the selected boundary.
4. Write `.autonomous/phases/gate-<mode>.md` with the source paths, checks,
   evidence links, and one result: `pass`, `fail`, or `blocked`.
5. Update the phase manifest and the active milestone's `last_gate` in
   `state.json` after verification. A passed ship gate sets the milestone to
   `complete`; a passed earlier gate sets it to `ready_for_gate`; a failed or
   blocked gate records that result without erasing prior evidence.

## Boundaries

- Do not deploy, merge, or waive a failed check.
- The reference files are prompts, not static checklists. Do not copy one
  without deriving project-specific checks.
- Do not mark a missing artifact or missing evidence as pass.

## Verify

- Every passing check links to a source path, command result, or evidence file.
- The gate result agrees with the state and phase manifest.
- The gate changes only `last_gate` and the active milestone status in
  `state.json`.
