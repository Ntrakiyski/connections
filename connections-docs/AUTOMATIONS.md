# Automations

Status: accepted product direction
Date: 2026-07-20

## Purpose

Automations turn a workspace's connected provider actions into reusable client products. An
automation accepts structured input, performs ordered steps using the workspace's existing provider
connections and actions, and returns a structured result.

Automations are not repository scripts and not a second integration system. Connections deploys the
generic automation platform once. Each client-specific automation is a versioned, workspace-scoped
record in the application database.

```text
Workspace
  -> labelled provider connections
  -> enabled provider actions
  -> versioned automation definition
  -> AutomationRunner
  -> parent automation run + child action runs
  -> client form, MCP, or private HTTP endpoint
```

Connections remains the only execution boundary for provider credentials, permission checks,
connection selection, action policy, files, and logs.

## Product Model

### MCP creates and maintains automations

The expected workflow is a person describing a client problem to an agent in chat. The agent uses
Connections MCP tools to inspect the active workspace's available providers, actions, schemas, and
labelled connections; then it creates or updates an automation draft.

The browser is not a general-purpose workflow or code builder. It is used to:

- inspect the automation and explain its steps to a client;
- configure only explicitly safe, schema-declared values;
- run the client form and inspect its result;
- test, publish, disable, inspect endpoints, and review logs;
- see the active version, draft, connections, actions, and recent runs.

Structural changes happen through MCP, including the step order, input/output schemas, allowed
actions, connection bindings, and execution plan. The UI must never expose provider credentials or
let a user bypass the action allowlist.

### One step is one understandable function

Every step has the same client-facing explanation:

```text
Input -> Logic -> Output
```

It also declares the provider actions and labelled connections it may use. A step's `logic` is a
human-readable explanation of the result it produces, not arbitrary executable code entered in the
browser.

For the MVP, the generic runner supports only these step kinds:

```text
input       validate and normalize form, API, or MCP input
action      call one existing Connections provider action
transform   map earlier output or render a configured template
return      validate and return the final automation output
```

The first shipped vertical slice also adds a first-class `schedule` step. It persists a local date
and IANA time zone, calculates its next UTC occurrence with Temporal, and handles one-time, daily,
or weekly schedules without changing the automation's executable structure.

The agent can compose those step kinds into an automation. A read-only technical view may show the
normalized execution plan or code preview, but that preview is not an editable source of truth.

## Execution Architecture

Connections already has an `ActionRunner`. It resolves the workspace-scoped connection, loads the
provider executor, enforces action policy, and writes the existing provider-action run log for one
action call.

Automations add one generic `AutomationRunner` in the same deployed Connections Node service. It
loads a versioned automation definition, validates its input, runs steps in order, carries each
step's output forward, writes parent and step logs, and delegates every provider call to the existing
workspace-scoped `ActionRunner`.

```text
MCP tool or HTTP request
  -> Connections API in the existing Coolify deployment
  -> AutomationRunner
  -> workspace-scoped ActionRunner
  -> provider executor and encrypted stored credential
  -> provider API
```

The runner is a generic platform module, not a new container, per-client process, or Python script.
After the platform has been deployed, creating or updating an automation through MCP changes stored
automation data; it does not require a Git commit or a Coolify redeploy.

### No arbitrary-code sandbox in the first release

The first release runs declarative automation steps directly in the existing Connections service.
The OLX workflow is orchestration of actions, validation, transformations, and templates; it does
not require arbitrary code execution.

An isolated sandbox is an explicit future escape hatch for a real requirement that the generic step
kinds cannot express, such as custom native dependencies, image/video processing, or genuinely
arbitrary generated code. It must never receive provider credentials. It may receive only a
short-lived, run-scoped capability to call the automation's already declared actions through
Connections.

Do not run agent-generated code inside the Connections/Coolify container. Do not choose or deploy
Daytona, E2B, or Microsandbox until the first real unsupported automation requires one.

## MCP Surface

The automation MCP tools operate only in the workspace resolved from the caller's Connections runtime
token. Clerk authenticates people in the console; the runtime token resolves the MCP caller's current
workspace membership and role. The caller cannot select another workspace in an automation request.

Initial management tools:

```text
list_automations
get_automation
build_automation
edit_automation_draft
test_automation
publish_automation
disable_automation
get_automation_runs
```

Initial execution tools:

