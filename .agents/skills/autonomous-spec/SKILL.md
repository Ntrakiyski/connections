---
name: autonomous-spec
description: Turn approved scope into one governed Spec Kit feature. Use when a project with Autonomous Harness and initialized Spec Kit needs a specification, plan, tasks, and an active milestone record.
---

# Autonomous Spec

Create one independently shippable vertical feature through Spec Kit without
creating a competing Harness specification format.

## Preconditions

Read `.autonomous/PROJECT.md`, `CONTEXT.md`, `GUARDRAILS.md`, and `state.json`.
Read root project instructions and the approved scope.

Stop and report a blocker when:

- approved scope is missing or ambiguous;
- `.specify/` does not exist; or
- `state.json` does not parse or has no `schema_version: 1`.

Do not create `.specify/` or use a fallback spec format. Tell the user to
initialize Spec Kit first.

## Procedure

1. Identify one vertical feature that is small enough to specify, implement,
   test, and review independently.
2. Use the installed Codex Spec Kit skills in order: constitution when project
   governance needs establishing or updating, then specify, clarify, plan,
   tasks, and analyze.
3. Verify one feature directory under `specs/<number>-<slug>/` contains
   `spec.md`, `plan.md`, and `tasks.md`.
4. Create or update `.autonomous/phases/phase-<number>.md` from the phase
   manifest template. Record the exact feature directory and any blockers.
5. Update `state.json` only after all three artifacts exist. Add the feature
   directory to the active milestone's `feature_directories`, set that
   milestone to `in_progress`, and set `project.status` to `active`.

## State Rules

- A milestone has `id`, `status`, `started_at`, `completed_at`,
  `feature_directories`, and `last_gate`.
- Valid statuses are `planned`, `in_progress`, `blocked`, `ready_for_gate`,
  and `complete`.
- Read current state before updating it. Do not remove another milestone or
  overwrite fields unrelated to this feature.

## Verify

- Confirm Spec Kit owns the new files under `specs/`.
- Confirm `.autonomous/` contains only the manifest, not copied spec files.
- Confirm the manifest path and `state.json` feature directory agree.
