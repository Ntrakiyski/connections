---
name: autonomous-init
description: Adopt Autonomous Harness in an existing repository. Use when setting up project-local delivery state, mapping existing project documentation, or checking whether the project is ready to use the other Autonomous Harness skills.
---

# Autonomous Init

Set up durable Harness state without replacing the repository's existing truth.

## Procedure

1. Read `references/framework-bridge.md`. On first setup, include its
   framework URL in the handoff to the operator and Hermes.
2. Read the root `AGENTS.md` if present. Inspect the project for architecture,
   design, database, testing, and product documents.
3. Inspect `AGENTS.md`, `.autonomous/`, `.specify/`, and `specs/`. Treat every
   existing file as user-owned.
4. If `.autonomous/` already exists, read it and report which expected files
   are missing. Ask before replacing a conflicting Harness file.
5. Create `.autonomous/` with these files from `assets/project-state/`:
   `PROJECT.md`, `CONTEXT.md`, and `GUARDRAILS.md`. Create `phases/`,
   `evidence/`, and `retrospectives/` directories.
6. Create root `AGENTS.md` from the asset only when no root `AGENTS.md` exists.
   Otherwise leave it unchanged and record it in `CONTEXT.md`.
7. Create `.autonomous/state.json` only after the project inspection succeeds:

   ```json
   {
     "schema_version": 1,
     "harness": {
       "initialized_at": "<current RFC 3339 timestamp>",
       "skills_version": "0.1.0",
       "spec_kit_initialized": false
     },
     "project": {
       "status": "initialized",
       "active_milestone": null,
       "milestones": []
     }
   }
   ```

   Replace the timestamp token with the actual current time. If `.specify/`
   exists, set `spec_kit_initialized` to `true`.

8. Report whether `.specify/` exists and the framework handoff. Do not create,
   edit, move, or copy `.specify/`: `autonomous-spec` is blocked until Spec Kit
   initializes it.

## State Rules

- `state.json` is current lifecycle state, not an event log.
- Product intent stays in `PROJECT.md`; Spec Kit feature content stays under
  `specs/`.
- Treat unknown information as unknown. Ask for it rather than inventing it.

## Verify

- Confirm `.autonomous/PROJECT.md`, `CONTEXT.md`, `GUARDRAILS.md`, and
  `state.json` exist.
- Confirm the JSON parses and has `schema_version`, `harness`, and `project`.
- Confirm existing root instructions and source documentation remain unchanged.
