# Frontend reference

## Contents

- Composition and routes
- State and request flow
- Loading and error states
- OAuth completion
- Responsive and large-catalog behavior
- Tests and known hazards

## Composition and routes

`web/src/main.tsx` mounts providers in this order: Clerk, i18n, BrowserRouter, `App`.

`web/src/ui.tsx` owns the global shell and these routes:

| Route                               | Owner                |
| ----------------------------------- | -------------------- |
| `/overview`                         | `overview-page.tsx`  |
| `/providers`, `/providers/:service` | `providers-page.tsx` |
| `/actions`, `/actions/:actionId`    | `actions-page.tsx`   |
| `/runs`                             | `runs-page.tsx`      |
| `/access`                           | `access-page.tsx`    |
| `/resources`                        | `resources-page.tsx` |

Unknown browser routes redirect to overview. Do not add custom workspace, membership, Organization settings, or profile pages. Use Clerk's `OrganizationSwitcher`, Organization modal, and `openUserProfile()` surface.

Reuse `web/src/components/ui/*`, `shared-ui.tsx`, CSS variables in `style.css`, Lucide icons, i18n keys, and current dependencies.

## State and request flow

`App` in `web/src/ui.tsx` owns:

- the last authoritative `AppData` snapshot;
- global `loading` and `error`;
- whether the first runtime check completed;
- a refresh counter used after mutations and OAuth completion.

`loadRuntimeData` gets `/api/auth/session`, then loads providers, connections, OAuth configs, runtime tokens, and the first runs page concurrently. Pages own only transient view state. After an authoritative mutation, call `onRefresh()` rather than synthesizing a server record.

`RunsPage` intentionally owns paginated/filter state and uses request ids to ignore stale async responses. It is keyed by workspace in `ui.tsx`; preserve that remount boundary.

Theme and language use their existing localStorage owners in `theme.ts` and `i18n.ts`.

### Workspace-token rule

Get a Clerk bearer for the selected tab Organization with:

```ts
getToken({ organizationId: orgId, skipCache: true });
```

Pass it through every `apiGet`/`apiPost`/`apiPut`/`apiPatch`/`apiDelete` request. Never add a workspace id supplied by the browser.

## Loading and error states

Keep these distinct:

| State                      | UI                                                               |
| -------------------------- | ---------------------------------------------------------------- |
| Signed out                 | Clerk `SignIn`                                                   |
| Signed in, no Organization | Organization selection/creation                                  |
| First runtime check        | Full-screen loader; do not render stale shell data               |
| Same-workspace refresh     | Keep last-good content; show header loader                       |
| Loaded                     | Show profile button in the same right-side header slot           |
| Failed refresh             | Keep last-good content, global `InlineError`, unavailable status |

The header loader and profile button are mutually exclusive. Adding a third flex child makes the right-side control jump through the center.

Use `web/src/api.ts` as the JSON/error boundary. It extracts `/api`, `/v1`, and simple message shapes. Surface server messages through existing `FormStatus` or `InlineError`; do not silently swallow failures.

For switchable requests, use effect cleanup, `AbortController`, or request ids. Reuse `runs-page-stale.test.ts` as the race-condition pattern. Optimistic controls must roll back on failure; see `action-approval-control.tsx`.

## OAuth completion

The provider page opens the authorization URL in a centered `noopener,noreferrer` popup. The server callback page broadcasts:

```text
channel: oomol-connect-oauth
payload: { type: "oauth.completed", service }
```

`App` subscribes and refreshes. Provider UI also polls once per second for at most 30 seconds as a fallback. Keep the server callback and browser channel constants synchronized. Stop polling when the connection appears, the component unmounts, a reconnect starts, or the provider changes.

Never return client secrets or raw credentials to the browser. OAuth config summaries expose only safe metadata; runtime token plaintext is shown once at creation.

## Responsive and large-catalog behavior

Preserve layout containment: `min-width: 0`, `minmax(0, 1fr)`, and the existing overflow owners prevent wide action/provider content from breaking the shell.

- Desktop actions use fixed-viewport list/detail scrolling.
- At `<=960px`, the sidebar becomes a sticky horizontal top region and nested scrolling returns to document flow.
- At `<=640px`, controls and split layouts become one column and tables scroll horizontally.
- Provider cards use one column by default, two from `760px`, and three from `1180px`.
- Overview changes also need checks around `1120px`.

Providers render 48 at a time with IntersectionObserver/content visibility. Actions render 120 at a time. Preserve these limits unless profiling proves a better owner.

Actions initially filter to connected provider services. The selection is session-local and reset on clear/remount; do not persist it unless product behavior changes.

## Tests and known hazards

Use:

- `model.test.ts` for pure filtering/formatting logic;
- page tests with `renderToStaticMarkup` + `MemoryRouter` for routes/roles/markup;
- `providers-page-hooks.test.ts` for effect/timer cleanup;
- `runs-page-stale.test.ts` for async races;
- `ui.test.ts` for Organization token and OAuth channel contracts.

Current hazards to check whenever touching adjacent code:

1. The initial snapshot uses an explicit Organization bearer, but some page mutations and filtered run requests still omit it and fall back to the shared Clerk session cookie. Do not extend that inconsistency.
2. Changing `orgId` does not currently clear old `AppData` before the new workspace load finishes. Prevent previous-workspace labels or connections from remaining visible during a switch.
3. CSS is not covered by the current unit suite. Manually inspect loading/loaded/error states at desktop and responsive breakpoints when browser tooling is available.
