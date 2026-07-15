# Task Plan

## Goal

Assess whether Connections should retain Clerk for identity and organization membership now that an InsForge backend is provisioned.

## Constraints

- No authentication, database, or cloud configuration changes.
- `connections-docs/LOCKED.md` is binding unless the user asks to revise it.

## Steps

- [x] Review product decisions, autonomous evidence, and the auth implementation.
- [x] Inspect the linked InsForge project and its authentication capabilities.
- [x] Compare both systems against Connections requirements.
- [x] State the recommendation and the scope of an alternative.

## Verification

- [x] Conclusions trace to locked decisions and implementation evidence.
- [x] InsForge platform claims checked against its CLI documentation and current metadata.
- [x] Security and migration implications identified.

## Review

Retain Clerk for human identity and workspace membership; use InsForge for managed PostgreSQL and private storage. InsForge Auth can authenticate users, but switching would make Connections responsible for end-user workspaces, invitations, switching, migration, and session integration. This contradicts the locked boundary and replaces existing verified Clerk/workspace behavior. No product or authentication changes were made.
