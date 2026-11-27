// @effect-diagnostics nodeBuiltinImport:off -- Reads manifests from the same host paths passed to Chromium.
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { BrowserContext, Page } from "playwright-core";

import { asRecord } from "./ServerBrowserInput.ts";
import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

export const extensionPaths = (env: NodeJS.ProcessEnv) =>
  (env.T3CODE_SERVER_BROWSER_EXTENSIONS ?? "").split(NodePath.delimiter).filter(Boolean);

export const isExtensionUrl = (url: string) => url.startsWith("chrome-extension:");

export interface ServerBrowserExtension {
  readonly id: string;
  readonly name: string;
}

const extensionsByContext = new WeakMap<BrowserContext, readonly ServerBrowserExtension[]>();

export const contextExtensions = (context: BrowserContext): readonly ServerBrowserExtension[] =>
  extensionsByContext.get(context) ?? [];

export const loadExtensions = async (context: BrowserContext, paths: readonly string[]) => {
  const session = await context.browser()!.newBrowserCDPSession();
  try {
    const actions = new Map<string, string | undefined>();
    for (const path of paths) {
      try {
        const { id } = await session.send("Extensions.loadUnpacked", { path });
        const manifest = asRecord(
          JSON.parse(await NodeFSP.readFile(NodePath.join(path, "manifest.json"), "utf8")),
        );
        const action = asRecord(manifest?.action);
        if (!action) continue;
        const title = action.default_title;
        actions.set(
          id,
          typeof title === "string" && !title.startsWith("__MSG_") ? title : undefined,
        );
      } catch (cause) {
        throw new Error(`Could not load browser extension at ${path}`, { cause });
      }
    }
    const { extensions } = await session.send("Extensions.getExtensions");
    extensionsByContext.set(
      context,
      extensions.flatMap(({ id, name }) =>
        actions.has(id) ? [{ id, name: actions.get(id) ?? name }] : [],
      ),
    );
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
