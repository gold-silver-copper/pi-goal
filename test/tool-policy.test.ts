import assert from "node:assert/strict";
import { test } from "vitest";
import { assertGoalToolsAvailable, goalToolsAvailable } from "../src/tool-policy.js";
import { createMockPi } from "./support/pi-mock.js";

test("Goal tool availability requires goal_complete without mutating the active set", () => {
  const mock = createMockPi({ activeTools: ["read", "goal_complete"] });
  let activeToolWrites = 0;
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (tools) => {
    activeToolWrites += 1;
    setActiveTools(tools);
  };

  assert.equal(goalToolsAvailable(mock.pi), true);
  assert.doesNotThrow(() => assertGoalToolsAvailable(mock.pi));
  assert.equal(activeToolWrites, 0);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "goal_complete"]);
});

test("Goal tool availability rejects a restrictive policy without widening it", () => {
  const mock = createMockPi({ activeTools: ["read", "goal_blocked"] });
  let activeToolWrites = 0;
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (tools) => {
    activeToolWrites += 1;
    setActiveTools(tools);
  };

  assert.equal(goalToolsAvailable(mock.pi), false);
  assert.throws(() => assertGoalToolsAvailable(mock.pi), /goal_complete is unavailable/u);
  assert.equal(activeToolWrites, 0);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "goal_blocked"]);
});
