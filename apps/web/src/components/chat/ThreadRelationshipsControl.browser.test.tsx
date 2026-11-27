import "~/index.css";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  commandSucceeds: false,
  command: vi.fn(),
  canStopWorkflow: false,
  relatedShells: [] as unknown[],
  threadTitles: {} as Record<string, string>,
  archivedThreads: [] as unknown[],
  childProjections: new Map<string, unknown>(),
  projectionReads: new Set<string>(),
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) =>
    atom === null
      ? { data: null, isSuccess: false, isPending: false }
      : { data: state.threadTitles, isSuccess: true, isPending: false }) as never,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.canStopWorkflow) as never,
}));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadShell: (() => null) as never,
  useQuietThreadProjection: ((ref: { threadId: string } | null) => {
    if (ref === null) return null;
    state.projectionReads.add(ref.threadId);
    const projection =
      state.childProjections.get(ref.threadId) ??
      ((state.projection as { thread: { id: string } } | null)?.thread.id === ref.threadId
        ? state.projection
        : null);
    return projection === null ? null : { projection };
  }) as never,
  useThreadRelationshipShells: (() =>
    state.projection === null
      ? []
      : [(state.projection as { thread: unknown }).thread, ...state.relatedShells]) as never,
  useSubagentDescendantShells: (() => state.relatedShells) as never,
  useProjects: (() => []) as never,
  useHiddenThreadKeys: (() => new Set()) as never,
  useAnyEnvironmentHiding: (() => false) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironment: (() => null) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), () => ({
  useArchivedThreadSnapshots: (() => ({
    snapshots: [{ environmentId: "environment", snapshot: { threads: state.archivedThreads } }],
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async (value: unknown) => {
    state.command(value);
    return state.commandSucceeds
      ? AsyncResult.success(undefined)
      : AsyncResult.failure(Cause.fail(new Error("Connection lost")));
  }) as never,
}));

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ScrollArea } from "../ui/scroll-area";
import { ToastProvider } from "../ui/toast";
import { threadFamilies } from "../../state/threads";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("fork");

function setup() {
  state.commandSucceeds = false;
  state.command.mockReset();
  state.canStopWorkflow = false;
  state.relatedShells = [];
  state.threadTitles = { source: "Source" };
  state.archivedThreads = [];
  state.childProjections.clear();
  state.projectionReads.clear();
  state.projection = {
    thread: {
      id: threadId,
      title: "Fork",
      activeProviderThreadId: null,
      lineage: { parentThreadId: ThreadId.make("source"), relationshipToParent: "fork" },
      forkedFrom: null,
    },
    runs: [{ id: "run", ordinal: 1, status: "completed" }],
    subagents: [],
    contextTransfers: [],
    providerThreads: [],
    providerSessions: [{ id: "session", status: "ready" }],
  };
}

function setupSubagentTree(
  childStatus: "running" | "completed",
  grandchildStatus?: "running" | "completed",
) {
  setup();
  const projection = makeThreadProjectionFixture();
  const childId = ThreadId.make("child");
  const grandchildId = ThreadId.make("grandchild");
  const child = {
    ...projection.thread,
    id: childId,
    title: "Child agent",
    lineage: {
      rootThreadId: projection.thread.id,
      parentThreadId: projection.thread.id,
      relationshipToParent: "subagent" as const,
    },
    status: childStatus,
  };
  const grandchild = {
    ...child,
    id: grandchildId,
    title: "Grandchild agent",
    lineage: { ...child.lineage, parentThreadId: childId },
    status: grandchildStatus,
  };
  const projectedChild = runningSubagent(projection.thread, childId);
  const projectedGrandchild = runningSubagent(child, grandchildId);
  const rootProjection = {
    ...projection,
    subagents: [{ ...projectedChild, status: childStatus }],
  };
  const childProjection = {
    ...projection,
    thread: child,
    subagents:
      grandchildStatus === undefined ? [] : [{ ...projectedGrandchild, status: grandchildStatus }],
  };
  state.projection = rootProjection;
  state.childProjections.set(childId, childProjection);
  state.relatedShells = grandchildStatus === undefined ? [child] : [child, grandchild];
  return { rootId: projection.thread.id, childProjection, rootProjection };
}

