import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { loadGoalStateFromSession } from "../src/persistence.js";
import { requireGoalTool, requireLastGoal, startGoalForTest } from "./support/goal-fixture.js";

type Started = Awaited<ReturnType<typeof startGoalForTest>>;

const goalStates = (started: Started) =>
  started.mock.entries.filter((entry) => entry.customType === "goal-state").map((entry) => entry.data as { goal: Record<string, unknown> | null });

/** One model response in a tool loop: a tool call, its execution and the turn boundary. */
function response(started: Started) {
  started.mock.events.get("tool_call")?.[0]?.({ toolName: "bash", toolCallId: "call", input: {} }, started.ctx);
  started.mock.events.get("tool_execution_end")?.[0]?.({}, started.ctx);
  started.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [] },
    started.ctx,
  );
}

async function endRunAndContinue(started: Started) {
  await started.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }] }] },
    started.ctx,
  );
  await started.mock.events.get("agent_settled")?.[0]?.({}, started.ctx);
  const prompt = started.mock.sentUserMessages.at(-1)?.text ?? "";
  started.mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, started.ctx);
}

test("a 200-response goal writes fewer than 20 goal-state entries", async () => {
  const started = await startGoalForTest({}, "ship the storage migration");
  for (let index = 1; index <= 200; index += 1) {
    response(started);
    if (index % 40 === 0) await endRunAndContinue(started);
  }
  const count = goalStates(started).length;
  assert.ok(count < 20, `expected fewer than 20 goal-state entries, got ${count}`);
  assert.equal(requireLastGoal(started.mock).status, "active");
});

test("status changes, progress notes and waits are written; elapsed time every five active minutes", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-27T10:00:00Z") });
  const started = await startGoalForTest();
  const before = goalStates(started).length;

  for (let minute = 1; minute <= 30; minute += 1) {
    vi.advanceTimersByTime(60_000);
    response(started);
  }
  const timeWrites = goalStates(started).length - before;
  assert.ok(timeWrites >= 5 && timeWrites <= 6, `expected 5-6 time checkpoints, got ${timeWrites}`);
  assert.ok(Number(requireLastGoal(started.mock).timeUsedSeconds) >= 25 * 60);

  const beforeNote = goalStates(started).length;
  await requireGoalTool(started.mock, "goal_progress").execute(
    "note",
    { goal_id: requireLastGoal(started.mock).id, note: "half way" },
    new AbortController().signal,
    () => undefined,
    started.ctx,
  );
  assert.equal(goalStates(started).length, beforeNote + 1);

  await started.mock.commands.get("goal")?.handler("pause", started.ctx);
  assert.equal(requireLastGoal(started.mock).status, "paused");
});

test("shutdown always writes the final elapsed time", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-27T10:00:00Z") });
  const started = await startGoalForTest();
  vi.advanceTimersByTime(90_000);
  response(started);
  const before = goalStates(started).length;
  started.mock.events.get("session_shutdown")?.[0]?.({}, started.ctx);
  assert.equal(goalStates(started).length, before + 1);
  assert.equal(requireLastGoal(started.mock).timeUsedSeconds, 90);
});

test("a long objective is stored once; later entries omit it and restore still finds it", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-27T10:00:00Z") });
  const objective = `Refactor the parser. ${"Keep every public behaviour and add tests. ".repeat(10)}`.trim();
  assert.ok(objective.length > 200);
  const started = await startGoalForTest({}, objective);
  await requireGoalTool(started.mock, "goal_progress").execute(
    "note",
    { goal_id: requireLastGoal(started.mock).id, note: "lexer done" },
    new AbortController().signal,
    () => undefined,
    started.ctx,
  );
  await started.mock.commands.get("goal")?.handler("pause", started.ctx);

  const entries = goalStates(started);
  assert.equal(entries.filter((entry) => entry.goal?.text === objective).length, 1);
  assert.ok(entries.length >= 3);
  for (const entry of entries.slice(1)) assert.equal(Object.hasOwn(entry.goal ?? {}, "text"), false);

  // Restore reads the objective from the first entry, also after a compaction entry.
  const branch = [
    ...entries.slice(0, 1).map((data) => ({ type: "custom", customType: "goal-state", data })),
    { type: "compaction", summary: "Earlier work summary" },
    ...entries.slice(1).map((data) => ({ type: "custom", customType: "goal-state", data })),
  ];
  const restored = loadGoalStateFromSession({ sessionManager: { getBranch: () => branch } });
  assert.equal(restored?.text, objective);
  assert.equal(restored?.status, "paused");
  assert.equal(restored?.progress?.at(-1)?.note, "lexer done");
});

test("a short objective is written in every entry", async () => {
  const started = await startGoalForTest({}, "fix the flaky test");
  await started.mock.commands.get("goal")?.handler("pause", started.ctx);
  for (const entry of goalStates(started)) assert.equal(entry.goal?.text, "fix the flaky test");
});

test("a later entry without its objective and no earlier copy fails closed", () => {
  const branch = [
    { type: "custom", customType: "goal-state", data: { goal: { id: "g", status: "active", startedAt: 1, updatedAt: 1 } } },
  ];
  assert.equal(loadGoalStateFromSession({ sessionManager: { getBranch: () => branch } }), undefined);
});
