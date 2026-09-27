import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DEFAULT_SETTINGS_PATH,
  seedToolFreeRuns,
  lastGoalStatus,
  requireLastGoal,
  startGoalForTest,
} from "./support/goal-fixture.js";

test("assistant toolCall blocks reset no-progress even when tool_call hook never fires", async () => {
  const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );
  await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  for (let run = 1; run <= 2; run++) {
    const prompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
    active.mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, active.ctx);
    await active.mock.events.get("agent_end")?.[0]?.(
      { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
      active.ctx,
    );
    await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  }
  assert.equal(active.runtime.activeGoal?.toolFreeRuns, 2);

  const prompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, active.ctx);
  await active.mock.events.get("agent_end")?.[0]?.(
    {
      messages: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", name: "unknown", arguments: {} }],
        },
      ],
    },
    active.ctx,
  );
  assert.equal(lastGoalStatus(active.mock), "active");
  assert.equal(active.runtime.activeGoal?.toolFreeRuns, 0);
});

test("a preceding input transform preserves automatic continuation ownership", async () => {
  let aborts = 0;
  const capped = await startGoalForTest({ abort: () => aborts++ }, "finish", DEFAULT_SETTINGS_PATH);
  await capped.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    capped.ctx,
  );
  await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
  const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
  const transformed = `Respond briefly:\n\n${continuation}`;

  capped.mock.events.get("input")?.[0]?.({ source: "extension", text: transformed }, capped.ctx);
  capped.mock.events.get("before_agent_start")?.[0]?.({ prompt: transformed, systemPrompt: "base" }, capped.ctx);
  await capped.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    capped.ctx,
  );

  // Only automatic runs count toward the no-progress guard, so a count of one
  // proves the transformed prompt kept automatic continuation ownership.
  const goal = requireLastGoal(capped.mock);
  assert.equal(goal.status, "active");
  assert.equal(goal.toolFreeRuns, 1);
  assert.equal(aborts, 0);
});

test("a following prefix transform preserves automatic continuation ownership", async () => {
  let aborts = 0;
  const capped = await startGoalForTest({ abort: () => aborts++ }, "finish", DEFAULT_SETTINGS_PATH);
  await capped.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    capped.ctx,
  );
  await capped.mock.events.get("agent_settled")?.[0]?.({}, capped.ctx);
  const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
  const transformed = `Respond briefly:\n\n${continuation}`;

  capped.mock.events.get("input")?.[0]?.({ source: "extension", text: continuation }, capped.ctx);
  capped.mock.events.get("before_agent_start")?.[0]?.({ prompt: transformed, systemPrompt: "base" }, capped.ctx);
  await capped.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    capped.ctx,
  );

  // Only automatic runs count toward the no-progress guard, so a count of one
  // proves the transformed prompt kept automatic continuation ownership.
  const goal = requireLastGoal(capped.mock);
  assert.equal(goal.status, "active");
  assert.equal(goal.toolFreeRuns, 1);
  assert.equal(aborts, 0);
});

test("a preceding input transform preserves Goal prompt ownership", async () => {
  const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
  const kickoff = active.mock.sentUserMessages.at(-1)?.text ?? "";
  const transformed = `Respond briefly:\n\n${kickoff}`;
  seedToolFreeRuns(active, 2);

  active.mock.events.get("input")?.[0]?.({ source: "extension", text: transformed }, active.ctx);
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: transformed, systemPrompt: "base" }, active.ctx);

  assert.equal(active.runtime.activeGoal?.toolFreeRuns, 0);
});

test("a following prefix transform preserves Goal prompt ownership", async () => {
  const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
  const kickoff = active.mock.sentUserMessages.at(-1)?.text ?? "";
  const transformed = `Respond briefly:\n\n${kickoff}`;
  seedToolFreeRuns(active, 2);

  active.mock.events.get("input")?.[0]?.({ source: "extension", text: kickoff }, active.ctx);
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: transformed, systemPrompt: "base" }, active.ctx);

  assert.equal(active.runtime.activeGoal?.toolFreeRuns, 0);
});

