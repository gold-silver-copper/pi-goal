import assert from "node:assert/strict";
import { test } from "vitest";
import { type ActiveGoal, loadGoalStateFromSession, serializeGoalState } from "../src/persistence.js";

// Real goal-state entries written by pi-goal 0.54.8 (from the user's sessions).
const ACTIVE_0548 = {
  goal: {
    id: "c4ca61f5-5096-4887-809e-36047225a980",
    text: "execute /Users/example/model-dx-pristine-stacked-prompt.md",
    status: "active",
    startedAt: 1790441584645,
    updatedAt: 1790446668702,
    iteration: 0,
    tokensUsed: 61672003,
    timeUsedSeconds: 5084.056999999998,
    baselineTokens: 0,
    activeStartedAt: 1790446668702,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
  },
};
const BLOCKED_0548 = { goal: { ...ACTIVE_0548.goal, status: "blocked", iteration: 1, activeStartedAt: undefined } };

function branch(...entries: Array<{ customType: string; data: unknown }>) {
  return {
    sessionManager: {
      getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })),
    },
  };
}

function goal(overrides: Partial<ActiveGoal> = {}): ActiveGoal {
  return {
    id: "goal-1",
    text: "ship it",
    status: "active",
    startedAt: 1,
    updatedAt: 2,
    iteration: 0,
    timeUsedSeconds: 10,
    toolFreeRuns: 0,
    ...overrides,
  };
}

test("persistence keeps the single-goal shape", () => {
  const stored = goal();
  assert.deepEqual(serializeGoalState(stored), { goal: stored });
  assert.deepEqual(serializeGoalState(undefined), { goal: null });
});

test("the latest goal-state entry wins, including an explicit clear", () => {
  const first = goal({ id: "first" });
  const second = goal({ id: "second" });
  assert.equal(
    loadGoalStateFromSession(
      branch({ customType: "goal-state", data: { goal: first } }, { customType: "goal-state", data: { goal: second } }),
    )?.id,
    "second",
  );
  assert.equal(
    loadGoalStateFromSession(
      branch({ customType: "goal-state", data: { goal: first } }, { customType: "goal-state", data: { goal: null } }),
    ),
    undefined,
  );
});

test("goal-state entries written by pi-goal 0.54.8 restore without their removed fields", () => {
  const restored = loadGoalStateFromSession(branch({ customType: "goal-state", data: ACTIVE_0548 }));
  assert.equal(restored?.id, ACTIVE_0548.goal.id);
  assert.equal(restored?.text, ACTIVE_0548.goal.text);
  assert.equal(restored?.status, "active");
  assert.equal(restored?.timeUsedSeconds, ACTIVE_0548.goal.timeUsedSeconds);
  assert.equal(restored?.toolFreeRuns, 0);
  for (const removed of ["tokensUsed", "baselineTokens", "automaticModelTurns", "toolFreeRepeatCount", "tokenBudget"]) {
    assert.equal(Object.hasOwn(restored ?? {}, removed), false, removed);
  }
  assert.equal(loadGoalStateFromSession(branch({ customType: "goal-state", data: BLOCKED_0548 }))?.status, "blocked");
});

test("a budget-limited goal from 0.54.8 comes back paused", () => {
  const restored = loadGoalStateFromSession(
    branch({ customType: "goal-state", data: { goal: { ...ACTIVE_0548.goal, status: "budget_limited", tokenBudget: 1000 } } }),
  );
  assert.equal(restored?.status, "paused");
});

test("complete goals are not restored", () => {
  assert.equal(
    loadGoalStateFromSession(branch({ customType: "goal-state", data: { goal: goal({ status: "complete" }) } })),
    undefined,
  );
});

test("valid waiting state restores with a stopped clock; malformed waiting is dropped", () => {
  const waiting = loadGoalStateFromSession(
    branch({ customType: "goal-state", data: { goal: goal({ waiting: { reason: "CI", resumeAt: 5_000 } }) } }),
  );
  assert.deepEqual(waiting?.waiting, { reason: "CI", resumeAt: 5_000 });
  assert.equal(waiting?.activeStartedAt, undefined);

  const malformed = loadGoalStateFromSession(
    branch({ customType: "goal-state", data: { goal: { ...goal(), waiting: { reason: "", resumeAt: "soon" } } } }),
  );
  assert.equal(malformed?.waiting, undefined);
  assert.equal(typeof malformed?.activeStartedAt, "number");
});

test("malformed goal-state fails closed", () => {
  for (const data of [
    null,
    { goal: "nope" },
    { goal: { ...goal(), id: "" } },
    { goal: { ...goal(), text: "   " } },
    { goal: { ...goal(), status: "queued" } },
    { goal: { ...goal(), text: "x".repeat(4_001) } },
  ]) {
    assert.equal(loadGoalStateFromSession(branch({ customType: "goal-state", data })), undefined);
  }
});

test("older plural goals-state entries are ignored", () => {
  assert.equal(
    loadGoalStateFromSession(branch({ customType: "goals-state", data: { goals: [goal()] } })),
    undefined,
  );
});
