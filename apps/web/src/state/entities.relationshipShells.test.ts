import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../test-fixtures";
import { selectThreadRelationshipShells, subagentDescendantShellsAtom } from "./entities";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

type Projection = Parameters<typeof selectThreadRelationshipShells>[1];

const shell = (id: string, parentThreadId: string | null = null) =>
  ({
    id,
    forkedFrom: null,
    lineage: { parentThreadId, relationshipToParent: parentThreadId === null ? null : "fork" },
  }) as unknown as OrchestrationV2ThreadShell;

const threadId = "current" as OrchestrationV2ThreadShell["id"];

describe("selectThreadRelationshipShells", () => {
  it("keeps the thread, its parent, its children and the threads its projection names", () => {
    const threads = [
      shell("current", "parent"),
      shell("parent"),
      shell("child", "current"),
      shell("subagent-child"),
      shell("workflow-member"),
      shell("transfer-source"),
      shell("unrelated"),
      shell("grandchild", "child"),
    ];
    const projection = {
      thread: threads[0],
      subagents: [
        {
          childThreadId: "subagent-child",
          workflow: { agents: [{ childThreadId: "workflow-member" }, {}] },
        },
        { childThreadId: null },
      ],
      contextTransfers: [{ sourceThreadId: "transfer-source", targetThreadId: "current" }],
    } as unknown as Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "subagents" | "contextTransfers"
    >;

    expect(
      selectThreadRelationshipShells(threadId, projection, threads).map((thread) => thread.id),
    ).toEqual([
      "current",
      "parent",
      "child",
      "subagent-child",
      "workflow-member",
      "transfer-source",
    ]);
  });

  it("finds the parent from the shell before the projection loads", () => {
    const threads = [shell("current", "parent"), shell("parent"), shell("unrelated")];
    expect(
      selectThreadRelationshipShells(threadId, null as Projection, threads).map(
        (thread) => thread.id,
      ),
    ).toEqual(["current", "parent"]);
  });
});

it("reacts to reachable subagent shells without opening thread details", () => {
  const projection = makeThreadProjectionFixture();
  const ref = {
    environmentId: EnvironmentId.make("relationship-shell-test"),
    threadId: projection.thread.id,
  };
  const root: OrchestrationV2ThreadShell = {
    ...projection.thread,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
  };
  const child: OrchestrationV2ThreadShell = {
    ...root,
    id: ThreadId.make("child"),
    lineage: { ...root.lineage, parentThreadId: root.id, relationshipToParent: "subagent" },
  };
  const grandchild = {
    ...child,
    id: ThreadId.make("grandchild"),
    lineage: { ...child.lineage, parentThreadId: child.id },
  };
  const fork = {
    ...grandchild,
    id: ThreadId.make("fork"),
    lineage: { ...grandchild.lineage, relationshipToParent: "fork" as const },
  };
  const archived = { ...grandchild, id: ThreadId.make("archived"), archivedAt: root.updatedAt };
  const threads = Atom.make<ReadonlyArray<OrchestrationV2ThreadShell>>([
    { ...root, lineage: { ...child.lineage, parentThreadId: grandchild.id } },
    child,
    grandchild,
    fork,
    archived,
  ]);
  using _threads = vi
    .spyOn(environmentThreadShells, "environmentThreadsAtom")
    .mockReturnValue(threads);
  using _shell = vi
    .spyOn(environmentThreadShells, "quietThreadShellAtom")
    .mockReturnValue(Atom.make<EnvironmentThreadShell | null>(null));
  using readDetails = vi.spyOn(environmentThreadDetails, "quietThreadAtom");
  const registry = AtomRegistry.make();
  const selected = subagentDescendantShellsAtom(ref);
  const notify = vi.fn();
  try {
    registry.subscribe(selected, notify);
    const before = registry.get(selected);
    expect(before).toEqual([child, grandchild]);
    registry.set(
      threads,
      registry
        .get(threads)
        .map((thread) => (thread.id === fork.id ? { ...thread, title: "Updated fork" } : thread)),
    );
    expect(registry.get(selected)).toBe(before);
    expect(notify).not.toHaveBeenCalled();

    const running = { ...grandchild, status: "running" as const };
    registry.set(
      threads,
      registry.get(threads).map((thread) => (thread.id === grandchild.id ? running : thread)),
    );
    expect(registry.get(selected)).toEqual([child, running]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(readDetails).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
  }
});
