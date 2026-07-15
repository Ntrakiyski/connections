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

function renderActionsPage(appData: AppData): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n: createAppI18n("en") },
      createElement(
        MemoryRouter,
        { initialEntries: ["/actions/example.echo"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/actions/:actionId",
            element: createElement(ActionsPage, { data: appData, onRefresh() {} }),
          }),
        ),
      ),
    ),
  );
}
