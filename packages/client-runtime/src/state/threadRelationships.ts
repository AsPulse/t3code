import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadStructure } from "./models.ts";

export type ThreadRelationshipKind = "parent" | "fork" | "subagent" | "transfer";

export interface ThreadRelationshipNode {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly missing: boolean;
}

export interface ThreadRelationshipEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadRelationshipKind;
  readonly status: string | null;
}

export interface ThreadRelationshipGraph {
  readonly nodes: ReadonlyMap<ThreadId, ThreadRelationshipNode>;
  readonly edges: ReadonlyArray<ThreadRelationshipEdge>;
}

export interface ThreadRelationshipWalkRow {
  readonly threadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly depth: number;
  readonly edge: ThreadRelationshipEdge;
}

export function resolveMergeBackTargetThreadId(
  projection: Pick<ThreadStructure, "thread"> | null,
): ThreadId | null {
  if (projection?.thread.lineage.relationshipToParent !== "fork") return null;
  return projection.thread.forkedFrom?.type === "run"
    ? projection.thread.forkedFrom.threadId
    : projection.thread.lineage.parentThreadId;
}

function edgeKey(edge: ThreadRelationshipEdge): string {
  return `${edge.sourceThreadId}\u001f${edge.targetThreadId}\u001f${edge.kind}`;
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: ThreadStructure | null;
}): ThreadRelationshipGraph {
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of input.threads) {
    // Callers order shells from most to least authoritative. In particular,
    // live shells precede archived snapshots, which may still contain a stale
    // copy during archive refresh.
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }
  const threads = [...threadsById.values()];
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    threads.map((thread) => [thread.id, { threadId: thread.id, thread, missing: false }]),
  );
  const edgesByKey = new Map<string, ThreadRelationshipEdge>();
  const ensureNode = (threadId: ThreadId) => {
    if (!nodes.has(threadId)) {
      nodes.set(threadId, { threadId, thread: null, missing: true });
    }
  };
  const addEdge = (edge: ThreadRelationshipEdge) => {
    ensureNode(edge.sourceThreadId);
    ensureNode(edge.targetThreadId);
    edgesByKey.set(
      edgeKey(edge),
      edge.kind === "subagent" && edge.status === "rolled_back"
        ? { ...edge, status: "interrupted" }
        : edge,
    );
  };

  const selectedThread = input.projection?.thread;
  const lineageThreads =
    selectedThread !== undefined && !threadsById.has(selectedThread.id)
      ? [...threads, { ...selectedThread, activityRunStatus: null, status: null }]
      : threads;
  for (const thread of lineageThreads) {
    const parentThreadId =
      thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : thread.lineage.parentThreadId;
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      status: thread.activityRunStatus ?? thread.status,
    });
  }

  if (input.projection !== null) {
    const ownerThreadId = input.projection.thread.id;
    for (const subagent of input.projection.subagents) {
      if (subagent.childThreadId === null) continue;
      const child = threadsById.get(subagent.childThreadId);
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: "subagent",
        status:
          child?.activityRunStatus ??
          (child?.latestRunId != null && !isOrchestrationV2WorkActive(subagent.status)
            ? child.status
            : subagent.status),
      });
    }
    for (const transfer of input.projection.contextTransfers) {
      if (transfer.sourceThreadId === transfer.targetThreadId) continue;
      addEdge({
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: transfer.targetThreadId,
        kind: "transfer",
        status: transfer.status,
      });
    }
  }

  return { nodes, edges: [...edgesByKey.values()] };
}

export function immediateThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>();
  const rows: ThreadRelationshipWalkRow[] = [];

  for (const edge of graph.edges) {
    const relatedId =
      edge.sourceThreadId === threadId
        ? edge.targetThreadId
        : edge.targetThreadId === threadId
          ? edge.sourceThreadId
          : null;
    if (relatedId === null || visited.has(relatedId)) continue;
    visited.add(relatedId);
    rows.push({ threadId: relatedId, fromThreadId: threadId, depth: 1, edge });
  }

  return rows;
}

export interface SubagentBranchSummary {
  readonly descendantCount: number;
  readonly runningCount: number;
  readonly hasActiveDescendants: boolean;
}

export function summarizeSubagentBranches(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly threadId: ThreadId;
  readonly excludedThreadIds: ReadonlySet<ThreadId>;
  readonly isHidden: (threadId: ThreadId) => boolean;
}): ReadonlyMap<ThreadId, SubagentBranchSummary> {
  const children = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  for (const edge of input.graph.edges) {
    if (edge.kind !== "subagent") continue;
    const shell = input.graph.nodes.get(edge.targetThreadId)?.thread;
    if (!shell || shell.archivedAt != null || shell.lineage.sideChat || input.isHidden(shell.id))
      continue;
    const siblings = children.get(edge.sourceThreadId);
    if (siblings) siblings.push(shell);
    else children.set(edge.sourceThreadId, [shell]);
  }

  const visited = new Set([...input.excludedThreadIds, input.threadId]);
  const branches = new Map<ThreadId, SubagentBranchSummary>();
  const reachable: Array<{ parent: ThreadId; shell: OrchestrationV2ThreadShell }> = [];
  const visitChildren = (parent: ThreadId) => {
    for (const shell of children.get(parent) ?? []) {
      if (visited.has(shell.id)) continue;
      visited.add(shell.id);
      reachable.push({ parent, shell });
    }
  };
  visitChildren(input.threadId);
  for (const { shell } of reachable) visitChildren(shell.id);
  for (const { parent, shell } of reachable.reverse()) {
    const descendants = branches.get(shell.id);
    const siblings = branches.get(parent);
    const status = shell.activityRunStatus ?? shell.status;
    branches.set(parent, {
      descendantCount: (siblings?.descendantCount ?? 0) + 1 + (descendants?.descendantCount ?? 0),
      runningCount:
        (siblings?.runningCount ?? 0) +
        Number(status === "running") +
        (descendants?.runningCount ?? 0),
      hasActiveDescendants:
        siblings?.hasActiveDescendants === true ||
        descendants?.hasActiveDescendants === true ||
        ["preparing", "starting", "queued", "pending", "running", "waiting"].includes(status ?? ""),
    });
  }
  return branches;
}

export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

export function threadRelationshipRowStatus(
  graph: ThreadRelationshipGraph,
  row: Pick<ThreadRelationshipWalkRow, "threadId" | "edge">,
): string | null {
  if (row.edge.kind === "transfer" || row.threadId === row.edge.targetThreadId) {
    return row.edge.status;
  }
  const thread = graph.nodes.get(row.threadId)?.thread;
  return thread?.activityRunStatus ?? thread?.status ?? null;
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Web pins the parent and distinct merge-back target before newest-created-first ordering.
 * Mobile does not share this exception; do not reuse it as the canonical relationship order.
 */
export function orderWebThreadLineageRows(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): ReadonlyArray<ThreadRelationshipWalkRow> {
  const pinRank = (row: ThreadRelationshipWalkRow): number => {
    if (isParentThreadRelationship(row.edge, input.currentThreadId)) return 0;
    if (row.threadId === input.mergeTargetThreadId) return 1;
    return 2;
  };

  return [...input.rows].sort((left, right) => {
    const rankDelta = pinRank(left) - pinRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(left.threadId));
    const rightCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(right.threadId));
    if (leftCreatedAt !== rightCreatedAt) {
      if (leftCreatedAt === null) return 1;
      if (rightCreatedAt === null) return -1;
      return rightCreatedAt - leftCreatedAt;
    }
    return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
  });
}
