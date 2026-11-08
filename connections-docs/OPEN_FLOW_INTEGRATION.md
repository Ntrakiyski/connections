# Open Flow and Connections

The operator-owned [Open Flow fork](https://github.com/Ntrakiyski/open-flow) is deployed at
<https://openflow.159.69.35.245.sslip.io>. It uses the existing
<https://connections.fractals-solutions.com> runtime and its Fractals-dev workspace.

## Runtime configuration

Coolify application `open-flow` builds `apps/server/Dockerfile` from the fork's `main` branch.
Its named data volume persists the SQLite database, workflows and run history. Auto Deploy is enabled.
The image's native Node health check is retained; `/readyz` also verifies gateway reachability.

Set these runtime-only variables in Coolify:

| Variable                             | Value                                               |
| ------------------------------------ | --------------------------------------------------- |
| `OPEN_FLOW_CONNECTOR_ORIGIN`         | `https://connections.fractals-solutions.com`        |
| `OPEN_FLOW_CONNECTOR_CONSOLE_ORIGIN` | `https://connections.fractals-solutions.com`        |
| `OPEN_FLOW_CONNECTOR_TOKEN`          | Dedicated Connections runtime key named `Open Flow` |
| `OPEN_FLOW_TOKEN`                    | Private Open Flow administrator token               |
| `OPEN_FLOW_PUBLIC_ORIGIN`            | `https://openflow.159.69.35.245.sslip.io`           |
| `OPEN_FLOW_SESSION_COOKIE_SECURE`    | `true`                                              |

Open Flow's administrator login uses `OPEN_FLOW_TOKEN` from that application's Coolify environment.
Provider credentials stay in Connections. The runtime key retains its original user and workspace;
Connections checks current membership, grants and archive state on every request.

## Compatibility

Open Flow sends the selected account as `x-oo-connector-app-id`, using an ID returned by `/v1/apps`.
Connections resolves that ID through the current user's accessible accounts in the request's
workspace and provider. An unavailable ID returns `connection_not_found`; conflicting app-ID and
label selectors return `invalid_connection_name`. Existing explicit labels remain supported.

The action endpoint also forwards the standard `Idempotency-Key` header to the existing action
safety policy when the JSON body does not specify an idempotency key.

## Manual verification workflow

The verified [Connections smoke test](https://openflow.159.69.35.245.sslip.io/flows/flow_bdd13e4ac5b141a9b3eb39371ca0be70/design) contains two nodes:

1. **Start** with no inputs.
2. **List my boards**, action `board.list_boards`, explicitly bound to `board:default`.

The workflow reads the Board directory without modifying records or registering a trigger.
It is retained as a Draft for manual tests using **Test Start**. Both a Control API run and a
Workbench run completed successfully; each returned four boards belonging to the original
Fractals-dev workspace. The [redacted verification receipt](verification/open-flow-integration.json)
records the pinned revision, latest run and workspace checks.

Flow ID: `flow_bdd13e4ac5b141a9b3eb39371ca0be70`.

The earlier `Connections Gmail smoke test` is retained separately as a diagnostic Draft
(`flow_fac9df51328543bc8e1b0dd08edf7328`). Its `gmail.get_profile` call reaches Connections
but returns `provider_error` / `Bad Request`. The same request fails when called directly
against Connections, independently of Open Flow. Gmail account availability in the directory
does not prove a provider call works; this remaining provider error has not been resolved.
