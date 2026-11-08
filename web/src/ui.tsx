import type { AccountDirectory } from "./account-model";
import type { AppLang } from "./i18n";
import type {
  AppData,
  ConnectionRecord,
  OAuthConfig,
  ProviderDefinition,
  ResolvedProviderSafetyConfig,
  RunLogPage,
  RuntimeTokenSummary,
  WorkspaceRole,
} from "./model";
import type { ThemeMode } from "./theme";
import type { WorkspaceScope } from "./workspace-scope";
import type { ReactNode } from "react";

import { useI18n, useLang, useTranslate } from "@embra/i18n/react";
import {
  Activity,
  BookOpen,
  Cable,
  Home,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  Settings,
  Sun,
  TerminalSquare,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { AccessPage } from "./access-page";
import { loadAccountDirectory } from "./account-model";
import { AccountPage } from "./account-page";
import { ActionsPage } from "./actions-page";
import { ApiError, apiGet, apiPost } from "./api";
import oomolConnectLogoUrl from "./assets/oomol-connect-logo.png";
import { authClient } from "./auth-client";
import { AuthPage } from "./auth-page";
import { persistLang, supportedLangs } from "./i18n";
import { MeetingsConsentPage } from "./meetings-consent-page";
import { emptyData } from "./model";
import { OverviewPage } from "./overview-page";
import { ProvidersPage } from "./providers-page";
import { ResourcesPage } from "./resources-page";
import { RunsPage } from "./runs-page";
import { InlineError, StatusDot } from "./shared-ui";
import { useThemeMode } from "./theme";
import { WorkspaceContext, WorkspaceNavLink } from "./workspace-context";
import { WorkspacePage } from "./workspace-page";
import { createWorkspaceScope, workspaceHref } from "./workspace-scope";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface NavItem {
  path: string;
  labelKey: string;
  icon: typeof Home;
  roles?: readonly WorkspaceRole[];
}

const navItems: readonly NavItem[] = [
  { path: "/overview", labelKey: "nav.overview", icon: Home },
  { path: "/providers", labelKey: "nav.providers", icon: Cable },
  { path: "/actions", labelKey: "nav.actions", icon: TerminalSquare },
  { path: "/runs", labelKey: "nav.runs", icon: Activity },
  { path: "/access", labelKey: "nav.access", icon: KeyRound },
  { path: "/resources", labelKey: "nav.docs", icon: BookOpen },
  { path: "/workspace", labelKey: "nav.settings", icon: Settings, roles: ["admin"] },
];

const oauthCompletionChannelName = "oomol-connect-oauth";

const themeOptions = [
  { value: "auto", labelKey: "shell.themeMode.auto", icon: Monitor },
  { value: "light", labelKey: "shell.themeMode.light", icon: Sun },
  { value: "dark", labelKey: "shell.themeMode.dark", icon: Moon },
] as const;

export interface AuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
  workspaceId: string;
  workspaceName: string;
  role: AppData["role"];
  userId: string;
}

export function subscribeToOAuthCompletions(scope: WorkspaceScope, onComplete: () => void): () => void {
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (scope.consumeCompletion(event.data)) onComplete();
  };
  const handleWindowMessage = (event: MessageEvent<unknown>): void => {
    if (event.origin === window.location.origin) handleMessage(event);
  };
  const channel =
    typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(oauthCompletionChannelName);
  channel?.addEventListener("message", handleMessage);
  if (typeof window !== "undefined") window.addEventListener("message", handleWindowMessage);
  return () => {
    channel?.close();
    if (typeof window !== "undefined") window.removeEventListener("message", handleWindowMessage);
  };
}

export interface RuntimeLoadResult {
  authSession: AuthSession;
  data: AppData;
}

export async function loadRuntimeData(scope: WorkspaceScope): Promise<RuntimeLoadResult> {
  const requests = scope.requests;
  const rawSession = await apiGet<AuthSession>("/api/auth/session", requests);
  if (
    !rawSession.authenticated ||
    rawSession.workspaceId !== scope.intent.workspaceId ||
    rawSession.userId !== scope.intent.userId ||
    !rawSession.role
  )
    throw new ApiError(403, "The requested workspace is no longer available.");
  const authSession = rawSession;

  const [providers, connections, oauthConfigs, runtimeTokens, runPage, workspaceSafetyConfig, enabledProviders] =
    await Promise.all([
      apiGet<ProviderDefinition[]>("/api/providers", requests),
      apiGet<ConnectionRecord[]>("/api/connections", requests),
      apiGet<OAuthConfig[]>("/api/oauth/configs", requests),
      apiGet<RuntimeTokenSummary[]>("/api/runtime-tokens", requests),
      apiGet<RunLogPage>("/api/runs", requests),
      apiGet<ResolvedProviderSafetyConfig>("/api/workspace/safety-config", requests),
      apiGet<ProviderDefinition[]>("/api/workspace/providers", requests),
    ]);

  return {
    authSession,
    data: {
      providers,
      enabledServices: enabledProviders.map((provider) => provider.service),
      connections,
      oauthConfigs,
      runtimeTokens,
      runs: runPage.items,
      runsNextCursor: runPage.nextCursor,
      workspaceSafetyConfig,
      workspaceId: authSession.workspaceId,
      workspaceName: authSession.workspaceName ?? "Workspace",
      role: authSession.role ?? "member",
      userId: authSession.userId,
    },
  };
}

