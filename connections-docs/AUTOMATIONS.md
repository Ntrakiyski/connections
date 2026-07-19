# Automations Feature Brief

Status: brainstorm note  
Date: 2026-07-18

## Summary

Automations extend Connections from a workspace-scoped provider connection and action runtime into a
workspace-scoped automation platform.

Connections already stores provider credentials, exposes authenticated provider Actions, enforces
workspace roles, issues runtime tokens, records runs, supports transit files, and exposes MCP and
HTTP APIs. Automations should sit on top of those existing capabilities instead of creating a
separate integration system.

The core product idea:

```text
Workspace
  -> connected provider accounts
  -> enabled provider actions
  -> automations
      -> client view
      -> development view
      -> step functions
      -> API trigger endpoint
      -> MCP management and execution tools
      -> versioned test and production runs
      -> logs
```

## Primary Use Case

Agency/developer creates a workspace for a client, connects the client's provider accounts, then
creates reusable automations that the client can run from a simple form, custom UI, API endpoint, or
agent tool.

Example OLX automation:

```text
Client input:
- image
- listing title/name
- price

Automation:
1. Validate the input.
2. Upload or prepare the image.
3. Suggest or resolve the OLX category.
4. Fetch category attributes if required.
5. Build the OLX advert payload.
6. Call olx.create_advert through Connections.
7. Return advert ID, URL, status, and any warnings.
```

The user/client does not need an agent. They get a form or endpoint. The automation code uses the
already authenticated workspace actions.

## Product Surfaces

Automations should be available through three surfaces:

```text
1. UI
   - create, inspect, edit, test, publish, and run automations

2. Runtime endpoint
   - trigger published automations from custom UIs or external systems

3. MCP
   - allow agents to create, edit, test, publish, and run automations
```

The UI is mainly for visibility, manual editing, demos, and client operation. In the expected agency
workflow, most automations will be created by an agent through MCP, not manually built from scratch
in the browser.

## Sidebar Entry

Add a workspace-scoped `Automations` tab to the existing sidebar.

Suggested access:

```text
Managers/Admins:
- create automations
- edit drafts
- generate code
- test
- publish
- inspect all runs

Members:
- run published automations they are allowed to use
- inspect their own run results, depending on workspace policy
```

## Automation Editor

Each automation editor should have two main views.

### Client View

The client view is the user-facing form and result surface.

It should be generated from the automation's input and output schemas:

```text
- input form
- required fields
- optional fields
- file uploads
- submit/run button
- validation messages
- final result
- run status
```

This is the view a client can understand and use without seeing the generated code.

### Development View

The development view is for the agency/developer and agents.

It should show:

```text
- automation metadata
- steps
- input schema
- output schema
- allowed actions
- generated code per step
- test controls
- logs/test output
- publish controls
```

The key model:

```text
One step = one function
```

Each step/function has:

```text
Input
Logic
Output
Allowed actions
Generated code
```

`Logic` is the English description of what should happen in the step. It can be optional when the
step is mostly a direct call to one provider action.

## Step Builder

From the user's perspective, creating or editing a step should feel like:

```text
1. Choose input type(s)
2. Describe the logic in English
3. Choose output type(s)
4. Select the allowed connected actions
5. Generate or regenerate code
6. Test the step
```

Input examples:

```text
- text
- number
- boolean
- select
- file
- image
- object/JSON
- array/list
```

Output examples:

```text
- text
- number
- URL
- status
- object/JSON
- file
- list
```

Generated code should be shown in the development view and stored in an automation version.

## Runtime Endpoint

Every published automation should be triggerable from an endpoint.

Possible shape:

```text
POST /v1/automations/:automationId/run
POST /v1/automations/:automationSlug/run
```

The request JSON body must match the automation input schema.

Example:

```json
{
  "title": "Used office desk",
  "price": 120,
  "imageUrl": "https://example.com/image.jpg"
}
```

The endpoint response should match the automation output schema.

Example:

```json
{
  "advertId": 123456,
  "url": "https://www.olx.bg/d/ad/example",
  "status": "active"
}
```

Endpoint auth needs to be explicit. Options to evaluate:

```text
- workspace runtime token
- automation-specific API key
- signed webhook secret
- public endpoint with secret path/token
- Clerk-authenticated workspace session
```

The default should be private, not public.

## MCP Tools

Automations should be exposed to agents as both management tools and execution tools.

Potential MCP management tools:

```text
list_automations
get_automation
create_automation
update_automation
delete_automation
create_automation_step
update_automation_step
delete_automation_step
generate_automation_code
test_automation
publish_automation
```

Potential MCP execution tools:

```text
list_published_automations
get_automation_input_schema
run_automation
```

This allows an agent to create and maintain automations for the agency, while also allowing agents to
execute published automations as normal tools.

## Execution Model

Automation code should not receive raw provider credentials.

Generated code should call a controlled helper:

