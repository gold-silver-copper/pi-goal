import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { lastGoal, requireGoalTool, requireLastGoal, startGoalForTest } from "./support/goal-fixture.js";

type Started = Awaited<ReturnType<typeof startGoalForTest>>;

function progress(started: Started, note: string, goalId = requireLastGoal(started.mock).id) {
  return requireGoalTool(started.mock, "goal_progress").execute(
    "progress",
    { goal_id: goalId, note },
    new AbortController().signal,
    () => undefined,
    started.ctx,
  );
}

function toolResult(started: Started, toolName = "bash") {
  return started.mock.events.get("tool_result")?.[0]?.(
    { type: "tool_result", toolName, toolCallId: "call", input: {}, content: [{ type: "text", text: "ok" }], isError: false },
    started.ctx,
  ) as { content?: Array<{ type: string; text?: string }> } | undefined;
}

test("goal_progress records a note, shows it in the status line, and does not end the turn", async () => {
  const started = await startGoalForTest({}, "migrate the storage layer");
  const result = await progress(started, "Plan: 1) schema  2) backfill\n3) switch reads");
  assert.equal(result.terminate, undefined);
  assert.equal(result.content?.[0]?.text, "Progress noted.");

  const goal = requireLastGoal(started.mock);
  assert.equal(goal.progress?.length, 1);
  assert.equal(goal.progress?.[0]?.note, "Plan: 1) schema 2) backfill 3) switch reads");
  assert.match(started.statuses.get("goal") ?? "", /^active \d+s · Plan: 1\) schema 2\) backfill 3\) switch reads$/u);
});

test("the goal keeps the last 20 notes and /goal status shows the last 10 with their age", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-27T10:00:00Z") });
  const started = await startGoalForTest({ mode: "tui", hasUI: true });
  for (let index = 1; index <= 22; index += 1) {
    await progress(started, `step ${index} done`);
    vi.advanceTimersByTime(60_000);
  }
  const goal = requireLastGoal(started.mock);
  assert.equal(goal.progress?.length, 20);
  assert.equal(goal.progress?.[0]?.note, "step 3 done");

  await started.mock.commands.get("goal")?.handler("status", started.ctx);
  const report = started.notifications.at(-1)?.message ?? "";
  assert.match(report, /Progress notes:/u);
  assert.match(report, /  1m ago: step 22 done/u);
  assert.match(report, /  10m ago: step 13 done/u);
  assert.doesNotMatch(report, /step 12 done/u);
  assert.match(report, /Active elapsed: 22m/u);
});

test("goal_progress rejects stale ids, empty or long notes, and stopped goals", async () => {
  const started = await startGoalForTest();
  assert.match((await progress(started, "x", "stale")).content?.[0]?.text ?? "", /goal_id does not match/u);
  assert.match((await progress(started, "   ")).content?.[0]?.text ?? "", /note is empty/u);
  assert.match((await progress(started, "x".repeat(301))).content?.[0]?.text ?? "", /note is too long \(301\/300/u);
  await started.mock.commands.get("goal")?.handler("pause", started.ctx);
  assert.match((await progress(started, "still here")).content?.[0]?.text ?? "", /goal is paused, not active/u);
  assert.equal(lastGoal(started.mock)?.progress, undefined);
});

test("after 45 minutes of active time without a note, one tool result carries a reminder", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-27T10:00:00Z") });
  const started = await startGoalForTest();
  const reminder = "No goal_progress note for 45 min.";

  vi.advanceTimersByTime(44 * 60_000);
  assert.equal(toolResult(started), undefined);

  vi.advanceTimersByTime(2 * 60_000);
  const reminded = toolResult(started);
  assert.deepEqual(reminded?.content?.map((block) => block.text), ["ok", reminder]);
  assert.equal(toolResult(started), undefined, "one reminder per 45 minutes");
  assert.equal(toolResult(started, "goal_progress"), undefined, "goal tools never carry it");

  vi.advanceTimersByTime(30 * 60_000);
  await progress(started, "halfway");
  vi.advanceTimersByTime(40 * 60_000);
  assert.equal(toolResult(started), undefined, "a note restarts the 45 minutes");
  vi.advanceTimersByTime(6 * 60_000);
  assert.equal(toolResult(started)?.content?.at(-1)?.text, reminder);
});

test("waiting time does not count toward the progress reminder", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-27T10:00:00Z") });
  const started = await startGoalForTest();
  const goal = requireLastGoal(started.mock);
  await requireGoalTool(started.mock, "goal_wait").execute(
    "wait",
    { goal_id: goal.id, reason: "CI is running", resume_after_ms: 3_600_000 },
    new AbortController().signal,
    () => undefined,
    started.ctx,
  );
  vi.advanceTimersByTime(50 * 60_000);
  assert.equal(toolResult(started), undefined);
});
