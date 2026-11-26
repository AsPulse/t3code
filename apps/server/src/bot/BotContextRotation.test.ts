import { MessageId, RunId, ScheduledTaskId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveRotationHandoff } from "./BotContextRotation.ts";

const flushRunId = RunId.make("flush");
const run = {
  id: flushRunId,
  ordinal: 1,
  startedAt: DateTime.makeUnsafe(0),
  status: "completed",
  userMessageId: MessageId.make("flush-prompt"),
} as const;
const prompt = {
  id: run.userMessageId,
  runId: flushRunId,
  role: "user",
  text: "Write a handoff",
  maintenance: "bot_context_rotation",
} as const;
const assistant = {
  id: MessageId.make("summary"),
  runId: flushRunId,
  role: "assistant",
  text: "Saved context",
} as const;
const next = { ...run, id: RunId.make("next"), ordinal: 2, userMessageId: MessageId.make("next") };
const nextPrompt = {
  id: next.userMessageId,
  runId: next.id,
  role: "user",
  text: "Continue",
} as const;

describe("deriveRotationHandoff", () => {
  it("uses the final assistant message of the completed flush", () => {
    expect(
      deriveRotationHandoff(
        [run],
        [prompt, { ...assistant, id: MessageId.make("draft"), text: "Draft" }, assistant],
        2,
      ),
    ).toEqual({ flushRunId, summary: assistant.text });
  });

  it.each(["failed", "interrupted"] as const)("skips a %s flush", (status) => {
    expect(deriveRotationHandoff([{ ...run, status }], [prompt, assistant], 2)).toBeNull();
  });

  it("skips a flush whose last output is blank", () => {
    expect(
      deriveRotationHandoff(
        [run],
        [
          prompt,
          assistant,
          {
            ...assistant,
            id: MessageId.make("blank"),
            text: "  \n",
          },
        ],
        2,
      ),
    ).toBeNull();
  });

  it("carries the handoff across a scheduled run and a never-started run", () => {
    expect(
      deriveRotationHandoff(
        [next, run, { ...next, id: RunId.make("queued"), startedAt: null, ordinal: 3 }],
        [prompt, assistant, { ...nextPrompt, scheduledTaskId: ScheduledTaskId.make("task") }],
        4,
      ),
    ).toEqual({ flushRunId, summary: assistant.text });
  });

  it("consumes the handoff once a normal run starts", () => {
    expect(deriveRotationHandoff([run, next], [prompt, assistant, nextPrompt], 3)).toBeNull();
  });
});