export function App(): ReactNode {
  const session = authClient.useSession();
  const [identityChecked, setIdentityChecked] = useState(false);
  useEffect(() => {
    if (!session.isPending) setIdentityChecked(true);
  }, [session.isPending]);
  const location = useLocation();
  const [directory, setDirectory] = useState<AccountDirectory | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const userId = session.data?.user.id;
  function refreshDirectory(): void {
    setRevision((value) => value + 1);
  }
  useEffect(() => {
    setDirectory((current) => (current?.account.user.id === userId ? current : null));
    setError(null);
    if (!userId) return;
    const controller = new AbortController();
    void loadAccountDirectory(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setDirectory(next);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(caught instanceof Error ? caught.message : "Account data could not be loaded.");
      });
    return () => controller.abort();
  }, [userId, revision]);
  useEffect(() => {
    const refresh = (): void => {
      void session.refetch();
      refreshDirectory();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("connections-session-invalidated", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("connections-session-invalidated", refresh);
    };
  }, [session.refetch]);
  function logout(): void {
    void authClient.signOut().then((result) => {
      if (result.error) {
        setError(result.error.message ?? "Sign out failed.");
        return;
      }
      setDirectory(null);
      void session.refetch();
    });
  }
  if (session.isPending && !identityChecked) return <InitialLoadingView />;
  if (!session.data?.user.emailVerified) return <AuthPage onSignedIn={() => void session.refetch()} />;
  if (error)
    return (
      <main className="unlock-screen">
        <div className="unlock-panel">
          <h1>Account unavailable</h1>
          <p role="alert">{error}</p>
          <Button onClick={refreshDirectory}>Try again</Button>
          <Button variant="outline" onClick={logout}>
            Sign out
          </Button>
        </div>
      </main>
    );
  if (!directory || directory.account.user.id !== session.data.user.id) return <InitialLoadingView />;
  if (location.pathname === "/desktop/connect")
    return <MeetingsConsentPage key={`${userId}:${location.search}`} directory={directory} onLogout={logout} />;
  const query = new URLSearchParams(location.search);
  const workspaceId = query.get("workspaceId");
  const companyId = query.get("companyId");
  const accountPage =
    location.pathname.startsWith("/account") ||
    location.pathname.startsWith("/companies") ||
    location.pathname.startsWith("/invitations");
  if (accountPage || (!workspaceId && !companyId))
    return <AccountPage directory={directory} onRefresh={refreshDirectory} onLogout={logout} />;
  const selected = directory.account.workspaces.find(
    (workspace) => workspace.workspaceId === workspaceId && workspace.organizationId === companyId,
  );
  if (!selected)
    return (
      <main className="unlock-screen">
        <div className="unlock-panel">
          <h1>Workspace access unavailable</h1>
          <p>Your current company membership and workspace grant do not allow this workspace.</p>
          <Button asChild>
            <Link to="/">Choose another workspace</Link>
          </Button>
        </div>
      </main>
    );
  const intent = {
    userId: directory.account.user.id,
    organizationId: selected.organizationId,
    workspaceId: selected.workspaceId,
  };
  if (selected.archived)
    return (
      <ArchivedWorkspace
        key={`${userId}:${workspaceId}`}
        selected={selected}
        intent={intent}
        onRefresh={refreshDirectory}
      />
    );
  return (
    <RuntimeWorkspace
      key={`${userId}:${companyId}:${workspaceId}:${selected.role}`}
      intent={intent}
      directory={directory}
      onLogout={logout}
      onDirectoryRefresh={refreshDirectory}
    />
  );
}

