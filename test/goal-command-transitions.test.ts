import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { createMockContext, createMockPi } from "./support/pi-mock.js";
import {
  assistantUsageEntry,
  DEFAULT_SETTINGS_PATH,
  lastGoalStatus,
  pickSafetyState,
  registerGoal,
  registerGoalWithSettingsPath,
  requireLastGoal,
  restoreGoalForTest,
  restoreStoredGoalForTest,
  STALE_GOAL_TOOL_REASON,
  type StoredGoal,
  settingsPath,
  startGoalForTest,
} from "./support/goal-fixture.js";

test("session persistence restores stopped states with resumable command hints", async () => {
  for (const [status, statusline] of [
    ["paused", "paused"],
    ["blocked", "blocked"],
    ["usage_limited", "usage limited"],
  ] as const) {
    const restored = restoreGoalForTest(status);
    assert.equal(restored.statuses.get("goal"), statusline);

    await restored.mock.commands.get("goal")?.handler("", restored.ctx);
    assert.match(restored.notifications.at(-1)?.message ?? "", new RegExp(`Status: ${status}`));
    assert.match(restored.notifications.at(-1)?.message ?? "", /\/goal resume/);
  }
});

test("resume safely reactivates every resumable stopped status and rotates goal_id", async () => {
  for (const status of ["paused", "blocked", "usage_limited"] as const) {
    const restored = restoreGoalForTest(status);
    const beforeResume = restored.sessionGoal;

    await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

    const resumed = requireLastGoal(restored.mock);
    assert.equal(resumed.status, "active", `${status} should resume`);
    assert.notEqual(resumed.id, beforeResume.id);
    assert.match(restored.statuses.get("goal") ?? "", /^active \d+s$/u);
    assert.match(restored.notifications.at(-1)?.message ?? "", /Goal resumed from /u);
    assert.equal(restored.mock.sentUserMessages.length, 1);
    assert.match(restored.mock.sentUserMessages[0]?.text ?? "", /explicitly resumed/i);
    assert.equal(
      restored.mock.events.get("tool_call")?.[0]?.(
        { toolName: "bash", toolCallId: `tool-after-${status}`, input: {} },
        restored.ctx,
      ),
      undefined,
    );
  }
});

test("safety epochs reset on successful resume and active edit", async () => {
  const safety = {
    toolFreeRuns: 3,
    safetyPauseCause: "no_progress" as const,
  };
  const resumed = restoreGoalForTest("paused", safety);
  await resumed.mock.commands.get("goal")?.handler("resume", resumed.ctx);
  assert.deepEqual(pickSafetyState(requireLastGoal(resumed.mock)), {
    toolFreeRuns: 0,
    safetyPauseCause: undefined,
  });

  const edited = await startGoalForTest();
  const activeGoal = requireLastGoal(edited.mock);
  activeGoal.toolFreeRuns = 2;
  edited.mock.entries.push({ customType: "goal-state", data: { goal: activeGoal } });
  await edited.mock.commands.get("goal")?.handler("edit revised objective", edited.ctx);
  assert.deepEqual(pickSafetyState(requireLastGoal(edited.mock)), {
    toolFreeRuns: 0,
    safetyPauseCause: undefined,
  });
});

test("stopped input and failed resume preserve the exact safety epoch", async () => {
  const safety = {
    toolFreeRuns: 3,
    safetyPauseCause: "no_progress" as const,
  };
  const restored = restoreGoalForTest("paused", safety);
  restored.mock.events.get("input")?.[0]?.({ source: "interactive", text: "what happened?" }, restored.ctx);
  assert.deepEqual(pickSafetyState(requireLastGoal(restored.mock)), safety);

  restored.mock.rawPi.sendUserMessage = () => {
    throw new Error("resume delivery failed");
  };
  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);
  assert.equal(requireLastGoal(restored.mock).id, restored.sessionGoal.id);
  assert.deepEqual(pickSafetyState(requireLastGoal(restored.mock)), safety);
});

