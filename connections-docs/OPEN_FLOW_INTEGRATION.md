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

`Connections Gmail smoke test` contains two nodes:

1. **Start** with no inputs.
2. **Read Gmail account profile**, action `gmail.get_profile`, explicitly bound to `gmail:default`.

The workflow reads profile metadata and mailbox totals. It does not send mail, modify settings,
or register a trigger. It is retained as a Draft for manual tests.

Flow ID: `flow_fac9df51328543bc8e1b0dd08edf7328`.
