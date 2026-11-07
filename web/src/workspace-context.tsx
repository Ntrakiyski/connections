import type { RequestOptions } from "./api";
import type { WorkspaceScope } from "./workspace-scope";
import type { ComponentProps, ReactNode } from "react";

import { createContext, useContext } from "react";
import { Link, NavLink } from "react-router";
import { workspaceHref } from "./workspace-scope";

export const WorkspaceContext = createContext<WorkspaceScope | null>(null);
export function useWorkspaceScope(): WorkspaceScope | null {
  return useContext(WorkspaceContext);
}
export function useWorkspaceRequests(): RequestOptions {
  return useWorkspaceScope()?.requests ?? {};
}

/** Preserve workspace intent on every internal navigation, including filter URLs. */
export function WorkspaceLink(props: ComponentProps<typeof Link>): ReactNode {
  const scope = useWorkspaceScope();
  const to = scope && typeof props.to === "string" ? workspaceHref(props.to, scope.intent) : props.to;
  return <Link {...props} to={to} />;
}
export function WorkspaceNavLink(props: ComponentProps<typeof NavLink>): ReactNode {
  const scope = useWorkspaceScope();
  const to = scope && typeof props.to === "string" ? workspaceHref(props.to, scope.intent) : props.to;
  return <NavLink {...props} to={to} />;
}
