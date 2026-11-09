# Open Flow and Connections

Open Flow powers the **Workflows** tab at
<https://connections.fractals-solutions.com/workflows>. The Fractals-dev deployment uses the
operator-owned [Open Flow fork](https://github.com/Ntrakiyski/open-flow).

## Runtime configuration

The Git-backed `connections` application runs the public Connector and the private Open Flow
backend from `docker-compose.yml`. The Open Flow build context pins a compatible commit from the
fork. `connector:3000` and `open-flow:3000` are Compose network addresses. Only the Connector
has a public domain. Open Flow's `/readyz` also checks Connector reachability.

Set these runtime-only variables in Coolify:

| Variable                         | Value                                                    |
| -------------------------------- | -------------------------------------------------------- |
| `OPEN_FLOW_CONNECTOR_TOKEN`      | Fractals-dev Connections runtime key                     |
| `OPEN_FLOW_TOKEN`                | Private Open Flow administrator token                    |
| `OPEN_FLOW_DATA_VOLUME`          | Name of the existing external Docker data volume         |
| `CONNECTIONS_OPEN_FLOW_BACKENDS` | Workspace and user binding with a personal Open Flow key |

Provider credentials stay in Connections. The runtime key retains its original user and workspace;
Connections checks current membership, grants and archive state on every request.

The external Open Flow volume preserves the SQLite database, workflows, and run history. Stop the
standalone Open Flow container before mounting that volume in Compose. To roll back, stop the
Compose Open Flow service before starting the standalone resource. Restore the quiesced backup if
the newer image migrated the database and the prior image cannot read it.

## Workflows tab pilot

The Connections console can embed the Open Flow Workbench so the assigned workspace user signs in
once. Use a backend compatible with `@oomol-lab/open-flow@0.1.0-beta.85`, the Workbench version
pinned in the console. Set up each pilot workspace separately.

1. Register and verify the user in Connections. Create or select their workspace and issue a
   dedicated Connections runtime key from **API Key** in that workspace. Use the stable workspace
   ID from the workspace URL and the stable user ID from the verified `/api/account` response.
2. Run a private Open Flow server with its own persistent volume. Set `OPEN_FLOW_CONNECTOR_ORIGIN`
   and `OPEN_FLOW_CONNECTOR_CONSOLE_ORIGIN` to Connections and `OPEN_FLOW_CONNECTOR_TOKEN` to the
   key from step 1. Use a separate volume and credentials for every workspace.
3. In that Open Flow server, use **Admin settings → Users** to create a regular account. Sign in
   to it during setup and create a personal token in **Agent access**. Put the `ofp_` token in the
   Connections server configuration below. The user only needs their Connections login afterward.
4. Set the server-only environment variable `CONNECTIONS_OPEN_FLOW_BACKENDS` on the Connections
   Node deployment and restart it. Supply one entry per workspace. The `origin` is reachable from
   Connections and has no trailing slash or path. Keep the value in deployment secrets.

   ```json
   [
     {
       "workspaceId": "workspace-id",
       "userId": "connections-user-id",
       "origin": "http://open-flow-workspace-a:3000",
       "token": "ofp_…"
     }
   ]
   ```

5. Open **Workflows** from the workspace sidebar. Create and test a read-only flow, then verify a
   second account cannot list or open it. Repeat with a second workspace and its own provider account.

The gateway verifies the Connections session and live workspace grant on every request and while
relaying workflow notifications. It keeps the Open Flow personal token server-side. Open Flow
continues to use its own workspace Connector key when a scheduled run starts after browser logout.
Connections revokes provider access when the bound user loses their grant. Disable the backend's
scheduled flows when retiring a binding so schedules without provider calls stop as well.

Use a private network with restricted runner egress before granting untrusted users workflow
authoring. HTTP nodes can reach destinations visible to the runner. This pilot serves the editor
and workflow operations. The backend's administrator UI, MCP endpoint, public callback routes and
remote OpenAPI document loading use separate access paths or configuration. Existing flows remain
in their original Open Flow account and volume. Import copies into the pilot account if needed.

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
