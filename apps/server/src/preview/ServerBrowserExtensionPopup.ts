// @effect-diagnostics globalTimers:off -- CDP event waits follow the lifetime of Playwright sessions.
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as Queue from "effect/Queue";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

import type { ServerBrowserViewer, ServerBrowserViewerOutput } from "./ServerBrowser.ts";
import { playwrightPageTargetId, playwrightRootSession } from "./ServerBrowserContexts.ts";
import { asRecord, editingCommand, modifiersOf, num } from "./ServerBrowserInput.ts";
import { captureViewport } from "./ServerBrowserPage.ts";

const TAB_TARGET_TIMEOUT_MS = 2_000;
const POPUP_TIMEOUT_MS = 3_000;
const VIEWER_OUTPUT_LIMIT = 64;

const tabTargetId = async (session: CDPSession, page: Page) => {
  const pageTargetId = playwrightPageTargetId(page);
  if (!pageTargetId) throw new Error("Playwright's Chromium page target is unavailable.");
  const { targetInfos } = await session.send("Target.getTargets", { filter: [{ type: "tab" }] });
  for (const tab of targetInfos) {
    // Chrome's tab target has no link to its page in TargetInfo. Auto-attach exposes the child.
    const { sessionId } = await session.send("Target.attachToTarget", {
      targetId: tab.targetId,
      flatten: false,
    });
    const child = Promise.withResolvers<string | null>();
    const receive = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== sessionId) return;
      const message = asRecord(JSON.parse(event.message));
      if (message?.method !== "Target.attachedToTarget") return;
      const targetInfo = asRecord(asRecord(message.params)?.targetInfo);
      if (targetInfo?.type === "page" && typeof targetInfo.targetId === "string") {
        child.resolve(targetInfo.targetId);
      }
    };
    session.on("Target.receivedMessageFromTarget", receive);
    const timer = setTimeout(() => child.resolve(null), TAB_TARGET_TIMEOUT_MS);
    try {
      await session.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({
          id: 1,
          method: "Target.setAutoAttach",
          params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: false },
        }),
      });
      if ((await child.promise) === pageTargetId) return tab.targetId;
    } finally {
      clearTimeout(timer);
      session.off("Target.receivedMessageFromTarget", receive);
      await session.send("Target.detachFromTarget", { sessionId }).catch(constVoid);
    }
  }
  throw new Error("Chrome did not expose the tab target for this page.");
};

const attachPopup = async (
  context: BrowserContext,
  session: CDPSession,
  targetId: string,
  excludeFromTabAdoption: (page: Page) => void,
) => {
  const root = playwrightRootSession(context);
  if (!root) throw new Error("Playwright's Chromium session is unavailable.");

  const popup = Promise.withResolvers<Page | null>();
  const receive = (page: Page) => {
    if (playwrightPageTargetId(page) !== targetId) return;
    excludeFromTabAdoption(page);
    popup.resolve(page);
  };
  const { targetInfo } = await session.send("Target.getTargetInfo", { targetId });
  if (targetInfo.attached) return null;

  context.prependListener("page", receive);
  const timer = setTimeout(() => popup.resolve(null), POPUP_TIMEOUT_MS);
  try {
    // Playwright detaches from Chrome's initial "other" target. Attach on its own
    // session after Chrome promotes the popup to a page so Playwright creates a Page.
    await root.send("Target.attachToTarget", { targetId, flatten: true });
    return await popup.promise;
  } finally {
    clearTimeout(timer);
    context.off("page", receive);
  }
};

const triggerAction = async (
  context: BrowserContext,
  page: Page,
  extensionId: string,
  excludeFromTabAdoption: (page: Page) => void,
) => {
  const session = await context.browser()!.newBrowserCDPSession();
  try {
    const targetId = await tabTargetId(session, page);
    // Extensions query the active Chrome tab, which can differ from the tab shown in Preview.
    await page.bringToFront();
    await session.send("Target.setDiscoverTargets", { discover: true });
    const popup = Promise.withResolvers<string | null>();
    // Tabs the extension opens are attached by Playwright from the start; its popup is not.
    const receive = ({
      targetInfo,
    }: {
      targetInfo: { targetId: string; type: string; attached: boolean; url: string };
    }) => {
      if (
        targetInfo.type === "page" &&
        !targetInfo.attached &&
        targetInfo.url.startsWith(`chrome-extension://${extensionId}/`)
      ) {
        popup.resolve(targetInfo.targetId);
      }
    };
    session.on("Target.targetCreated", receive);
    session.on("Target.targetInfoChanged", receive);
    const timer = setTimeout(() => popup.resolve(null), POPUP_TIMEOUT_MS);
    try {
      await session.send("Extensions.triggerAction", { id: extensionId, targetId });
      const popupId = await popup.promise;
      return popupId === null
        ? null
        : await attachPopup(context, session, popupId, excludeFromTabAdoption);
    } finally {
      clearTimeout(timer);
      session.off("Target.targetCreated", receive);
      session.off("Target.targetInfoChanged", receive);
    }
  } finally {
    await session.detach().catch(constVoid);
  }
};

const pendingActions = new WeakMap<BrowserContext, Promise<Page | null>>();

