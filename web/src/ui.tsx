import type { AppLang } from "./i18n";
import type {
  AppData,
  ConnectionRecord,
  OAuthConfig,
  ProviderDefinition,
  RunLogPage,
  RuntimeTokenSummary,
  WorkspaceRole,
} from "./model";
import type { ThemeMode } from "./theme";
import type { ReactNode } from "react";

import { OrganizationSwitcher, SignIn, SignOutButton, useAuth } from "@clerk/clerk-react";
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
  Sun,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { AccessPage } from "./access-page";
import { ActionsPage } from "./actions-page";
import { apiGet } from "./api";
import oomolConnectLogoUrl from "./assets/oomol-connect-logo.png";
import { persistLang, supportedLangs } from "./i18n";
import { emptyData } from "./model";
import { OverviewPage } from "./overview-page";
import { ProvidersPage } from "./providers-page";
import { ResourcesPage } from "./resources-page";
import { RunsPage } from "./runs-page";
import { InlineError, StatusDot } from "./shared-ui";
import { useThemeMode } from "./theme";
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
];

const oauthCompletionChannelName = "oomol-connect-oauth";
const oauthCompletedType = "oauth.completed";

const themeOptions = [
  { value: "auto", labelKey: "shell.themeMode.auto", icon: Monitor },
  { value: "light", labelKey: "shell.themeMode.light", icon: Sun },
  { value: "dark", labelKey: "shell.themeMode.dark", icon: Moon },
] as const;

export interface AuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
  workspaceId?: string;
  workspaceName?: string;
  role?: AppData["role"];
  userId?: string;
  sessionClaims?: Record<string, unknown>;
}

export interface OAuthCompletionMessage {
  type: typeof oauthCompletedType;
  service: string;
}

export function subscribeToOAuthCompletions(onComplete: (message: OAuthCompletionMessage) => void): () => void {
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (isOAuthCompletionMessage(event.data)) {
      onComplete(event.data);
    }
  };

  if (typeof BroadcastChannel === "undefined") {
    return () => {};
  }

  const channel = new BroadcastChannel(oauthCompletionChannelName);
  channel.addEventListener("message", handleMessage);
  return () => channel.close();
}

function isOAuthCompletionMessage(value: unknown): value is OAuthCompletionMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as { type?: unknown; service?: unknown };
  return message.type === oauthCompletedType && typeof message.service === "string";
}

export interface RuntimeLoadResult {
  authSession: AuthSession;
  data: AppData;
}

export interface OrganizationTokenGetter {
  (options: { organizationId: string; skipCache: boolean }): Promise<string | null>;
}

/**
 * Gets a Clerk session token for the organization selected in this browser tab.
 *
 * Clerk sessions can have different active organizations in separate tabs, so the
 * browser-to-API bearer token must carry this explicit workspace context.
 */
export async function getOrganizationToken(
  getToken: OrganizationTokenGetter,
  organizationId: string,
): Promise<string | null> {
  return await getToken({ organizationId, skipCache: true });
}

export async function loadRuntimeData(clerkToken: string | null): Promise<RuntimeLoadResult> {
  const bearerToken = clerkToken ?? undefined;
  const rawSession = await apiGet<Partial<AuthSession>>("/api/auth/session", { bearerToken });
  const authSession: AuthSession = {
    adminAuthConfigured: rawSession.adminAuthConfigured ?? true,
    authenticated: rawSession.authenticated ?? true,
    workspaceId: rawSession.workspaceId,
    workspaceName: rawSession.workspaceName ?? sessionClaim(rawSession.sessionClaims, "org_name"),
    role: rawSession.role,
    userId: rawSession.userId,
    sessionClaims: rawSession.sessionClaims,
  };
  if (!authSession.authenticated) {
    return { authSession, data: emptyData };
  }

  const [providers, connections, oauthConfigs, runtimeTokens, runPage] = await Promise.all([
    apiGet<ProviderDefinition[]>("/api/providers", { bearerToken }),
    apiGet<ConnectionRecord[]>("/api/connections", { bearerToken }),
    apiGet<OAuthConfig[]>("/api/oauth/configs", { bearerToken }),
    apiGet<RuntimeTokenSummary[]>("/api/runtime-tokens", { bearerToken }),
    apiGet<RunLogPage>("/api/runs", { bearerToken }),
  ]);

  return {
    authSession,
    data: {
      providers,
      connections,
      oauthConfigs,
      runtimeTokens,
      runs: runPage.items,
      runsNextCursor: runPage.nextCursor,
      workspaceId: authSession.workspaceId,
      workspaceName: authSession.workspaceName ?? "Workspace",
      role: authSession.role ?? "member",
      userId: authSession.userId,
    },
  };
}