function runningSubagent(
  owner: OrchestrationV2ThreadProjection["thread"],
  childThreadId: ThreadId,
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`agent-${childThreadId}`),
    threadId: owner.id,
    runId: null,
    parentNodeId: NodeId.make("parent"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: owner.providerInstanceId,
    providerThreadId: null,
    childThreadId,
    nativeTaskRef: null,
    prompt: "Inspect the change",
    title: null,
    model: "fixture-model",
    status: "running",
    result: null,
    startedAt: owner.updatedAt,
    completedAt: null,
    updatedAt: owner.updatedAt,
  };
}

it("opens a running grandchild from its parent's nested list", async () => {
  const { rootId } = setupSubagentTree("running", "running");
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={rootId}
      showLineage
      showSideChats={false}
    />,
    { router: `/environment/${rootId}` },
  );

  const child = screen.getByRole("button", { name: /^Child agent/ });
  const grandchild = screen.getByRole("button", { name: /^Grandchild agent/ });
  await expect.element(grandchild).toBeVisible();
  expect(child.element().closest("li")?.contains(grandchild.element())).toBe(true);
  expect(
    grandchild.element().getBoundingClientRect().left -
      child.element().getBoundingClientRect().left,
  ).toBe(16);
  expect(state.projectionReads).toEqual(new Set([rootId, "child"]));
  await grandchild.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/environment/grandchild"),
  );
});

it("holds the thread family, which brings in idle subagents, only while the lineage shows", async () => {
  const { rootId } = setupSubagentTree("completed", "completed");
  const release = vi.fn();
  using mount = vi.spyOn(threadFamilies, "mount").mockReturnValue(release);
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={rootId}
      showLineage={false}
      showSideChats={false}
    />,
  );
  expect(mount).not.toHaveBeenCalled();
  await screen.rerender(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={rootId}
      showLineage
      showSideChats={false}
    />,
  );
  expect(mount).toHaveBeenCalledExactlyOnceWith(expect.anything(), environmentId, rootId);
  await screen.unmount();
  expect(release).toHaveBeenCalledOnce();
});

it("keeps a completed subtree collapsed with its descendant count until expanded", async () => {
  const { rootId } = setupSubagentTree("completed", "completed");
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={rootId}
      showLineage
      showSideChats={false}
    />,
  );

  await screen.getByRole("button", { name: /Previous agents/ }).click();
  const toggle = screen.getByRole("button", { name: "Expand Child agent" });
  const grandchild = screen.getByRole("button", { name: /Grandchild agent/ });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByRole("button", { name: /Child agent.*1/ })).toBeVisible();
  await expect.element(grandchild).not.toBeInTheDocument();
  expect(state.projectionReads).toEqual(new Set([rootId]));
  await toggle.click();
  await expect.element(grandchild).toBeVisible();
  await screen.getByRole("button", { name: "Collapse Child agent" }).click();
  await expect.element(grandchild).not.toBeInTheDocument();
});

it("keeps a completed child with a running grandchild out of Previous agents", async () => {
  const { rootId } = setupSubagentTree("completed", "running");
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={rootId}
      showLineage
      showSideChats={false}
    />,
  );

  await expect.element(screen.getByText("Lineage · 1 running", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^Child agent/ })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Previous agents/ }))
    .not.toBeInTheDocument();
});

it("keeps the original icon inset when all direct children are leaves", async () => {
  const { rootId } = setupSubagentTree("running");
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={rootId}
      showLineage
      showSideChats={false}
    />,
  );

  const child = screen.getByRole("button", { name: /^Child agent/ });
  await expect.element(child).toBeVisible();
  const button = child.element();
  const style = getComputedStyle(button);
  expect(button.querySelector("svg")?.getBoundingClientRect().left).toBe(
    button.getBoundingClientRect().left +
      parseFloat(style.paddingInlineStart) +
      parseFloat(style.borderInlineStartWidth),
  );
  expect(state.projectionReads).toEqual(new Set([rootId]));
});