```ts
await ctx.actions.call("olx.create_advert", {
  connectionName: "client-olx",
  input: {
    body: {
      title: input.title,
      price: { value: input.price },
      images: [input.imageUrl],
    },
  },
});
```

The call path should remain:

```text
Automation code
  -> controlled action helper
  -> Connections runtime
  -> workspace authorization
  -> action allowlist check
  -> stored provider credential
  -> provider API
```

The automation runtime should enforce:

```text
- workspace boundary
- action allowlist
- connection selection rules
- timeouts
- input validation
- output validation
- file limits
- run logging
- safety/approval policy
```

## Sandbox Runtime

For the first version, use a managed sandbox runtime such as Daytona or E2B to execute generated
code. A self-hosted runner can be evaluated later once the product behavior is proven.

Recommended initial language:

```text
TypeScript/JavaScript
```

Reasons:

```text
- current app is already TypeScript
- easier integration with existing schemas and action runtime
- easier MCP and API implementation
- lower MVP complexity
```

Python can be added later as a second runtime if there is strong demand for data-heavy scripts.

## Versioning

Automations should be versioned from the beginning.

Suggested lifecycle:

```text
Draft
  -> generated/tested
  -> published
  -> superseded by a newer published version
```

Important rule:

```text
Editing an automation should not silently change the currently published endpoint behavior.
```

Published versions should remain available for historical run inspection.

## Logging

Logging should be first-class and should reuse the current run logging philosophy.

There should be a parent automation run plus child step/action runs.

Automation run:

```text
- automation id/name
- version
- workspace
- trigger source: client UI, API endpoint, MCP, manual test
- caller user/token
- started/completed timestamps
- duration
- input summary
- final output summary
- status
- error code/message if failed
```

Step run:

```text
- step id/name
- step order
- started/completed timestamps
- duration
- input summary
- output summary
- action calls made
- retries
- status
- error code/message if failed
```

Provider action runs called from automations should remain visible in existing action run logs, but
linked back to the parent automation run.

UI example:

```text
Automations
  -> OLX Create Listing
      -> Runs
          -> Run #123
              -> Step 1: Validate input
              -> Step 2: Resolve category
              -> Step 3: Create advert
              -> Final output
```

## Safety And Permissions

Important safety rules:

```text
- only managers/admins can create or edit automations
- members can run only published automations they are allowed to access
- generated code can call only declared allowed actions
- generated code never sees OAuth tokens or API keys
- mutating actions still respect workspace safety and approval settings
- every run is logged
- published versions are immutable
- endpoint auth is explicit
```

Step failure behavior should be configurable:

```text
- stop
- retry
- continue
- fallback step
- require human review
```

## Data Model Sketch

Potential tables/entities:

```text
automations
- id
- workspace_id
- slug
- name
- description
- status
- created_by
- created_at
- updated_at

automation_versions
- id
- automation_id
- version
- status
- runtime
- input_schema
- output_schema
- created_by
- created_at
- published_at

automation_steps
- id
- automation_version_id
- order
- name
- input_schema
- logic_prompt
- output_schema
- allowed_actions
- generated_code

automation_runs
- id
- workspace_id
- automation_id
- automation_version_id
- trigger_source
- caller_user_id
- caller_token_id
- input_summary
- output_summary
- ok
- error_code
- error_message
- started_at
- completed_at

automation_step_runs
- id
- automation_run_id
- automation_step_id
- order
- input_summary
- output_summary
- ok
- error_code
- error_message
- started_at
- completed_at
```

Exact schema should be designed after reviewing current run and storage abstractions.

## Existing Connections Capabilities To Reuse

Automations should reuse:

```text
- workspace model
- Clerk organization mapping
- provider enablement
- provider connections
- action catalog
- action input/output schemas
- action execution runner
- runtime tokens
- MCP endpoint
- /v1 runtime API conventions
- transit files
- run logging
- safety and approval settings
- audit events
```

Avoid creating a parallel credential store, action registry, or logging system.

## Open Questions For Further Research

```text
1. Which sandbox should be used for MVP: Daytona or E2B?
2. What exact endpoint auth model should published automations use?
3. Should automation endpoints be stable by slug, id, or both?
4. How should client-facing forms be shared or embedded?
5. Should generated code be TypeScript only for MVP?
6. How should action approvals work during API-triggered automation runs?
7. Should automations support human approval between steps?
8. How should retries and idempotency work across multi-step automations?
9. How much of the automation builder should be manual UI vs agent-created through MCP?
10. How should file inputs map to current transit file handling?
```

## Recommended Next Step

Continue research with a focused design pass on:

```text
1. automation lifecycle and versioning
2. endpoint auth
3. MCP tool design
4. sandbox runner choice
5. parent/child run logging model
```

After those decisions, define a minimal MVP that can create, test, publish, and run one OLX
automation from UI, API, and MCP.