export function App(): ReactNode {
  const t = useTranslate();
  const { theme, setTheme } = useThemeMode();
  const { isSignedIn, getToken, orgId, signOut } = useAuth();
  const [data, setData] = useState<AppData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(
    () =>
      subscribeToOAuthCompletions(() => {
        setRefreshToken((value) => value + 1);
      }),
    [],
  );

  useEffect(() => {
    if (!isSignedIn || !orgId) {
      setData(emptyData);
      setError(null);
      setLoading(false);
      setRuntimeChecked(true);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getOrganizationToken(getToken, orgId)
      .then((clerkToken) => loadRuntimeData(clerkToken))
      .then(({ data: nextData }) => {
        if (!cancelled) {
          setData(nextData);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : t("shell.loadRuntimeFailed"));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRuntimeChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshToken, isSignedIn, orgId, getToken, t]);

  function refresh(): void {
    setRefreshToken((value) => value + 1);
  }

  function logout(): void {
    void signOut().then(() => refresh());
  }

  if (!isSignedIn) {
    return (
      <main className="unlock-screen">
        <SignIn forceRedirectUrl="/" signUpForceRedirectUrl="/" />
      </main>
    );
  }

  if (!orgId) {
    return <OrganizationRequiredView />;
  }

  if (!runtimeChecked) {
    return <InitialLoadingView />;
  }

  return (
    <AppShell
      data={data}
      loading={loading}
      error={error}
      theme={theme}
      onRefresh={refresh}
      onThemeChange={setTheme}
      onLogout={logout}
    />
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

function OrganizationRequiredView(): ReactNode {
  return (
    <main className="unlock-screen">
      <div className="unlock-panel">
        <h1>Choose a workspace</h1>
        <p>Select an existing organization or create one to continue.</p>
        <OrganizationSwitcher hidePersonal defaultOpen afterCreateOrganizationUrl="/" afterSelectOrganizationUrl="/" />
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
}): ReactNode {
  const t = useTranslate();
  const location = useLocation();
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
            <div className="brand-name">OOMOL Connect</div>
            <div className="brand-subtitle">{t("brand.subtitle")}</div>
          </div>
        </div>

        <div className="clerk-organization-switcher">
          <OrganizationSwitcher hidePersonal afterCreateOrganizationUrl="/" afterSelectOrganizationUrl="/" />
        </div>

        <nav className="sidebar-nav" aria-label={t("shell.primaryNav")}>
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
                to={item.path}
              >
                <Icon size={16} />
                <span>{t(item.labelKey)}</span>
              </NavLink>
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
            <SignOutButton>
              <Button variant="outline" size="sm">
                {t("shell.logout")}
              </Button>
            </SignOutButton>
          </div>
        </div>
      </aside>

      <div className={isBrowserPage ? "main-region main-region-browser" : "main-region"}>
        <header className="shell-header">
          <div className="shell-header-title">
            <CurrentNavIcon size={16} />
            <h1>{t(`shell.headings.${heading}.title`)}</h1>
          </div>
          {props.data.workspaceName ? <span className="shell-workspace-name">{props.data.workspaceName}</span> : null}
          {props.loading ? (
            <div className="loading-panel page-loading">
              <Loader2 className="spin" size={16} />
              {t("common.loadingRuntimeData")}
            </div>
          ) : null}
        </header>

        <main className={mainClassName}>
          {props.error ? <InlineError message={props.error} /> : null}

          <Routes>
            <Route index element={<Navigate to="/overview" replace />} />
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
              element={<AccessPage tokens={props.data.runtimeTokens} onRefresh={props.onRefresh} />}
            />
            <Route path="/resources" element={<ResourcesPage workspaceName={props.data.workspaceName} />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
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

function sessionClaim(claims: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = claims?.[name];
  return typeof value === "string" && value ? value : undefined;
}