test("direct active input resets safety and reclassifies an in-flight automatic run", async () => {
  const active = await startGoalForTest({}, "finish", DEFAULT_SETTINGS_PATH);
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );
  await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: continuation, systemPrompt: "base" }, active.ctx);
  active.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
    active.ctx,
  );
  active.mock.events.get("input")?.[0]?.({ source: "extension", text: "unrelated extension input" }, active.ctx);

  active.mock.events.get("input")?.[0]?.({ source: "interactive", text: "new evidence" }, active.ctx);
  active.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
    active.ctx,
  );
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );

  assert.equal(requireLastGoal(active.mock).toolFreeRuns, 0);
});

test("resume rejects active goals without rotating goal_id", async () => {
  const active = await startGoalForTest();
  const activeGoal = requireLastGoal(active.mock);
  const activeMessageCount = active.mock.sentUserMessages.length;
  await active.mock.commands.get("goal")?.handler("resume", active.ctx);
  assert.match(active.notifications.at(-1)?.message ?? "", /only paused, blocked/i);
  assert.equal(requireLastGoal(active.mock).id, activeGoal.id);
  assert.equal(active.mock.sentUserMessages.length, activeMessageCount);

});

test("failed resume delivery restores the stopped state and original goal_id", async () => {
  const restored = restoreGoalForTest("blocked");
  restored.mock.rawPi.sendUserMessage = () => {
    throw new Error("runtime became busy");
  };

  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

  assert.equal(lastGoalStatus(restored.mock), "blocked");
  assert.equal(requireLastGoal(restored.mock).id, restored.sessionGoal.id);
  assert.equal(restored.statuses.get("goal"), "blocked");
  assert.equal(restored.mock.sentUserMessages.length, 0);
  assert.match(restored.notifications.at(-1)?.message ?? "", /runtime became busy/i);
  assert.deepEqual(
    restored.mock.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "stale-after-failed-resume", input: {} },
      restored.ctx,
    ),
    { block: true, reason: STALE_GOAL_TOOL_REASON },
  );
});

test("resume stays stopped when another policy hides terminal tools", async () => {
  const restored = restoreGoalForTest("paused");
  const originalId = restored.sessionGoal.id;
  const originalSetActiveTools = restored.mock.rawPi.setActiveTools.bind(restored.mock.rawPi);
  originalSetActiveTools(["read", "bash"]);

  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

  assert.equal(lastGoalStatus(restored.mock), "paused");
  assert.equal(requireLastGoal(restored.mock).id, originalId);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  assert.match(restored.notifications.at(-1)?.message ?? "", /Cannot resume \/goal/i);
});

