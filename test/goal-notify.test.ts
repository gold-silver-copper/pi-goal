import assert from "node:assert/strict";
import { basename } from "node:path";
import { test, vi } from "vitest";
import {
  DEFAULT_SETTINGS_PATH,
  lastGoalStatus,
  requireGoalTool,
  requireLastGoal,
  settingsPath,
  startGoalForTest,
} from "./support/goal-fixture.js";
import { writeFileSync } from "node:fs";

type Notice = { title: string; message: string };
type Started = Awaited<ReturnType<typeof startGoalForTest>>;

async function start(
  options: { settings?: Record<string, unknown>; clockTickMs?: number; overrides?: Record<string, unknown> } = {},
  objective = "ship the release notes",
) {
  const notices: Notice[] = [];
  let path = DEFAULT_SETTINGS_PATH;
  if (options.settings) {
    path = settingsPath(`notify-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(options.settings));
  }
  const started = await startGoalForTest({ mode: "tui", hasUI: true, ...options.overrides }, objective, path, {
    notifier: (title, message) => notices.push({ title, message }),
    ...(options.clockTickMs ? { clockTickMs: options.clockTickMs } : {}),
  });
  return { started, notices };
}

function tool(started: Started, name: string, params: Record<string, unknown>) {
  return requireGoalTool(started.mock, name).execute(
    name,
    { goal_id: requireLastGoal(started.mock).id, ...params },
    new AbortController().signal,
    () => undefined,
    started.ctx,
  );
}

async function endRun(started: Started, assistant: Record<string, unknown>) {
  await started.mock.events.get("agent_end")?.[0]?.({ messages: [{ role: "assistant", ...assistant }] }, started.ctx);
  await started.mock.events.get("agent_settled")?.[0]?.({}, started.ctx);
}

test("completion notifies with the project and the objective in the title", async () => {
  const { started, notices } = await start();
  await tool(started, "goal_complete", { summary: "Done and verified." });
  assert.deepEqual(notices, [
    { title: `pi-goal · ${basename(process.cwd())} · ship the release notes`, message: "Goal complete" },
  ]);
});

test("a blocked goal, an error pause and a wait for the user notify", async () => {
  const blocked = await start();
  await tool(blocked.started, "goal_blocked", { reason: "needs registry credentials", evidence: "401 twice" });
  assert.match(blocked.notices.at(-1)?.message ?? "", /^Goal blocked: needs registry credentials$/u);

  const errored = await start();
  await endRun(errored.started, { stopReason: "error", errorMessage: "Permission denied by remote service" });
  assert.match(errored.notices.at(-1)?.message ?? "", /^Goal paused after an agent error \(Permission denied/u);

  const waiting = await start();
  await tool(waiting.started, "goal_wait", { reason: "please publish fuxix 0.1.1" });
  assert.match(waiting.notices.at(-1)?.message ?? "", /^Waiting on you: please publish fuxix 0\.1\.1$/u);
});

test("waits with a wake condition or a deadline do not notify, and neither do pauses the user caused", async () => {
  const { started, notices } = await start();
  await tool(started, "goal_wait", { reason: "CI", resume_after_ms: 600_000 });
  started.mock.events.get("input")?.[0]?.({ source: "interactive", text: "wake up" }, started.ctx);
  await tool(started, "goal_wait", { reason: "build", wake_when: { command: "false" } });
  await started.mock.commands.get("goal")?.handler("pause", started.ctx);
  await started.mock.commands.get("goal")?.handler("resume", started.ctx);
  await endRun(started, { stopReason: "error", errorMessage: "This operation was aborted" });
  assert.equal(lastGoalStatus(started.mock), "paused");
  assert.deepEqual(notices, []);
});

test("no notifications outside the TUI or when the setting is off", async () => {
  const printMode = await start({ overrides: { mode: "print", hasUI: false } });
  await tool(printMode.started, "goal_complete", { summary: "Done." });
  assert.deepEqual(printMode.notices, []);

  const off = await start({ settings: { notifications: false } });
  await tool(off.started, "goal_complete", { summary: "Done." });
  assert.deepEqual(off.notices, []);
});

test("three blank automatic runs pause for no progress and notify", async () => {
  const { started, notices } = await start();
  await endRun(started, { stopReason: "stop", content: [] });
  for (let run = 1; run <= 3; run += 1) {
    const prompt = started.mock.sentUserMessages.at(-1)?.text ?? "";
    started.mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, started.ctx);
    await endRun(started, { stopReason: "stop", content: [] });
  }
  assert.equal(requireLastGoal(started.mock).pauseReason, "no_progress");
  assert.match(notices.at(-1)?.message ?? "", /^Goal paused because automatic continuations stopped using tools/u);
});

test("checkpoints notify every checkpointMinutes of active time with the last note", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-27T10:00:00Z") });
  const { started, notices } = await start({ settings: { checkpointMinutes: 30 }, clockTickMs: 60_000 });
  await tool(started, "goal_progress", { note: "schema migrated" });
  await vi.advanceTimersByTimeAsync(29 * 60_000);
  assert.equal(notices.length, 0);
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  const recorded = notices as Notice[];
  assert.equal(recorded.length, 1);
  assert.match(recorded[0]?.message ?? "", /^Active 30m; last note: schema migrated$/u);
  await vi.advanceTimersByTimeAsync(29 * 60_000);
  assert.equal(recorded.length, 2);
  assert.match(recorded[1]?.message ?? "", /^Active 1h0m/u);
});

test("waiting time does not count toward checkpoints", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-27T10:00:00Z") });
  const { started, notices } = await start({ settings: { checkpointMinutes: 30 }, clockTickMs: 60_000 });
  await tool(started, "goal_wait", { reason: "CI", wake_when: { command: "false", interval_s: 100_000 } });
  await vi.advanceTimersByTimeAsync(90 * 60_000);
  assert.deepEqual(notices, []);
});

test("maxActiveHours pauses the goal, aborts the turn and notifies; a resume starts a fresh limit", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-27T10:00:00Z") });
  let aborts = 0;
  const { started, notices } = await start({
    settings: { checkpointMinutes: null, maxActiveHours: 1 },
    clockTickMs: 60_000,
    overrides: { abort: () => aborts++ },
  });
  await vi.advanceTimersByTimeAsync(59 * 60_000);
  assert.equal(lastGoalStatus(started.mock), "active");
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  assert.equal(lastGoalStatus(started.mock), "paused");
  assert.equal(requireLastGoal(started.mock).pauseReason, "time_limit");
  assert.equal(started.statuses.get("goal"), "paused (time limit)");
  assert.equal(aborts, 1);
  assert.match(notices.at(-1)?.message ?? "", /^Goal paused because it reached its active-time limit/u);

  await started.mock.commands.get("goal")?.handler("resume", started.ctx);
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  assert.equal(lastGoalStatus(started.mock), "active", "the limit counts from the resume");
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  assert.equal(requireLastGoal(started.mock).pauseReason, "time_limit");
});

test("exhausted retries on the five-hour limit wait until 60 s after the reset and notify", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-25T07:36:32Z") });
  const { started, notices } = await start();
  await endRun(started, {
    stopReason: "error",
    errorMessage:
      "Claude rate limit (five_hour) — resets 1:10:00 AM: You've hit your session limit · resets 1:10am (America/Los_Angeles)",
  });
  const waiting = requireLastGoal(started.mock).waiting;
  assert.equal(new Date(waiting?.resumeAt ?? 0).toISOString(), "2026-09-25T08:11:00.000Z");
  assert.match(waiting?.reason ?? "", /^Provider limit \(Claude rate limit/u);
  assert.match(notices.at(-1)?.message ?? "", /^Rate limited; the goal resumes at /u);
  const sentBefore = started.mock.sentUserMessages.length;

  await vi.advanceTimersByTimeAsync(34 * 60_000 + 27_000);
  assert.equal(started.mock.sentUserMessages.length, sentBefore, "not before the reset plus slack");
  await vi.advanceTimersByTimeAsync(2_000);
  assert.match(started.mock.sentUserMessages.at(-1)?.text ?? "", /safety deadline passed/u);
});

test("an unparseable retryable error keeps the deadline-free wait; a usage limit with a reset waits for it", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-25T07:36:32Z") });
  const unparsed = await start();
  await endRun(unparsed.started, { stopReason: "error", errorMessage: "HTTP 429: Too Many Requests" });
  const waiting = requireLastGoal(unparsed.started.mock).waiting;
  assert.equal(waiting?.resumeAt, undefined);
  assert.match(waiting?.reason ?? "", /Provider retries exhausted/u);

  const usage = await start();
  await endRun(usage.started, {
    stopReason: "error",
    errorMessage: "You have hit your ChatGPT usage limit. Please try again in 3 hours.",
  });
  assert.equal(lastGoalStatus(usage.started.mock), "active");
  assert.equal(
    new Date(requireLastGoal(usage.started.mock).waiting?.resumeAt ?? 0).toISOString(),
    "2026-09-25T10:37:32.000Z",
  );

  const exhausted = await start();
  await endRun(exhausted.started, { stopReason: "error", errorMessage: "Provider account is out of credits" });
  assert.equal(lastGoalStatus(exhausted.started.mock), "usage_limited");
});
