import type { EnvironmentId } from "@t3tools/contracts";
import type { PreviewStreamViewport } from "@t3tools/client-runtime/preview/server-browser-stream";
import { useGT } from "gt-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";

export function ExtensionPopupPanel({
  environmentId,
  threadId,
  tabId,
  visible,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly visible: boolean;
  readonly onClose?: (() => void) | undefined;
}) {
  const gt = useGT();
  const [viewport, setViewport] = useState<PreviewStreamViewport | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- outside presses can start anywhere in the document, including portals
  useEffect(() => {
    if (!onClose) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (panelRef.current?.contains(target) || target.closest("[data-extension-popup-anchor]"))
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [onClose]);

  const captureEscape = onClose
    ? (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Escape" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    : undefined;

  return (
    <div className="pointer-events-none absolute inset-2 z-20 flex items-start justify-end">
      <div
        ref={panelRef}
        role="region"
        aria-label={gt("Browser extension popup")}
        aria-hidden={viewport === null}
        onKeyDownCapture={captureEscape}
        className="max-h-full max-w-full overflow-hidden rounded-lg border bg-background shadow-lg"
        style={{
          width: viewport?.width ?? "100%",
          height: viewport?.height ?? "100%",
          visibility: viewport ? "visible" : "hidden",
          pointerEvents: viewport ? "auto" : "none",
        }}
      >
        <ServerBrowserSurface
          environmentId={environmentId}
          threadId={threadId}
          tabId={tabId}
          visible={visible}
          extensionPopup
          followSize={false}
          onViewport={setViewport}
          className="h-full w-full"
        />
      </div>
    </div>
  );
}
