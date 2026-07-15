# Task Plan

## Goal

Ensure Coolify builds and runs this repository's Connections application rather than the upstream OpenConnector image, and make the deployed web console receive its required Clerk build-time configuration.

## Constraints

- Preserve the existing Connections runtime and persistent `connector-data` volume.
- Do not expose or commit deployment secrets.
- Keep the Docker/Coolify change minimal and compatible with local Compose use.

## Steps

- [x] Review the product constraints, current Git revision, deployment log, and Docker configuration.
- [x] Trace server and web-console configuration from image build through runtime.
- [x] Correct the Compose build configuration.
- [x] Validate the rendered Compose configuration and production web build.
- [x] Record evidence and required Coolify configuration.
- [x] Reproduce the reported blank console locally and compare the deployed source with the local fix.

## Verification

- [x] Compose configuration resolves to a local `docker/Dockerfile` build.
- [x] Clerk publishable key is forwarded to the Vite build as a public build argument.
- [x] Production web build includes the forwarded Clerk key.
- [x] No secrets appear in tracked files or command output.

## Review

Coolify built local source at commit `37074b0`; the deployment log shows a local build context and a local image tagged with that commit, with no GHCR application-image pull. The blank console was caused by that deployed commit's missing Compose `build.args` mapping: Coolify received `CLERK_PUBLISHABLE_KEY`, but the Vite bundle needs `VITE_CLERK_PUBLISHABLE_KEY`. `docker-compose.yml` now maps the former to the latter, and local production build/browser validation showed the Clerk sign-in screen rather than a blank page. `npm run fix-check` passed. Redeploy after this change reaches `main`; keep server secrets runtime-only in Coolify.
