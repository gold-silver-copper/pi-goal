import assert from "node:assert/strict";
import { test } from "vitest";
import { loadGoalStateFromSession } from "../src/persistence.js";
import {
  lastGoalStatus,
  requireGoalTool,
  requireLastGoal,
  STALE_GOAL_TOOL_REASON,
  startGoalForTest,
} from "./support/goal-fixture.js";

type Started = Awaited<ReturnType<typeof startGoalForTest>>;

async function interrupt(started: Started) {
  await started.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" }] },
    started.ctx,
  );
  await started.mock.events.get("agent_settled")?.[0]?.({}, started.ctx);
}

function userTurn(started: Started, text: string, source: "interactive" | "rpc" | "extension" = "interactive") {
  started.mock.events.get("input")?.[0]?.({ source, text }, started.ctx);
  started.mock.events.get("before_agent_start")?.[0]?.({ prompt: text, systemPrompt: "base" }, started.ctx);
}

function callResume(started: Started, goalId: string) {
  return requireGoalTool(started.mock, "goal_resume").execute(
    "resume-call",
    { goal_id: goalId },
    new AbortController().signal,
    () => undefined,
    started.ctx,
  );
}

function contractState(message: unknown) {
  return (message as { details?: { state?: string } } | undefined)?.details?.state;
}

test("a user message while the goal is paused carries the paused contract, not the inactive one", async () => {
  const started = await startGoalForTest({}, "keep the objective visible");
  await interrupt(started);
  assert.equal(lastGoalStatus(started.mock), "paused");
  assert.equal(contractState(started.mock.sentMessages.at(-1)?.message), "paused");

  const userMessage = { role: "user", content: [{ type: "text", text: "what happened?" }] };
  const result = (await started.mock.events.get("context")?.[0]?.({ messages: [userMessage] }, started.ctx)) as
    | { messages?: unknown[] }
    | undefined;
  const contract = result?.messages?.at(-1) as { content?: string } | undefined;
  assert.equal(contractState(contract), "paused");
  assert.match(contract?.content ?? "", /keep the objective visible/u);
  assert.match(contract?.content ?? "", /call goal_resume with this goal_id first/u);
  assert.doesNotMatch(contract?.content ?? "", /Goal mode is inactive/u);
});

test("goal_resume is rejected from a Goal-owned run", async () => {
  const started = await startGoalForTest();
  const goal = requireLastGoal(started.mock);
  // The kickoff prompt is Goal-owned (sent by the extension). Pausing inside it must
  // not let the same run resume the goal on its own.
  started.mock.events.get("input")?.[0]?.(
    { source: "extension", text: started.mock.sentUserMessages.at(-1)?.text ?? "" },
    started.ctx,
  );
  started.mock.events.get("before_agent_start")?.[0]?.(
    { prompt: started.mock.sentUserMessages.at(-1)?.text ?? "", systemPrompt: "base" },
    started.ctx,
  );
  await started.mock.commands.get("goal")?.handler("pause", started.ctx);

  const result = await callResume(started, goal.id);
  assert.match(result.content?.[0]?.text ?? "", /only a message from the user in this run can resume/u);
  assert.equal(lastGoalStatus(started.mock), "paused");
});

test("goal_resume is rejected from an extension-originated run and with a stale id", async () => {
  const started = await startGoalForTest();
  const goal = requireLastGoal(started.mock);
  await interrupt(started);

  userTurn(started, "another extension asks to continue", "extension");
  const fromExtension = await callResume(started, goal.id);
  assert.match(fromExtension.content?.[0]?.text ?? "", /only a message from the user/u);
  await started.mock.events.get("agent_end")?.[0]?.({ messages: [] }, started.ctx);

  userTurn(started, "continue");
  const stale = await callResume(started, "not-the-goal-id");
  assert.match(stale.content?.[0]?.text ?? "", /goal_id does not match/u);
  assert.equal(lastGoalStatus(started.mock), "paused");
});

