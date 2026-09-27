import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { DEFAULT_GOAL_SETTINGS, readGoalSettings } from "../src/settings.js";

const directory = mkdtempSync(join(tmpdir(), "pi-goal-settings-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function settingsFile(name: string, contents: string) {
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

test("a missing settings file uses the defaults without warnings", () => {
  assert.deepEqual(readGoalSettings(join(directory, "missing.json")), {
    settings: DEFAULT_GOAL_SETTINGS,
    warnings: [],
  });
  assert.deepEqual(DEFAULT_GOAL_SETTINGS, { checkpointMinutes: 120, maxActiveHours: null, notifications: true });
});

test("valid settings are read as written", () => {
  const path = settingsFile("valid.json", '{"checkpointMinutes":30,"maxActiveHours":8,"notifications":false}');
  assert.deepEqual(readGoalSettings(path), {
    settings: { checkpointMinutes: 30, maxActiveHours: 8, notifications: false },
    warnings: [],
  });
  const off = settingsFile("off.json", '{"checkpointMinutes":null,"maxActiveHours":null}');
  assert.equal(readGoalSettings(off).settings.checkpointMinutes, null);
});

test("unknown keys are ignored with one warning naming them", () => {
  const path = settingsFile("legacy.json", '{"continuationLimits":{"automaticTurns":1000},"rpc":{"enabled":false},"notifications":false}');
  const loaded = readGoalSettings(path);
  assert.equal(loaded.settings.notifications, false);
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0] ?? "", /ignoring unknown settings continuationLimits, rpc/u);
});

test("invalid values fall back to the default with a warning each", () => {
  const path = settingsFile("invalid.json", '{"checkpointMinutes":0,"maxActiveHours":"8","notifications":"yes"}');
  const loaded = readGoalSettings(path);
  assert.deepEqual(loaded.settings, DEFAULT_GOAL_SETTINGS);
  assert.equal(loaded.warnings.length, 3);
});

test("malformed JSON and non-object documents use the defaults with a warning", () => {
  for (const [name, contents] of [
    ["broken.json", "{"],
    ["array.json", "[]"],
  ] as const) {
    const loaded = readGoalSettings(settingsFile(name, contents));
    assert.deepEqual(loaded.settings, DEFAULT_GOAL_SETTINGS);
    assert.equal(loaded.warnings.length, 1);
  }
});