it("uses each launching thread for stop and keeps rich hover content on the direct child", async () => {
  const { rootId } = setupSubagentTree("running", "running");
  state.commandSucceeds = true;
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={rootId}
      showLineage
      showSideChats={false}
    />,
  );

  await userEvent.hover(screen.getByRole("button", { name: /^Child agent/ }));
  await expect.element(page.getByText("fixture-model", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Stop subagent Child agent" }).click();

  await userEvent.hover(screen.getByRole("button", { name: /^Grandchild agent/ }));
  await expect.element(page.getByText("Open subagent in this chat", { exact: true })).toBeVisible();
  await expect.element(page.getByText("fixture-model", { exact: true })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Stop subagent Grandchild agent" }).click();
  expect(state.command.mock.calls).toEqual([
    [{ environmentId, input: { threadId: rootId, subagentId: "agent-child" } }],
    [{ environmentId, input: { threadId: "child", subagentId: "agent-grandchild" } }],
  ]);
});

it.each(["direct", "nested"] as const)(
  "preserves %s workflow controls and members",
  async (depth) => {
    const { rootId, rootProjection, childProjection } = setupSubagentTree("running", "running");
    const owner = depth === "direct" ? rootProjection : childProjection;
    const coordinatorId =
      depth === "direct" ? childProjection.thread.id : ThreadId.make("grandchild");
    const workflow = {
      ...runningSubagent(owner.thread, coordinatorId),
      title: "Inspect changes",
      driver: ProviderDriverKind.make("claudeAgent"),
      origin: "provider_native",
      workflow: {
        name: "Inspect changes",
        phases: [{ index: 0, title: "Review" }],
        agents: [{ index: 0, label: "Review agent", state: "running", phaseIndex: 0 }],
      },
    } as const;
    const projection = { ...owner, subagents: [workflow] };
    if (depth === "direct") state.projection = projection;
    else state.childProjections.set(owner.thread.id, projection);
    state.canStopWorkflow = true;
    state.commandSucceeds = true;
    await using screen = await render(
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={rootId}
        showLineage
        showSideChats={false}
      />,
    );

    await screen.getByRole("button", { name: "Expand Inspect changes" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Open Review agent chat" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /^Grandchild agent/ }))
      .not.toBeInTheDocument();
    await userEvent.hover(screen.getByRole("button", { name: /^Inspect changes/ }));
    await screen.getByRole("button", { name: "Stop workflow Inspect changes" }).click();
    expect(state.command.mock.calls).toEqual([
      [{ environmentId, input: { threadId: owner.thread.id, subagentId: workflow.id } }],
    ]);
  },
);

it.each([
  ["merge", "Could not merge back"],
  ["disconnect", "Could not disconnect agent session"],
])("reports a rejected %s command and clears the busy state", async (action, title) => {
  setup();
  await using screen = await render(
    <ToastProvider timeout={0}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />
    </ToastProvider>,
  );

  if (action === "merge") {
    await screen.getByRole("button", { name: "Merge back to source conversation" }).click();
  } else {
    await screen.getByRole("button", { name: "More thread actions" }).click();
    await page.getByRole("menuitem", { name: "Disconnect agent session" }).click();
  }

  await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  await expect
    .element(
      screen.getByRole("button", {
        name: action === "merge" ? "Merge back to source conversation" : "More thread actions",
      }),
    )
    .toBeEnabled();
});

it.each([
  ["merge", "Could not merge back"],
  ["disconnect", "Could not disconnect agent session"],
])("clears the previous %s error after a successful retry", async (action, title) => {
  setup();
  await using screen = await render(
    <ToastProvider timeout={0}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />
    </ToastProvider>,
    { router: "/environment/fork" },
  );

  const runAction = async () => {
    if (action === "merge") {
      await screen.getByRole("button", { name: "Merge back to source conversation" }).click();
    } else {
      await screen.getByRole("button", { name: "More thread actions" }).click();
      await page.getByRole("menuitem", { name: "Disconnect agent session" }).click();
    }
  };

  await runAction();
  await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");

  state.commandSucceeds = true;
  await runAction();

  await expect.element(page.getByText(title, { exact: true })).not.toBeInTheDocument();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe(
      action === "merge" ? "/environment/source" : "/environment/fork",
    );
  });
  if (action === "disconnect") {
    await expect.element(screen.getByRole("button", { name: "More thread actions" })).toBeEnabled();
  }
});

it("opens an idle child from Lineage when its shell has not been loaded", async () => {
  setup();
  const projection = makeThreadProjectionFixture();
  const childId = ThreadId.make("omitted-child");
  const environmentId = EnvironmentId.make("local");
  state.projection = {
    ...projection,
    subagents: [
      {
        id: NodeId.make("agent"),
        threadId: projection.thread.id,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: projection.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "Inspect the change",
        title: "Idle child",
        model: null,
        status: "completed",
        result: null,
        startedAt: null,
        completedAt: projection.thread.updatedAt,
        updatedAt: projection.thread.updatedAt,
      },
    ],
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={projection.thread.id}
      showLineage
      showSideChats
    />,
  );
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  const child = screen.getByRole("button", { name: /Idle child/ });
  await expect.element(child).toBeEnabled();
  await child.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/local/omitted-child"),
  );
});

it("shows a lineage thread's full title in its tooltip", async () => {
  setup();
  const longTitle = "Compare the lineage tooltip against a title that the row truncates";
  const sourceThread = {
    ...(state.projection as { thread: Record<string, unknown> }).thread,
    id: "source",
    title: longTitle,
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  state.relatedShells = [sourceThread];
  await using _screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats={false}
    />,
  );

  await userEvent.hover(page.getByText(longTitle, { exact: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
});

it("shows a side chat's full title in its tooltip", async () => {
  setup();
  const longTitle = "Side chat question with a title that the side chat row truncates";
  state.relatedShells = [
    {
      id: "side",
      title: longTitle,
      lineage: {
        parentThreadId: threadId,
        relationshipToParent: "fork",
        rootThreadId: threadId,
        sideChat: true,
      },
    },
  ];
  await using _screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage={false}
      showSideChats
    />,
  );

  await userEvent.hover(page.getByText(longTitle, { exact: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
});

it("shows a remote subagent's full title in its tooltip even when its environment is unavailable", async () => {
  setup();
  const longTitle = "Investigate a remote subagent issue across linked environments";
  const remoteEnvId = EnvironmentId.make("remote-env");
  const remoteThreadId = ThreadId.make("remote-thread");
  const now = DateTime.makeUnsafe("2026-10-31T20:00:00.000Z");
  state.projection = {
    ...(state.projection as Record<string, unknown>),
    subagents: [
      {
        id: NodeId.make("remote-agent"),
        threadId,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: "provider",
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Run remote task",
        title: longTitle,
        model: null,
        status: "completed",
        result: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
        remoteChild: {
          environmentId: remoteEnvId,
          threadId: remoteThreadId,
          label: "Remote VM with a long machine name in the office",
        },
      },
    ],
  };
  await using screen = await render(
    <div style={{ width: 320 }}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats={false}
      />
    </div>,
    { router: "/environment/fork" },
  );

  // A finished remote task sits with the other finished agents, not in its own list.
  await expect
    .element(screen.getByRole("button", { name: new RegExp(longTitle) }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  const row = screen.getByRole("button", { name: new RegExp(longTitle) });
  // A long environment label must not squeeze the title out of the row.
  expect(
    page.getByText(longTitle, { exact: true }).element().getBoundingClientRect().width,
  ).toBeGreaterThan(0);
  await userEvent.hover(row);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Runs on Remote VM with a long machine name in the office. Connect to it to open the thread there.",
  );

  await row.click({ force: true });
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");
});

it("explains why Merge back is unavailable before the fork completes a run", async () => {
  setup();
  state.projection = { ...(state.projection as Record<string, unknown>), runs: [] };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats={false}
    />,
    { router: "/environment/fork" },
  );

  const mergeBack = screen.getByRole("button", { name: "Merge back to source conversation" });
  await userEvent.hover(mergeBack);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
      "Complete a run in this fork before merging it back",
    ),
  );

  state.commandSucceeds = true;
  await mergeBack.click({ force: true });
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");
});

it("shows a delegated-from thread's full title in its tooltip even when its environment is unavailable", async () => {
  setup();
  const longTitle = "Parent task delegated from another machine that has a long description";
  state.projection = {
    ...(state.projection as Record<string, unknown>),
    thread: {
      ...(state.projection as { thread: Record<string, unknown> }).thread,
      delegatedFrom: {
        environmentId: EnvironmentId.make("parent-env"),
        threadId: ThreadId.make("parent-thread"),
        title: longTitle,
      },
    },
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats={false}
    />,
    { router: "/environment/fork" },
  );

  const row = screen.getByRole("button", { name: new RegExp(longTitle) });
  await userEvent.hover(row);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Delegated from a linked environment. Connect to it to open the parent thread.",
  );

  await row.click({ force: true });
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");
});

it("hides a deleted fork and keeps unloaded and archived forks with their current titles", async () => {
  setup();
  const projection = makeThreadProjectionFixture();
  state.threadTitles = { "unloaded-fork": "Unloaded fork", "archived-fork": "Archived fork" };
  state.archivedThreads = [
    {
      ...projection.thread,
      id: ThreadId.make("archived-fork"),
      title: "Old archived title",
      archivedAt: projection.thread.updatedAt,
      lineage: { parentThreadId: projection.thread.id, relationshipToParent: "fork" },
    },
  ];
  state.projection = {
    ...projection,
    contextTransfers: ["deleted-fork", "unloaded-fork", "archived-fork"].map((id) => ({
      sourceThreadId: projection.thread.id,
      targetThreadId: ThreadId.make(id),
      status: "pending",
    })),
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={projection.thread.id}
      showLineage
      showSideChats
    />,
  );
  await expect.element(screen.getByText("Unloaded fork", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Archived fork", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("deleted-fork", { exact: true })).not.toBeInTheDocument();
});

it.each([1, 18])("continues scrolling the panel past a list of %i subagents", async (count) => {
  setup();
  const projection = makeThreadProjectionFixture();
  state.projection = projection;
  state.relatedShells = Array.from({ length: count }, (_, index) => ({
    id: ThreadId.make(`subagent-${index}`),
    title: `Subagent ${index}`,
    forkedFrom: null,
    lineage: { parentThreadId: projection.thread.id, relationshipToParent: "subagent" },
    activityRunStatus: "running",
    status: "running",
  }));
  await using screen = await render(
    <div data-testid="panel" style={{ height: 320, width: 280 }}>
      <ScrollArea>
        <ThreadRelationshipsPanel
          environmentId={environmentId}
          threadId={projection.thread.id}
          showLineage
          showSideChats
        />
        <div style={{ height: 600 }} />
      </ScrollArea>
    </div>,
  );
  if (count > 6) {
    await screen.getByRole("button", { name: "Show 12 more" }).click();
    await expect.element(screen.getByText("Subagent 17", { exact: true })).toBeInTheDocument();
  }
  const list = screen.getByRole("list", { name: "Related threads" }).element();
  const viewport = screen
    .getByTestId("panel")
    .element()
    .querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
  list.scrollTop = list.scrollHeight;
  if (count > 6) expect(list.scrollTop).toBeGreaterThan(0);
  viewport.scrollTop = 0;
  await userEvent.wheel(list, { delta: { y: 300 } });
  await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
});
