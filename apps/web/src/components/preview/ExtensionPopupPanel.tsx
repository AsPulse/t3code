import type { EnvironmentId } from "@t3tools/contracts";
import type { PreviewStreamViewport } from "@t3tools/client-runtime/preview/server-browser-stream";
import { useGT } from "gt-react";
import { useState } from "react";

import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";

export function ExtensionPopupPanel({
  environmentId,
  threadId,
  tabId,
  visible,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly visible: boolean;
}) {
  const gt = useGT();
  const [viewport, setViewport] = useState<PreviewStreamViewport | null>(null);
  return (
    <div className="pointer-events-none absolute inset-2 z-20 flex items-start justify-end">
      <div
        role="region"
        aria-label={gt("Browser extension popup")}
        aria-hidden={viewport === null}
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
