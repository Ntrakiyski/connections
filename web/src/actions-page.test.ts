import type { AppData } from "./model";

import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { ActionsPage } from "./actions-page";
import { createAppI18n } from "./i18n";

const data: AppData = {
  providers: [
    {
      service: "example",
      displayName: "Example",
      categories: [],
      authTypes: ["no_auth"],
      auth: [{ type: "no_auth" }],
      actions: [
        {
          id: "example.echo",
          service: "example",
          name: "Echo",
          description: "Echo input.",
          requiredScopes: [],
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          execution: {
            locallyExecutable: true,
            catalogOnly: false,
            requiredAuthTypes: [],
            noAuthRunnable: true,
            needsCredential: false,
          },
        },
      ],
    },
  ],
  connections: [],
  oauthConfigs: [],
  runtimeTokens: [],
  runs: [],
};

describe("ActionsPage approval policy", () => {
  it("shows the approval control to workspace managers but not members", () => {
    expect(renderActionsPage({ ...data, role: "manager" })).toContain("Require approval");
    expect(renderActionsPage({ ...data, role: "member" })).not.toContain("Require approval");
  });
});

describe("ActionsPage provider defaults", () => {
  it("renders actions from connected providers only on a new page load", () => {
    const connectedData: AppData = {
      ...data,
      providers: [
        provider("gmail", "Gmail", "Gmail search"),
        provider("slack", "Slack", "Slack post"),
        provider("notion", "Notion", "Notion query"),
      ],
      connections: [
        { service: "gmail", authType: "oauth2", configured: true, metadata: {} },
        { service: "slack", authType: "oauth2", configured: true, metadata: {} },
      ],
    };

    const markup = renderActionsPage(connectedData, "/actions");

    expect(markup).toContain("Gmail search");
    expect(markup).toContain("Slack post");
    expect(markup).not.toContain("Notion query");
    expect(markup).toContain("2 providers selected");
  });
});

function provider(service: string, displayName: string, actionName: string): AppData["providers"][number] {
  return {
    ...data.providers[0],
    service,
    displayName,
    actions: [
      {
        ...data.providers[0].actions[0],
        id: `${service}.action`,
        service,
        name: actionName,
      },
    ],
  };
}

function renderActionsPage(appData: AppData, initialPath = "/actions/example.echo"): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n: createAppI18n("en") },
      createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/actions/:actionId?",
            element: createElement(ActionsPage, { data: appData, onRefresh() {} }),
          }),
        ),
      ),
    ),
  );
}
