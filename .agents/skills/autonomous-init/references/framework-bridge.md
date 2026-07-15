# Autonomous Harness Framework Bridge

This skill is the project-local agent interface to Autonomous Harness. The
full Hermes-led operating model remains in the source repository:

`https://github.com/Ntrakiyski/autonomous-harness/tree/main/docs/framework`

Use this boundary:

```text
User -> Hermes -> orchestration -> coding agent -> installed skill
```

- Hermes and the operator use the framework to decide roles, scope, handoffs,
  and progression.
- This skill maps the consuming project's existing truth into `.autonomous/`.
- Do not copy framework files into the consuming project.
- Report the framework link on first setup so the operator can align Hermes
  before directing specification or delivery work.