test("a following marker quote or appended text cannot claim a Goal prompt", async () => {
  for (const variant of ["quoted-marker", "appended-text"] as const) {
    const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
    const kickoff = active.mock.sentUserMessages.at(-1)?.text ?? "";
    const marker = kickoff.match(/<!-- pi-goal-prompt:[^>]+-->/u)?.[0] ?? "";
    assert.notEqual(marker, "");
    seedToolFreeRuns(active, 2);
    const external =
      variant === "quoted-marker"
        ? `External monitor quoted ${marker}`
        : `${kickoff}\n\nExternal monitor result: approved`;

    active.mock.events.get("input")?.[0]?.({ source: "extension", text: kickoff }, active.ctx);
    active.mock.events.get("before_agent_start")?.[0]?.({ prompt: external, systemPrompt: "base" }, active.ctx);

    assert.equal(active.runtime.activeGoal?.toolFreeRuns, 2, variant);
  }
});

test("quoted or externally extended continuation markers remain non-owned", async () => {
  for (const variant of ["quoted-marker", "appended-text"] as const) {
    const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
    await active.mock.events.get("agent_end")?.[0]?.(
      { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
      active.ctx,
    );
    await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
    const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
    const marker = continuation.match(/<!-- pi-goal-continuation:[^>]+-->/u)?.[0] ?? "";
    assert.notEqual(marker, "");
    const external =
      variant === "quoted-marker"
        ? `External monitor quoted ${marker}`
        : `${continuation}\n\nExternal monitor result: approved`;

    // pi-goal sees the exact prompt before a later input handler rewrites it.
    active.mock.events.get("input")?.[0]?.(
      { source: "extension", text: continuation, streamingBehavior: "followUp" },
      active.ctx,
    );
    active.mock.events.get("before_agent_start")?.[0]?.({ prompt: external, systemPrompt: "base" }, active.ctx);
    active.mock.events.get("turn_end")?.[0]?.(
      { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
      active.ctx,
    );

  }
});

test("queued user follow-up resets safety only when its message starts", async () => {
  const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );
  await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: continuation, systemPrompt: "base" }, active.ctx);
  seedToolFreeRuns(active, 2);
  active.mock.events.get("input")?.[0]?.(
    { source: "interactive", text: "user follow-up", streamingBehavior: "followUp" },
    active.ctx,
  );
  assert.equal(active.runtime.activeGoal?.toolFreeRuns, 2);

  active.mock.events.get("message_start")?.[0]?.(
    { message: { role: "user", content: [{ type: "text", text: "user follow-up" }] } },
    active.ctx,
  );
  assert.equal(active.runtime.activeGoal?.toolFreeRuns, 0);
  active.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
    active.ctx,
  );
  assert.match(continuation, /pi-goal-continuation:/);
});

test("expanded queued follow-up claims manual ownership at its delivery boundary", async () => {
  const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );
  await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: continuation, systemPrompt: "base" }, active.ctx);
  seedToolFreeRuns(active, 2);
  active.mock.events.get("input")?.[0]?.(
    { source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
    active.ctx,
  );

  active.mock.events.get("message_start")?.[0]?.(
    {
      message: {
        role: "user",
        content: [{ type: "text", text: "Expanded review skill instructions" }],
      },
    },
    active.ctx,
  );
  active.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
    active.ctx,
  );

  assert.equal(active.runtime.activeGoal?.toolFreeRuns, 0);
});