```text
list_published_automations
get_automation_input_schema
run_automation
stop_automation_schedule
```

`build_automation` and `edit_automation_draft` accept a complete validated automation definition.
They are deliberately not a collection of browser-style, one-field-at-a-time builder tools.

`test_automation` requires the compose input and explicit confirmation. It creates one real Gmail
draft through the exact bound action and connection, records the run, and bypasses only the schedule;
it never sends email or creates an active future schedule.

`disable_automation` prevents future runs. A future `cancel_automation_run` tool is separate: it
requires a durable background-job implementation before Connections can reliably stop in-flight work.

Managers and admins create, edit, test, publish, disable, and inspect workspace-wide runs. The
existing workspace role and connection rules determine who may execute a published automation; the
first implementation must not introduce a second authorization model.

## UI Surface

### Automation library

The `Automations` sidebar entry is the workspace library, not the builder. It shows:

- name and short client-facing description;
- lifecycle: `Draft`, `Live`, or `Disabled`;
- trigger surfaces: Client form, MCP, and/or API;
- the explicit provider connection labels used by the automation;
- last execution status, total runs, active/draft version, last edit, and owner.

Filters keep lifecycle and execution status separate. For example, `Draft` and `Live` are lifecycle
filters; `Success` and `Failed` are execution filters.

The primary creation entry point is **Create with MCP**. A separate **Request automation** button is
only appropriate if it opens a distinct human-service request flow.

### Client view

The client view is generated from the published version's input and output schemas. It provides a
simple form, file uploads through the existing transit-file service, validation feedback, a run
button, and a result view. It must not show code, raw action payloads, or credentials.

For fields explicitly declared as safe configuration, the form has a **Save configuration** action.
It stores the workspace-scoped defaults encrypted at rest and restores them when the automation is
reopened. Saving never runs an action, creates a schedule, publishes a version, or changes the
automation's structural definition.

The run button describes its real consequence. For example, a button that calls
`olx.create_advert` says **Create OLX listing**, not **Generate listing**.

### Technical view

The technical view is read-only inspection, with a safe configuration panel. It shows:

- Draft and Live version identifiers;
- ordered steps with Input, Logic, Output, allowed action, and connection binding;
- input/output schemas;
- the normalized execution plan or read-only code preview when useful;
- test outcome and linked parent/child logs;
- endpoint information for the live version.

The safe configuration panel contains only values declared by the automation definition, such as a
description template, default currency, listing visibility, or a maximum image count. It cannot
change executable structure, actions, connection bindings, credentials, or permissions.

### Endpoint and logs

The first Gmail-draft slice does not expose a public HTTP endpoint. Its execution surface is the
authenticated client form and `run_automation` MCP tool. A later live automation may expose a
private endpoint:

```text
POST /v1/automations/:slug/run
```

The request and response conform to the live version's schemas. Endpoint authentication is enforced
by Connections, not by the provider's OAuth. The default is private; the precise caller credential
is selected during implementation and must be explicit in the endpoint panel.

Logs remain close to the automation. A parent automation run records its trigger, version, caller,
status, duration, and summaries. Each step has a linked step run, and each provider action remains
visible in the existing action run log with a link back to its parent automation run.

## Version Lifecycle

```text
Draft v4 --test--> Draft v4 --publish--> Live v4
                                      \-> supersedes Live v3
```

- Structural edits always create or update a draft.
- A published version is immutable.
- A live endpoint always executes the currently live version.
- Editing a draft never changes the live endpoint's behaviour.
- Historical runs retain their automation version and step references.
- Disabling prevents new runs while preserving history.

## OLX Listing Automation: Reference Use Case

This is the first end-to-end automation that proves the feature.

### Client input

```text
- product photos
- price
```

### Safe configuration

```text
- description template with allowed variables, such as {{brand}}, {{model}}, and {{condition}}
- OLX labelled connection, for example olx:client-main-account
- declared defaults, such as currency or listing visibility
```

### Steps

```text
1. Validate the uploaded photos and price.
2. Identify product facts from the photos through an available connected action.
3. Research reliable product details through an available connected search action.
4. Resolve the OLX category and fetch its required attributes through OLX actions.
5. Render the configured description template and build the complete advert payload.
6. Call olx.create_advert using the explicit OLX connection label.
7. Return advert ID, URL, status, generated description, and warnings.
```