export const triggerExtensionAction = (
  context: BrowserContext,
  page: Page,
  extensionId: string,
  excludeFromTabAdoption: (page: Page) => void,
) => {
  // CDP reports popup targets without their parent tab. Only one trigger can claim them at a time.
  const pending = (pendingActions.get(context)?.catch(constVoid) ?? Promise.resolve())
    .then(() => triggerAction(context, page, extensionId, excludeFromTabAdoption))
    .finally(() => {
      if (pendingActions.get(context) === pending) pendingActions.delete(context);
    });
  pendingActions.set(context, pending);
  return pending;
};

const dispatchInput = async (session: CDPSession, raw: unknown) => {
  const message = asRecord(raw);
  if (!message) return;
  const x = num(message.x);
  const y = num(message.y);
  const modifiers = modifiersOf(message);
  switch (message.type) {
    case "mouse": {
      const type =
        message.action === "down"
          ? "mousePressed"
          : message.action === "up"
            ? "mouseReleased"
            : "mouseMoved";
      const { button } = message;
      await session.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: button === "left" || button === "middle" || button === "right" ? button : "none",
        buttons: num(message.buttons),
        clickCount: num(message.clickCount, type === "mouseMoved" ? 0 : 1),
        modifiers,
      });
      return;
    }
    case "wheel":
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: num(message.deltaX),
        deltaY: num(message.deltaY),
        modifiers,
      });
      return;
    case "key": {
      const key = typeof message.key === "string" ? message.key : "";
      const code = typeof message.code === "string" ? message.code : "";
      if (message.action === "up") {
        await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
        return;
      }
      const text = typeof message.text === "string" ? message.text : undefined;
      await session.send("Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        key,
        code,
        modifiers,
        ...(text ? { text, unmodifiedText: text } : {}),
        ...editingCommand(key, modifiers),
        windowsVirtualKeyCode: num(
          message.keyCode,
          key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
        ),
      });
      return;
    }
    case "text":
      if (typeof message.text === "string" && message.text.length > 0) {
        await session.send("Input.insertText", { text: message.text.slice(0, 10_000) });
      }
      return;
  }
};

export const attachExtensionPopupViewer = Effect.fn("ServerBrowser.attachExtensionPopupViewer")(
  function* <E>(
    page: Page,
    input: {
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
      readonly canOperate: boolean;
    },
    onError: (cause: unknown) => E,
  ) {
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const output = yield* Queue.make<ServerBrowserViewerOutput>({
      capacity: VIEWER_OUTPUT_LIMIT,
      strategy: "dropping",
    });
    const session = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => page.context().newCDPSession(page), catch: onError }),
      (session) =>
        Effect.promise(async () => {
          await session.send("Page.stopScreencast").catch(constVoid);
          await session.detach().catch(constVoid);
        }),
    );
    const control = {
      _tag: "control",
      canOperate: input.canOperate,
      controller: input.canOperate ? "you" : "unclaimed",
      generation: 0,
      dialog: null,
    } as const;
    // Chromium waits for an ack before the next frame, so only a dropped frame needs handling.
    const push = (next: ServerBrowserViewerOutput) => {
      if (!Queue.offerUnsafe(output, next) && next._tag === "frame") runFork(next.ack);
    };
    const close = () => push({ _tag: "gone" });
    yield* Effect.acquireRelease(
      Effect.sync(() => page.on("close", close)),
      () => Effect.sync(() => page.off("close", close)),
    );
    push(control);
    let width = 0;
    let height = 0;
    const viewport = (nextWidth: number, nextHeight: number) => {
      if (width === nextWidth && height === nextHeight) return;
      width = nextWidth;
      height = nextHeight;
      push({ _tag: "viewport", width, height });
    };
    const { cssLayoutViewport } = yield* Effect.tryPromise({
      try: () => session.send("Page.getLayoutMetrics"),
      catch: onError,
    });
    viewport(cssLayoutViewport.clientWidth, cssLayoutViewport.clientHeight);
    let frameReceived = false;
    session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      frameReceived = true;
      viewport(metadata.deviceWidth, metadata.deviceHeight);
      push({
        _tag: "frame",
        data: Buffer.from(data, "base64"),
        ack: Effect.promise(() =>
          session.send("Page.screencastFrameAck", { sessionId }).catch(constVoid),
        ),
      });
    });
    const quality = Math.min(100, Math.max(1, Math.round(input.quality)));
    yield* Effect.tryPromise({
      try: () =>
        session.send("Page.startScreencast", {
          format: "jpeg",
          quality,
          maxWidth: Math.max(1, Math.round(input.maxWidth)),
          maxHeight: Math.max(1, Math.round(input.maxHeight)),
        }),
      catch: onError,
    });
    if (!frameReceived) {
      yield* Effect.forkScoped(
        Effect.promise(async () => {
          const data = await captureViewport(session, { format: "jpeg", quality }).catch(constVoid);
          if (data && !frameReceived) {
            push({ _tag: "frame", data: Buffer.from(data, "base64"), ack: Effect.void });
          }
        }),
      );
    }
    return {
      output,
      input: (raw: unknown) =>
        input.canOperate
          ? Effect.promise(() => dispatchInput(session, raw).catch(constVoid))
          : Effect.void,
    } satisfies ServerBrowserViewer;
  },
);