describe("owned goal lifecycle boundaries do not consume a transformed follow-up", () => {
  for (const order of ["message-before-agent", "agent-before-message"] as const) {
    test(order, async () => {
      const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
      const ownedPrompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
      seedToolFreeRuns(active, 2);
      active.mock.events.get("input")?.[0]?.(
        { source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
        active.ctx,
      );

      const startMessage = () =>
        active.mock.events.get("message_start")?.[0]?.(
          { message: { role: "user", content: [{ type: "text", text: ownedPrompt }] } },
          active.ctx,
        );
      const startAgent = () =>
        active.mock.events.get("before_agent_start")?.[0]?.({ prompt: ownedPrompt, systemPrompt: "base" }, active.ctx);
      if (order === "message-before-agent") {
        startMessage();
        startAgent();
      } else {
        startAgent();
        startMessage();
      }

      assert.equal(active.runtime.activeGoal?.toolFreeRuns, 0);
      seedToolFreeRuns(active, 2);

      active.mock.events.get("message_start")?.[0]?.(
        {
          message: {
            role: "user",
            content: [{ type: "text", text: "Expanded review skill instructions" }],
          },
        },
        active.ctx,
      );
      assert.equal(active.runtime.activeGoal?.toolFreeRuns, 0);
    });
  }
});

describe("owned continuation lifecycle boundaries do not consume a transformed follow-up", () => {
  for (const order of ["message-before-agent", "agent-before-message"] as const) {
    test(order, async () => {
      const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
      await active.mock.events.get("agent_end")?.[0]?.(
        { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
        active.ctx,
      );
      await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
      const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
      seedToolFreeRuns(active, 2);
      active.mock.events.get("input")?.[0]?.(
        { source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
        active.ctx,
      );

      const startMessage = () =>
        active.mock.events.get("message_start")?.[0]?.(
          { message: { role: "user", content: [{ type: "text", text: continuation }] } },
          active.ctx,
        );
      const startAgent = () =>
        active.mock.events.get("before_agent_start")?.[0]?.({ prompt: continuation, systemPrompt: "base" }, active.ctx);
      if (order === "message-before-agent") {
        startMessage();
        startAgent();
      } else {
        startAgent();
        startMessage();
      }

      assert.equal(active.runtime.activeGoal?.toolFreeRuns, 2);
      active.mock.events.get("message_start")?.[0]?.(
        {
          message: {
            role: "user",
            content: [{ type: "text", text: "Expanded review skill instructions" }],
          },
        },
        active.ctx,
      );
      assert.equal(active.runtime.activeGoal?.toolFreeRuns, 0);
    });
  }
});

test("provider retry does not consume a pending transformed follow-up", async () => {
  const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );
  await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: continuation, systemPrompt: "base" }, active.ctx);
  active.mock.events.get("input")?.[0]?.(
    { source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
    active.ctx,
  );
  const retryableError = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "HTTP 524: upstream timeout",
    content: [],
  };
  await active.mock.events.get("agent_end")?.[0]?.({ messages: [retryableError] }, active.ctx);

  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: "provider retry", systemPrompt: "base" }, active.ctx);
  active.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
    active.ctx,
  );

  active.mock.events.get("message_start")?.[0]?.(
    {
      message: {
        role: "user",
        content: [{ type: "text", text: "Expanded review skill instructions" }],
      },
    },
    active.ctx,
  );
});

test("queued non-goal follow-up does not inherit automatic recovery ownership", async () => {
  const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );
  await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: continuation, systemPrompt: "base" }, active.ctx);
  active.mock.events.get("input")?.[0]?.(
    { source: "extension", text: "unrelated follow-up", streamingBehavior: "followUp" },
    active.ctx,
  );
  const retryableError = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "HTTP 524: upstream timeout",
    content: [],
  };
  active.mock.events.get("turn_end")?.[0]?.({ message: retryableError, toolResults: [] }, active.ctx);
  await active.mock.events.get("agent_end")?.[0]?.({ messages: [retryableError] }, active.ctx);
  const followUpStart = active.mock.events.get("before_agent_start")?.[0]?.(
    { prompt: "unrelated follow-up", systemPrompt: "base" },
    active.ctx,
  ) as { message?: { customType?: string } } | undefined;
  assert.equal(followUpStart?.message?.customType, "goal-contract");
  active.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
    active.ctx,
  );
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );
  await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  assert.equal(active.mock.sentUserMessages.length, 3);
});

test("three blank automatic runs pause for no progress without a fourth continuation", async () => {
  const stalled = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
  await stalled.mock.events.get("agent_end")?.[0]?.(
    {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
    },
    stalled.ctx,
  );
  await stalled.mock.events.get("agent_settled")?.[0]?.({}, stalled.ctx);

  for (let run = 1; run <= 3; run++) {
    const prompt = stalled.mock.sentUserMessages.at(-1)?.text ?? "";
    stalled.mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, stalled.ctx);
    await stalled.mock.events.get("agent_end")?.[0]?.(
      {
        messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "   ...  " }] }],
      },
      stalled.ctx,
    );
    await stalled.mock.events.get("agent_settled")?.[0]?.({}, stalled.ctx);
  }

  const stopped = requireLastGoal(stalled.mock);
  assert.equal(stopped.status, "paused");
  assert.equal(stopped.toolFreeRuns, 3);
  assert.equal(stopped.pauseReason, "no_progress");
  assert.equal(stalled.mock.sentUserMessages.length, 4);
  assert.match(stalled.notifications.at(-1)?.message ?? "", /3 automatic continuations in a row ended without using a tool/i);
});
