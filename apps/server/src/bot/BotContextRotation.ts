import {
  isCompactionCommandMessage,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

type RotationRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "startedAt" | "status" | "userMessageId"
>;
type RotationMessage = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "runId" | "role" | "text" | "scheduledTaskId" | "maintenance"
>;

function precedingStartedRuns(runs: ReadonlyArray<RotationRun>, ordinal: number) {
  return runs
    .filter((run) => run.ordinal < ordinal && run.startedAt !== null)
    .sort((left, right) => right.ordinal - left.ordinal);
}

export function deriveRotationHandoff(
  runs: ReadonlyArray<RotationRun>,
  messages: ReadonlyArray<RotationMessage>,
  ordinal: number,
) {
  const previous = precedingStartedRuns(runs, ordinal).find(
    (run) =>
      messages.find((message) => message.id === run.userMessageId)?.scheduledTaskId === undefined,
  );
  if (previous?.status !== "completed") return null;
  const prompt = messages.find((message) => message.id === previous.userMessageId);
  if (prompt?.maintenance !== "bot_context_rotation") return null;
  const summary = messages.findLast(
    (message) => message.runId === previous.id && message.role === "assistant",
  )?.text;
  return summary !== undefined && summary.trim() !== ""
    ? { flushRunId: previous.id, summary }
    : null;
}

export const readRotationHandoff = Effect.fn("BotContextRotation.readHandoff")(function* (
  store: ProjectionStore.ProjectionStoreV2["Service"],
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
  ordinal: number,
) {
  const threadId = projection.thread.id;
  for (const run of precedingStartedRuns(projection.runs, ordinal)) {
    const prompt =
      projection.messages.find((message) => message.id === run.userMessageId) ??
      (yield* store.getMessagesById(threadId, [run.userMessageId])).get(run.userMessageId);
    if (prompt?.scheduledTaskId !== undefined) continue;
    if (run.status !== "completed" || prompt?.maintenance !== "bot_context_rotation") return null;

    const { messages } = yield* store.getThreadRecords(threadId, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["assistant"],
    });
    return deriveRotationHandoff([run], [prompt, ...messages], ordinal);
  }
  return null;
});

export function idleRotationRun(
  {
    thread,
    runs,
    messages,
    providerThreads,
    runtimeRequests,
    turnItems,
    contextTransfers,
  }: Pick<
    OrchestrationV2ThreadProjection,
    | "thread"
    | "runs"
    | "messages"
    | "providerThreads"
    | "runtimeRequests"
    | "turnItems"
    | "contextTransfers"
  >,
  runId: RunId,
) {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  const latest = runs.findLast((run) => run.status !== "cancelled" || run.startedAt !== null);
  if (latest?.id !== runId || latest.status !== "completed") return null;
  const message = messages.find((candidate) => candidate.id === latest.userMessageId);
  if (
    message === undefined ||
    message.maintenance !== undefined ||
    isCompactionCommandMessage(message) ||
    runtimeRequests.some((request) => request.status === "pending") ||
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    derivePendingBackgroundWork({
      latestRun: latest,
      runs,
      providerThreads,
      turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  ) {
    return null;
  }
  return latest;
}