test("goal_resume from a user run reactivates the goal, keeps its id, and continues after the run", async () => {
  const started = await startGoalForTest({}, "finish the migration");
  const goal = requireLastGoal(started.mock);
  await interrupt(started);
  const continuationsBefore = started.mock.sentUserMessages.length;

  // The user types "continue": the stale-tool block lifts and goal_resume is accepted.
  userTurn(started, "continue");
  assert.equal(
    started.mock.events.get("tool_call")?.[0]?.(
      { toolName: "goal_resume", toolCallId: "resume", input: { goal_id: goal.id } },
      started.ctx,
    ),
    undefined,
  );
  const result = await callResume(started, goal.id);
  const text = result.content?.[0]?.text ?? "";
  assert.match(text, /Goal resumed/u);
  assert.match(text, /finish the migration/u);
  assert.match(text, /Goal-mode rules in the goal contract apply again/u);
  assert.equal(result.terminate, undefined);

  const resumed = requireLastGoal(started.mock);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.id, goal.id);
  assert.equal(resumed.pauseReason, undefined);
  assert.equal(contractState(started.mock.sentMessages.at(-1)?.message), "active");

  await started.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "resumed" }] }] },
    started.ctx,
  );
  await started.mock.events.get("agent_settled")?.[0]?.({}, started.ctx);
  assert.equal(started.mock.sentUserMessages.length, continuationsBefore + 1);
  assert.match(started.mock.sentUserMessages.at(-1)?.text ?? "", /pi-goal-continuation:/u);
});

test("goal_resume is rejected for an active goal and resumes a blocked one", async () => {
  const started = await startGoalForTest();
  const goal = requireLastGoal(started.mock);
  userTurn(started, "continue");
  const active = await callResume(started, goal.id);
  assert.match(active.content?.[0]?.text ?? "", /goal is active, not paused or blocked/u);

  await requireGoalTool(started.mock, "goal_blocked").execute(
    "blocked-call",
    { goal_id: goal.id, reason: "needs a token", evidence: "401 from the registry" },
    new AbortController().signal,
    () => undefined,
    started.ctx,
  );
  assert.equal(lastGoalStatus(started.mock), "blocked");
  await started.mock.events.get("agent_end")?.[0]?.({ messages: [] }, started.ctx);
  userTurn(started, "I added the token, go ahead");
  const resumed = await callResume(started, goal.id);
  assert.match(resumed.content?.[0]?.text ?? "", /Goal resumed/u);
  assert.equal(lastGoalStatus(started.mock), "active");
});

test("stale tools stay blocked after an interruption until the user speaks", async () => {
  const started = await startGoalForTest();
  await interrupt(started);
  assert.deepEqual(
    started.mock.events.get("tool_call")?.[0]?.({ toolName: "bash", toolCallId: "stale", input: {} }, started.ctx),
    { block: true, reason: STALE_GOAL_TOOL_REASON },
  );
  userTurn(started, "what did you change?");
  assert.equal(
    started.mock.events.get("tool_call")?.[0]?.({ toolName: "bash", toolCallId: "fresh", input: {} }, started.ctx),
    undefined,
  );
  assert.equal(lastGoalStatus(started.mock), "paused");
});

function sessionWith(goal: Record<string, unknown>, assistant: Record<string, unknown>) {
  const entries = [
    { type: "message", message: { role: "user", content: "execute prompt.md" } },
    { type: "message", message: { role: "assistant", ...assistant } },
    { type: "custom", customType: "goal-state", data: { goal } },
  ];
  return { sessionManager: { getBranch: () => entries } };
}

const OLD_GOAL = {
  id: "c4ca61f5-5096-4887-809e-36047225a980",
  text: "execute prompt.md",
  startedAt: 1,
  updatedAt: 2,
  iteration: 1,
  tokensUsed: 61672003,
  timeUsedSeconds: 5084,
  baselineTokens: 0,
  automaticModelTurns: 0,
  toolFreeRepeatCount: 0,
};

test("restoring a 0.54.8 goal stopped by Esc brings it back paused as interrupted", () => {
  const blockedByAbortError = loadGoalStateFromSession(
    sessionWith(
      { ...OLD_GOAL, status: "blocked" },
      { stopReason: "error", errorMessage: "This operation was aborted" },
    ),
  );
  assert.equal(blockedByAbortError?.status, "paused");
  assert.equal(blockedByAbortError?.pauseReason, "interrupted");

  const pausedByAbort = loadGoalStateFromSession(
    sessionWith({ ...OLD_GOAL, status: "paused" }, { stopReason: "aborted", errorMessage: "Operation aborted" }),
  );
  assert.equal(pausedByAbort?.status, "paused");
  assert.equal(pausedByAbort?.pauseReason, "interrupted");

  const reallyBlocked = loadGoalStateFromSession(
    sessionWith({ ...OLD_GOAL, status: "blocked" }, { stopReason: "error", errorMessage: "Unauthorized: invalid API key" }),
  );
  assert.equal(reallyBlocked?.status, "blocked");
  assert.equal(reallyBlocked?.pauseReason, undefined);
});