Reference images found through internet search are for verification or review by default. The listing
uses the client's uploaded photos unless the client has the right to use the sourced images.

The final OLX publish is an existing provider action, not a separate OLX endpoint or credential
flow. Vision and web research are also provider actions; the automation only orchestrates them.

## Security, Data, and Testing

- Automation definitions, versions, safe configuration, and run records are workspace-scoped
  application data in the hosted application database (Insforge for the hosted deployment).
- Provider credentials remain encrypted server-managed data. They never reach the browser, MCP
  client, automation definition, or automation step.
- Every `action` step specifies both an allowed action ID and an explicit connection label. The
  runner cannot silently choose an account.
- The runner reuses existing action policy and workspace authorization rather than duplicating them.
- Automation input and output are schema-validated. Run logs store summaries rather than secrets.
- Tests are draft runs. A test that could mutate an external system requires an explicit safe mode,
  test account, or deliberate real-action confirmation before implementation enables it.
- Files reuse the existing transit-file service and its workspace access and size limits.

## Data Model

The exact database schema follows the existing storage abstractions. The core records are:

```text
automations
- id, workspace_id, slug, name, description, lifecycle
- created_by, created_at, updated_at

automation_versions
- id, automation_id, version, state (draft/live/superseded)
- input_schema, output_schema, safe_configuration_schema
- created_by, created_at, published_at

automation_steps
- id, automation_version_id, order, kind, name
- input_schema, logic_description, output_schema
- allowed_action_id, connection_name, execution_definition

automation_runs
- id, workspace_id, automation_id, automation_version_id
- trigger_source, caller identity, input/output summaries
- status, error details, started_at, completed_at

automation_step_runs
- id, automation_run_id, automation_step_id, order
- input/output summaries, status, error details, started_at, completed_at
```

The Gmail-draft slice stores the fixed three-step definition in an immutable version record and adds
`automation_approval_grants` plus `automation_schedules`. Schedule input (`to`, `subject`, and
`body`) is encrypted with the existing secret codec; run records keep only status, failure summaries,
and the returned Gmail draft ID. `automation_schedules` stores UTC `next_run_at`, original IANA time
zone, recurrence, optional end date, and a recoverable claim timestamp. The scheduler reclaims stale
claims after restart, prevents duplicate occurrences with `(schedule_id, occurrence_at)`, executes a
missed one-off once, and records missed recurring occurrences as skipped instead of bulk replaying
drafts.

## Scheduled Gmail Draft v1

The first implementation is intentionally product-shaped rather than a generic visual builder:

```text
1. Compose email       to, subject, body; sender is a bound Gmail connection label
2. Schedule draft      local date/time, IANA time zone, once or daily/weekly, optional end date
3. Create Gmail draft  gmail.create_email_draft through the existing ActionRunner
```

MCP tools build, edit, dry-run test, explicitly publish, schedule, stop, disable, list, inspect, and
read runs. Publishing records an approval tied to the exact automation version, Gmail action,
connection label, and current workspace action-policy timestamp. Before each due invocation the
worker rechecks that approval, action policy, enabled provider, and exact labelled Gmail connection.
It delegates credential resolution and provider invocation to `ActionRunner`; the scheduler itself
never receives Gmail credentials.

In the Gmail client form, **Publish & schedule** saves the displayed values, publishes the draft,
and creates its first schedule in one explicit confirmation. The separate MCP publish operation
remains publish-only because it does not receive client form input.

## Delivery Sequence

1. Add the storage model, MCP draft creation/read tools, and a read-only library/technical UI.
2. Add the generic in-process `AutomationRunner` and draft test runs for the four step kinds.
3. Add publish, client form, private HTTP execution, and parent/child logs.
4. Build and verify the OLX listing automation using only connected actions.
5. Add operational capabilities such as disabling, duplication, retries, queues, and cancellation as
   the actual workload requires them.
6. Add an isolated code sandbox only for a proven requirement outside the declarative runner.

## Decisions Still Required During Implementation

- The exact private authentication scheme for the HTTP endpoint.
- Whether client-form/API calls that include mutation actions require a server-enforced confirmation
  or a dedicated test/production connection strategy.
- Whether published automations need a per-automation sharing rule beyond the existing workspace and
  connection authorization model.
- Retry, idempotency, and background-job behaviour once workloads exceed request-duration limits.
