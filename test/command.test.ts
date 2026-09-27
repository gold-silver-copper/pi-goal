import assert from "node:assert/strict";
import { test } from "vitest";
import { completeGoalArguments, parseCommand, validateObjective } from "../src/command.js";

test("command parsing routes subcommands and treats other text as an objective", () => {
  assert.deepEqual(parseCommand(""), { kind: "show" });
  assert.deepEqual(parseCommand("status"), { kind: "show" });
  assert.deepEqual(parseCommand("pause"), { kind: "pause" });
  assert.deepEqual(parseCommand("resume"), { kind: "resume" });
  assert.deepEqual(parseCommand("stop"), { kind: "clear" });
  assert.deepEqual(parseCommand("clear"), { kind: "clear" });
  assert.deepEqual(parseCommand("edit ship it"), { kind: "edit", objective: "ship it" });
  assert.deepEqual(parseCommand("execute docs/prompt.md"), { kind: "start", objective: "execute docs/prompt.md" });
  assert.deepEqual(parseCommand("--force fix it"), { kind: "start", objective: "fix it", force: true });
  assert.equal(parseCommand("status now"), "Usage: /goal status");
  assert.equal(parseCommand("edit"), "Usage: /goal edit <objective>");
  assert.equal(parseCommand("--force"), "Usage: /goal --force <objective>");
});

test("removed token budgets are ordinary objective text", () => {
  assert.deepEqual(parseCommand("--tokens 10k ship"), { kind: "start", objective: "--tokens 10k ship" });
});

test("completions list only the subcommands", () => {
  assert.deepEqual(
    completeGoalArguments("")?.map((item) => item.value),
    ["status", "pause", "resume", "edit", "clear"],
  );
  assert.deepEqual(
    completeGoalArguments("re")?.map((item) => item.value),
    ["resume"],
  );
  assert.equal(completeGoalArguments("edit "), null);
});

test("objectives are required and bounded", () => {
  assert.equal(validateObjective("  "), "Usage: /goal <objective>");
  assert.match(validateObjective("x".repeat(4_001)) ?? "", /too long/u);
  assert.equal(validateObjective("x".repeat(4_000)), undefined);
});