test("resume succeeds after the restrictive policy restores terminal tools", async () => {
  const restored = restoreGoalForTest("paused");
  restored.mock.rawPi.setActiveTools(["read", "bash"]);
  restored.mock.rawPi.setActiveTools(["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);

  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

  assert.equal(lastGoalStatus(restored.mock), "active");
  assert.equal(restored.mock.sentUserMessages.length, 1);
  assert.deepEqual(restored.mock.rawPi.getActiveTools(), [
    "read",
    "bash",
    "goal_complete",
    "goal_blocked",
    "goal_wait",
  ]);
});

test("active edit pauses when another policy hides terminal tools", async () => {
  const edited = await startGoalForTest();
  edited.mock.rawPi.setActiveTools(["read", "bash"]);

  await edited.mock.commands.get("goal")?.handler("edit changed objective", edited.ctx);

  const restored = requireLastGoal(edited.mock);
  assert.equal(restored.status, "paused");
  assert.equal(restored.text, "finish");
  assert.equal(edited.mock.sentUserMessages.length, 1);
  assert.match(edited.notifications.at(-1)?.message ?? "", /goal tools.*paused/i);
});

test("failed start delivery clears a new goal and restores a replaced stopped goal", async () => {
  const freshMock = createMockPi();
  registerGoal(freshMock.pi);
  const freshContext = createMockContext();
  freshMock.events.get("session_start")?.[0]?.({}, freshContext.ctx);
  freshMock.rawPi.sendUserMessage = () => {
    throw new Error("start delivery failed");
  };
  await freshMock.commands.get("goal")?.handler("new objective", freshContext.ctx);
  assert.equal(lastGoalStatus(freshMock), null);
  assert.equal(freshContext.statuses.get("goal"), undefined);
  assert.match(freshContext.notifications.at(-1)?.message ?? "", /start delivery failed/i);

  let activeReplacementAborts = 0;
  const activeReplacementBranch: Record<string, unknown>[] = [];
  const activeReplacement = await startGoalForTest({
    abort: () => activeReplacementAborts++,
    sessionManager: {
      getBranch: () => activeReplacementBranch,
      getEntries: () => activeReplacementBranch,
    },
  });
  const activeOriginal = requireLastGoal(activeReplacement.mock);
  activeReplacementBranch.push(assistantUsageEntry({ totalTokens: 5 }));
  activeReplacement.mock.rawPi.sendUserMessage = () => {
    throw new Error("active replacement delivery failed");
  };
  await activeReplacement.mock.commands.get("goal")?.handler("active replacement objective", activeReplacement.ctx);
  const restoredActive = requireLastGoal(activeReplacement.mock);
  assert.equal(restoredActive.id, activeOriginal.id);
  assert.equal(restoredActive.text, activeOriginal.text);
  assert.equal(restoredActive.status, "active");
  assert.equal(activeReplacementAborts, 0);

  const replacement = await startGoalForTest();
  await replacement.mock.commands.get("goal")?.handler("pause", replacement.ctx);
  const original = requireLastGoal(replacement.mock);
  replacement.mock.rawPi.sendUserMessage = () => {
    throw new Error("replacement delivery failed");
  };
  await replacement.mock.commands.get("goal")?.handler("replacement objective", replacement.ctx);
  const restored = requireLastGoal(replacement.mock);
  assert.equal(restored.id, original.id);
  assert.equal(restored.text, original.text);
  assert.equal(restored.status, "paused");
  assert.deepEqual(
    replacement.mock.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "stale-after-replacement-failure", input: {} },
      replacement.ctx,
    ),
    { block: true, reason: STALE_GOAL_TOOL_REASON },
  );
});

test("failed active edit delivery restores the exact prior active goal", async () => {
  let aborts = 0;
  const edited = await startGoalForTest({ abort: () => aborts++ });
  const original = requireLastGoal(edited.mock);
  edited.mock.rawPi.sendUserMessage = () => {
    throw new Error("active edit delivery failed");
  };

  await edited.mock.commands.get("goal")?.handler("edit changed objective", edited.ctx);
  const restored = requireLastGoal(edited.mock);
  assert.equal(restored.id, original.id);
  assert.equal(restored.text, original.text);
  assert.equal(restored.status, "active");
  assert.equal(aborts, 0);
  assert.equal(
    edited.mock.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "stale-after-edit-failure", input: {} },
      edited.ctx,
    ),
    undefined,
  );
});

test("editing paused, blocked, or usage-limited goals preserves their stopped state", async () => {
  for (const status of ["paused", "blocked", "usage_limited"] as const) {
    const restored = restoreGoalForTest(status);
    const oldId = restored.sessionGoal.id;
    await restored.mock.commands.get("goal")?.handler("edit revised objective", restored.ctx);

    const edited = requireLastGoal(restored.mock);
    assert.equal(edited.status, status);
    assert.notEqual(edited.id, oldId);
    assert.equal(restored.mock.sentUserMessages.length, 0);
    assert.deepEqual(
      restored.mock.events.get("tool_call")?.[0]?.(
        { toolName: "bash", toolCallId: `stale-after-edit-${status}`, input: {} },
        restored.ctx,
      ),
      { block: true, reason: STALE_GOAL_TOOL_REASON },
    );
  }
});

test("pause remains active-only for new stopped statuses", async () => {
  for (const status of ["blocked", "usage_limited"] as const) {
    const restored = restoreGoalForTest(status);
    await restored.mock.commands.get("goal")?.handler("pause", restored.ctx);
    assert.match(restored.notifications.at(-1)?.message ?? "", /only active goals can be paused/i);
    assert.equal(restored.statuses.get("goal"), status === "usage_limited" ? "usage limited" : status);
  }
});