function ArchivedWorkspace(props: {
  selected: AccountDirectory["account"]["workspaces"][number];
  intent: WorkspaceScope["intent"];
  onRefresh(): void;
}): ReactNode {
  const [status, setStatus] = useState("");
  async function restore(): Promise<void> {
    try {
      await apiPost("/api/workspace/restore", {}, { workspaceId: props.intent.workspaceId });
      props.onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Restore failed.");
    }
  }
  return (
    <main className="unlock-screen">
      <div className="unlock-panel">
        <h1>{props.selected.workspaceName} is archived</h1>
        <p>
          Its resources are unavailable. An admin can restore it during the retention window. Revoked keys remain
          revoked.
        </p>
        {props.selected.role === "admin" ? <Button onClick={() => void restore()}>Restore workspace</Button> : null}
        <Button variant="outline" asChild>
          <Link to="/">Choose another workspace</Link>
        </Button>
        <p role="status">{status}</p>
      </div>
    </main>
  );
}

function RuntimeWorkspace(props: {
  intent: WorkspaceScope["intent"];
  directory: AccountDirectory;
  onLogout(): void;
  onDirectoryRefresh(): void;
}): ReactNode {
  const { theme, setTheme } = useThemeMode();
  const [scope] = useState(() => createWorkspaceScope(props.intent));
  const [data, setData] = useState<AppData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  function refresh(): void {
    setRevision((value) => value + 1);
  }
  useEffect(() => () => scope.close(), [scope]);
  useEffect(() => subscribeToOAuthCompletions(scope, refresh), [scope]);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void loadRuntimeData(scope)
      .then((result) => {
        if (!disposed) setData(result.data);
      })
      .catch((caught: unknown) => {
        if (!disposed) {
          setData(emptyData);
          setError(caught instanceof Error ? caught.message : "Workspace unavailable.");
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [scope, revision]);
  if (error)
    return (
      <main className="unlock-screen">
        <div className="unlock-panel">
          <h1>Workspace unavailable</h1>
          <p role="alert">{error}</p>
          <Button onClick={refresh}>Try again</Button>
          <Button variant="outline" asChild>
            <Link to="/">Choose another workspace</Link>
          </Button>
        </div>
      </main>
    );
  if (!data.workspaceId) return <InitialLoadingView />;
  return (
    <WorkspaceContext.Provider value={scope}>
      <AppShell
        data={data}
        loading={loading}
        error={null}
        theme={theme}
        onRefresh={refresh}
        onThemeChange={setTheme}
        onLogout={props.onLogout}
        directory={props.directory}
        onDirectoryRefresh={props.onDirectoryRefresh}
      />
    </WorkspaceContext.Provider>
  );
}

function InitialLoadingView(): ReactNode {
  const t = useTranslate();

  return (
    <main className="unlock-screen">
      <div className="loading-panel">
        <Loader2 className="spin" size={16} />
        {t("common.loadingRuntimeData")}
      </div>
    </main>
  );
}

function AppShell(props: {
  data: AppData;
  loading: boolean;
  error: string | null;
  theme: ThemeMode;
  onRefresh(): void;
  onThemeChange(theme: ThemeMode): void;
  onLogout(): void;
  directory: AccountDirectory;
  onDirectoryRefresh(): void;
}): ReactNode {
  const t = useTranslate();
  const location = useLocation();
  const navigate = useNavigate();
  const heading = headingForPath(location.pathname);
  const section = location.pathname.split("/").filter(Boolean)[0];
  const isOverviewPage = heading === "overview";
  const isBrowserPage = section === "actions";
  const mainClassName = [isBrowserPage ? "main main-browser" : "main", isOverviewPage ? "overview-main" : ""]
    .filter(Boolean)
    .join(" ");
  const visibleNavItems = navItems.filter(
    (item) => item.roles === undefined || item.roles.includes(props.data.role ?? "member"),
  );
  const currentNavItem =
    visibleNavItems.find((item) => item.path.slice(1) === heading) ?? visibleNavItems[0] ?? navItems[0];
  const CurrentNavIcon = currentNavItem.icon;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={oomolConnectLogoUrl} alt="" />
          <div>
            <div className="brand-name">Connections</div>
            <div className="brand-subtitle">{t("brand.subtitle")}</div>
          </div>
        </div>

        <label className="workspace-switcher">
          Workspace
          <select
            aria-label="Workspace"
            value={props.data.workspaceId}
            onChange={(event) => {
              const selected = props.directory.account.workspaces.find(
                (workspace) => workspace.workspaceId === event.target.value,
              );
              if (selected) navigate(workspaceHref("/overview", selected));
            }}
          >
            {props.directory.account.workspaces.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.organizationName} / {workspace.workspaceName}
                {workspace.archived ? " (Archived)" : ""}
              </option>
            ))}
          </select>
          <Link to="/">Manage companies</Link>
        </label>

        <nav className="sidebar-nav" aria-label={t("shell.primaryNav")}>
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <WorkspaceNavLink
                key={item.path}
                className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
                to={item.path}
              >
                <Icon size={16} />
                <span>{t(item.labelKey)}</span>
              </WorkspaceNavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <LanguageSelect />
          <ThemeControl theme={props.theme} onThemeChange={props.onThemeChange} />
          <div className="runtime-status">
            <StatusDot ok={!props.error} />
            <span>{props.error ? t("common.apiUnavailable") : t("common.runtimeReady")}</span>
          </div>
          <div className="button-row tight">
            <Button variant="outline" size="icon-sm" onClick={props.onRefresh} aria-label={t("shell.refreshData")}>
              {props.loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            </Button>
            <Button variant="outline" size="sm" onClick={props.onLogout}>
              {t("shell.logout")}
            </Button>
          </div>
        </div>
      </aside>

      <div className={isBrowserPage ? "main-region main-region-browser" : "main-region"}>
        <header className="shell-header">
          <div className="shell-header-title">
            <CurrentNavIcon size={16} />
            <h1>{t(`shell.headings.${heading}.title`)}</h1>
          </div>
          {props.loading ? (
            <div className="loading-panel page-loading">
              <Loader2 className="spin" size={16} />
              {t("common.loadingRuntimeData")}
            </div>
          ) : (
            <Button variant="ghost" size="icon-sm" asChild aria-label={t("shell.openProfile")}>
              <Link to="/account/security">
                <UserRound size={17} />
              </Link>
            </Button>
          )}
        </header>

        <main className={mainClassName}>
          {props.error ? <InlineError message={props.error} /> : null}

          <Routes>
            <Route
              index
              element={
                <Navigate
                  to={workspaceHref("/overview", {
                    organizationId: new URLSearchParams(location.search).get("companyId") ?? "",
                    workspaceId: props.data.workspaceId ?? "",
                  })}
                  replace
                />
              }
            />
            <Route path="/overview" element={<OverviewPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/providers" element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route
              path="/providers/:service"
              element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />}
            />
            <Route path="/actions" element={<ActionsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/actions/:actionId" element={<ActionsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route
              path="/runs"
              element={
                <RunsPage
                  key={props.data.workspaceId}
                  initialRuns={props.data.runs}
                  nextCursor={props.data.runsNextCursor}
                />
              }
            />
            <Route
              path="/access"
              element={
                <AccessPage
                  tokens={props.data.runtimeTokens}
                  safetyConfig={props.data.workspaceSafetyConfig}
                  canManage={props.data.role !== "member"}
                  onRefresh={props.onRefresh}
                />
              }
            />
            <Route path="/resources" element={<ResourcesPage workspaceName={props.data.workspaceName} />} />
            <Route
              path="/workspace"
              element={<WorkspacePage data={props.data} onDirectoryRefresh={props.onDirectoryRefresh} />}
            />
            <Route
              path="*"
              element={
                <Navigate
                  to={workspaceHref("/overview", {
                    organizationId: new URLSearchParams(location.search).get("companyId") ?? "",
                    workspaceId: props.data.workspaceId ?? "",
                  })}
                  replace
                />
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function ThemeControl(props: { theme: ThemeMode; onThemeChange(theme: ThemeMode): void }): ReactNode {
  const t = useTranslate();

  return (
    <div className="theme-control" aria-label={t("shell.theme")}>
      <span>{t("shell.theme")}</span>
      <div className="theme-segmented-control" role="radiogroup" aria-label={t("shell.theme")}>
        {themeOptions.map((item) => {
          const Icon = item.icon;
          const selected = props.theme === item.value;
          return (
            <button
              key={item.value}
              type="button"
              className={selected ? "theme-segment active" : "theme-segment"}
              role="radio"
              aria-checked={selected}
              aria-label={t(item.labelKey)}
              title={t(item.labelKey)}
              onClick={() => props.onThemeChange(item.value)}
            >
              <Icon size={14} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LanguageSelect(): ReactNode {
  const t = useTranslate();
  const i18n = useI18n();
  const lang = useLang() as AppLang;

  function switchLang(nextLang: AppLang): void {
    persistLang(nextLang);
    void i18n.switchLang(nextLang);
  }

  return (
    <div className="language-select">
      <span className="language-select-label">{t("language.label")}</span>
      <Select value={lang} onValueChange={(value) => switchLang(value as AppLang)}>
        <SelectTrigger className="language-select-trigger" size="sm" aria-label={t("language.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="language-select-content" position="popper" align="start">
          {supportedLangs.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`language.${item}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function headingForPath(pathname: string): string {
  const section = pathname.split("/").filter(Boolean)[0];
  if (section === "providers") return "providers";
  if (section === "actions") return "actions";
  if (section === "runs") return "runs";
  if (section === "access") return "access";
  if (section === "resources") return "resources";
  if (section === "workspace") return pathname.endsWith("members") ? "members" : "settings";
  return "overview";
}
