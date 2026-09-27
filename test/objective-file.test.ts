import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, test } from "vitest";
import { refreshObjectiveFile, resolveObjectiveFile } from "../src/objective-file.js";
import { lastGoal, requireLastGoal, startGoalForTest } from "./support/goal-fixture.js";

const workspace = mkdtempSync(join(tmpdir(), "pi-goal-objective-"));
mkdirSync(join(workspace, "docs"));
const promptPath = join(workspace, "docs", "prompt.md");
writeFileSync(promptPath, "# Do the thing\n");
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

test("a single existing path, optionally after execute, is a file objective", () => {
  for (const objective of [
    promptPath,
    "docs/prompt.md",
    "execute docs/prompt.md",
    "Execute   docs/prompt.md",
    `execute ${promptPath}.`,
    "execute docs/prompt.md:",
    '"docs/prompt.md"',
  ]) {
    const file = resolveObjectiveFile(objective, workspace);
    assert.equal(file?.path, promptPath, objective);
    assert.match(file?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  }
  const fromHome = relative(homedir(), promptPath);
  if (!fromHome.startsWith("..")) assert.equal(resolveObjectiveFile(`~/${fromHome}`, "/")?.path, promptPath);
});

test("inline objectives, missing files and directories are not file objectives", () => {
  for (const objective of [
    "execute docs/prompt.md in a new worktree",
    "fix the flaky test",
    "docs/missing.md",
    "docs",
    "execute",
  ]) {
    assert.equal(resolveObjectiveFile(objective, workspace), undefined, objective);
  }
});

test("refreshing notices a changed file and returns the same record otherwise", () => {
  const path = join(workspace, "refresh.md");
  writeFileSync(path, "one");
  const file = resolveObjectiveFile(path, workspace);
  assert.ok(file);
  assert.equal(refreshObjectiveFile(file), file);
  writeFileSync(path, "two");
  const changed = refreshObjectiveFile(file);
  assert.equal(changed.changed, true);
  assert.equal(refreshObjectiveFile(changed), changed);
  writeFileSync(path, "one");
  assert.equal(refreshObjectiveFile(changed).changed, undefined);
});

test("a file goal's contract names the file and says when it changed", async () => {
  const path = join(workspace, "goal-prompt.md");
  writeFileSync(path, "version one");
  const started = await startGoalForTest({ cwd: workspace }, "execute goal-prompt.md");
  const goal = requireLastGoal(started.mock) as { objectiveFile?: { path: string; sha256: string } };
  assert.equal(goal.objectiveFile?.path, path);

  const kickoff = started.mock.sentUserMessages[0]?.text ?? "";
  const fileLine = `The objective is the file \`${path}\`. Read it in full before starting and after every compaction.`;
  assert.ok(kickoff.includes(fileLine), kickoff);
  assert.match(kickoff, /<goal_objective>\nexecute goal-prompt\.md\n<\/goal_objective>/u);

  const contract = () =>
    (
      started.mock.events.get("before_agent_start")?.[0]?.({ prompt: "next", systemPrompt: "base" }, started.ctx) as
        | { message?: { content?: string } }
        | undefined
    )?.message?.content ?? "";
  const first = contract();
  assert.ok(first.includes(fileLine));
  assert.doesNotMatch(first, /has changed since the goal started/u);

  writeFileSync(path, "version two");
  const second = contract();
  assert.match(second, /The file has changed since the goal started; follow its current contents\./u);
  assert.equal((lastGoal(started.mock) as { objectiveFile?: { changed?: boolean } }).objectiveFile?.changed, true);
});

test("inline objectives keep working without a file", async () => {
  const started = await startGoalForTest({ cwd: workspace }, "fix the flaky test");
  const goal = requireLastGoal(started.mock) as { objectiveFile?: unknown };
  assert.equal(goal.objectiveFile, undefined);
  assert.doesNotMatch(started.mock.sentUserMessages[0]?.text ?? "", /The objective is the file/u);
});
