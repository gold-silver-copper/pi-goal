import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import goal from "../../src/goal.js";
import { restoreGoalState } from "../../src/persistence.js";
import { DEFAULT_SETTINGS_PATH } from "../support/goal-fixture.js";
import { createMockContext, createMockPi } from "../support/pi-mock.js";

// Opt-in: replays real pi sessions (pi-goal 0.54.8 and this fork) through restore and
// session_start. PI_GOAL_SESSIONS_DIR=~/.pi/agent/sessions npm run fuzz:replay
const SESSIONS_DIR = process.env.PI_GOAL_SESSIONS_DIR;

type Entry = Record<string, unknown>;

function sessionFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sessionFiles(path);
    return name.endsWith(".jsonl") ? [path] : [];
  });
}

function readEntries(path: string): Entry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Entry];
      } catch {
        return [];
      }
    });
}

const storedGoal = (entry: Entry) => (entry.data as { goal?: Record<string, unknown> | null } | undefined)?.goal;
const isGoalState = (entry: Entry) => entry.type === "custom" && entry.customType === "goal-state";

test.skipIf(!SESSIONS_DIR)("real sessions restore consistently", { timeout: 600_000 }, async () => {
  const stats = { files: 0, goalFiles: 0, checkpoints: 0, restoredGoals: 0, escBlockedToPaused: 0, blockedKept: 0 };
  for (const file of sessionFiles(SESSIONS_DIR ?? "")) {
    const entries = readEntries(file);
    stats.files += 1;
    const goalStateIndexes = entries.flatMap((entry, index) => (isGoalState(entry) ? [index] : []));
    if (goalStateIndexes.length === 0) continue;
    stats.goalFiles += 1;

    // Restore at every status change and at the end.
    let previousStatus: unknown;
    for (const [n, index] of goalStateIndexes.entries()) {
      const raw = storedGoal(entries[index] as Entry);
      const status = raw?.status;
      if (status === previousStatus && n !== goalStateIndexes.length - 1) continue;
      previousStatus = status;
      stats.checkpoints += 1;
      const prefix = entries.slice(0, index + 1);
      const { goal: restored } = restoreGoalState({ sessionManager: { getBranch: () => prefix as never } });
      const where = `${file} entry ${index} (${String(status)})`;
      if (!raw || status === "complete") {
        assert.equal(restored, undefined, where);
        continue;
      }
      assert.ok(restored, `nothing restored at ${where}`);
      assert.equal(restored.id, raw.id, where);
      if (status === "budget_limited") assert.equal(restored.status, "paused", where);
      else if (restored.status !== status) {
        assert.ok(status === "blocked" || status === "paused", where);
        assert.equal(restored.status, "paused", where);
        assert.equal(restored.pauseReason, "interrupted", where);
      }
      if (status === "blocked" && restored.status === "paused") stats.escBlockedToPaused += 1;
      if (status === "blocked" && restored.status === "blocked") stats.blockedKept += 1;
    }

    // Restore the whole session into the real extension.
    const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked", "goal_wait", "goal_progress", "goal_resume"] });
    const runtime = goal(mock.pi, { settingsPath: DEFAULT_SETTINGS_PATH, notifier: () => undefined });
    const branch: Entry[] = [...entries];
    const { ctx } = createMockContext({ mode: "tui", hasUI: true, sessionManager: { getBranch: () => branch, getEntries: () => branch } });
    for (const handler of mock.events.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
    const expected = restoreGoalState({ sessionManager: { getBranch: () => entries as never } }).goal;
    assert.equal(runtime.activeGoal?.id, expected?.id, file);
    assert.equal(runtime.activeGoal?.status, expected?.status, file);
    if (expected) stats.restoredGoals += 1;
    for (const handler of mock.events.get("context") ?? []) {
      await handler({ messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }] }, ctx);
    }
    await mock.commands.get("goal")?.handler("status", ctx);
    for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
  }
  console.log(`replayed ${JSON.stringify(stats)}`);
  assert.ok(stats.goalFiles > 0);
});
