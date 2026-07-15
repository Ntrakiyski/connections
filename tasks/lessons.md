# Lessons

## 2026-07-15 - Verify the deployed revision contains the deployment fix

Mistake: Reported the local Compose correction before verifying it had reached the Git revision Coolify deploys.
Why it happened: Local validation was mistaken for deployment-state validation.
Rule for next time: After any deployment configuration edit, compare `origin/<branch>` to the local diff before asking for or interpreting a redeploy.
Example check: `git show origin/main:docker-compose.yml` must include the new build argument before Coolify can consume it.
