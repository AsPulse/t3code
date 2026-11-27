// @effect-diagnostics nodeBuiltinImport:off -- Uses the host delimiter for Chromium extension paths.
import { constVoid } from "effect/Function";
import * as NodePath from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

export const extensionPaths = (env: NodeJS.ProcessEnv) =>
  (env.T3CODE_SERVER_BROWSER_EXTENSIONS ?? "").split(NodePath.delimiter).filter(Boolean);

export const isExtensionUrl = (url: string) => url.startsWith("chrome-extension:");

export const loadExtensions = async (context: BrowserContext, paths: readonly string[]) => {
  const session = await context.browser()!.newBrowserCDPSession();
  try {
    for (const path of paths) {
      try {
        await session.send("Extensions.loadUnpacked", { path });
      } catch (cause) {
        throw new Error(`Could not load browser extension at ${path}`, { cause });
      }
    }
  } finally {
    await session.detach().catch(constVoid);
  }
};

interface ExtensionTab {
  readonly extension: boolean;
  readonly page: Page;
}

export const isExtensionTab = (tab: ExtensionTab) =>
  tab.extension || isExtensionUrl(tab.page.url());

export const assertAgentCanAccessTab = (tab: ExtensionTab) => {
  if (isExtensionTab(tab)) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message:
        "Only the user can access this browser extension tab. Open your own tab with preview_open.",
    });
  }
};
