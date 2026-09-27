import assert from "node:assert/strict";
import fc from "fast-check";
import { afterEach, test, vi } from "vitest";
import goal from "../../src/goal.js";
import { goalContractFor } from "../../src/goal-contract.js";
import { type ActiveGoal, restoreGoalState } from "../../src/persistence.js";
import { DEFAULT_SETTINGS_PATH } from "../support/goal-fixture.js";
import { createMockContext, createMockPi } from "../support/pi-mock.js";

// Random sequences of pi events, /goal commands and goal tool calls against the real
// extension, with invariants checked after every step. FUZZ_RUNS scales the run count.
const RUNS = Number(process.env.FUZZ_RUNS ?? 150);
const MAX_ACTIONS = Number(process.env.FUZZ_ACTIONS ?? 60);
const GOAL_TOOLS = ["goal_complete", "goal_blocked", "goal_wait", "goal_progress", "goal_resume"];
const ABORT_PID = 2_147_483_646; // no such process: a pid wake fires at once
const LIVE_PID = process.pid; // this process: a pid wake never fires

const objectiveArb = fc.oneof(
  fc.constantFrom("ship the release", "execute docs/prompt.md", "fix the flaky test", "resume the audit", "status report"),
  fc.string({ minLength: 1, maxLength: 30 }),
  fc.string({ minLength: 200, maxLength: 260 }),
);
const errorArb = fc.constantFrom(
  "This operation was aborted",
  "Operation aborted",
  "HTTP 429: Too Many Requests",
  "Claude rate limit (five_hour) — resets 1:10:00 AM: You've hit your session limit · resets 1:10am (America/Los_Angeles)",
  "You have hit your ChatGPT usage limit. Please try again in 3 hours.",
  "Provider account is out of credits",
  "Prompt is too long",
  "context_length_exceeded",
  "Permission denied by remote service",
  "WebSocket closed 1012",
);
const idModeArb = fc.constantFrom("current", "current", "current", "stale", "missing");

type Action =
  | { k: "start"; objective: string; force: boolean }
  | { k: "edit"; objective: string }
  | { k: "cmd"; name: "pause" | "resume" | "clear" | "status" }
  | { k: "user"; text: string }
  | { k: "ext"; text: string }
  | { k: "deliver" }
  | { k: "custom" }
  | { k: "tool" }
  | { k: "goalTool"; tool: string; idMode: string; wake: "none" | "fires" | "never"; deadline: boolean; note: string }
  | { k: "end"; stop: "stop" | "toolUse" | "aborted" | "error"; error: string; toolCall: boolean }
  | { k: "settled" }
  | { k: "compact"; willRetry: boolean }
  | { k: "time"; ms: number }
  | { k: "policy"; hideGoalTools: boolean }
  | { k: "reload" };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ k: fc.constant("start" as const), objective: objectiveArb, force: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("edit" as const), objective: objectiveArb }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("cmd" as const), name: fc.constantFrom("pause", "resume", "clear", "status") as fc.Arbitrary<"pause" | "resume" | "clear" | "status"> }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("user" as const), text: fc.constantFrom("continue", "go ahead", "what happened?", "status?", "keep going") }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("ext" as const), text: fc.constantFrom("monitor: CI finished", "btw side question") }) },
  { weight: 5, arbitrary: fc.constant({ k: "deliver" as const }) },
  { weight: 1, arbitrary: fc.constant({ k: "custom" as const }) },
  { weight: 3, arbitrary: fc.constant({ k: "tool" as const }) },
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant("goalTool" as const),
      tool: fc.constantFrom(...GOAL_TOOLS),
      idMode: idModeArb,
      wake: fc.constantFrom("none", "fires", "never") as fc.Arbitrary<"none" | "fires" | "never">,
      deadline: fc.boolean(),
      note: fc.string({ minLength: 0, maxLength: 40 }),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant("end" as const),
      stop: fc.constantFrom("stop", "stop", "toolUse", "aborted", "error") as fc.Arbitrary<"stop" | "toolUse" | "aborted" | "error">,
      error: errorArb,
      toolCall: fc.boolean(),
    }),
  },
  { weight: 5, arbitrary: fc.constant({ k: "settled" as const }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("compact" as const), willRetry: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("time" as const), ms: fc.constantFrom(1, 1_000, 11_000, 6 * 60_000, 50 * 60_000, 3 * 3_600_000) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("policy" as const), hideGoalTools: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ k: "reload" as const }) },
);

interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
  content?: unknown;
  details?: unknown;
  message?: unknown;
}

class Harness {
  branch: BranchEntry[] = [];
  queue: string[] = []; // sent, undelivered user messages (goal prompts)
  running = false;
  abortRequested = false;
  hideGoalTools = false;
  aborts = 0;
  continuationsThisStep: string[] = [];
  runStartedThisStep = false;
  mock!: ReturnType<typeof createMockPi>;
  runtime!: ReturnType<typeof goal>;
  ctx!: ReturnType<typeof createMockContext>["ctx"];
  log: string[] = [];

  async boot() {
    this.mock = createMockPi({ activeTools: this.tools() });
    const raw = this.mock.rawPi;
    const append = raw.appendEntry.bind(raw);
    raw.appendEntry = (customType: string, data: unknown) => {
      append(customType, data);
      this.branch.push({ type: "custom", customType, data: structuredClone(data) });
    };
    const send = raw.sendMessage.bind(raw);
    raw.sendMessage = (message: unknown, options?: unknown) => {
      send(message, options);
      this.recordCustomMessage(message);
    };
    const sendUser = raw.sendUserMessage.bind(raw);
    raw.sendUserMessage = (text: string, options?: unknown) => {
      sendUser(text, options);
      this.queue.push(text);
      if (text.includes("pi-goal-continuation:")) this.continuationsThisStep.push(text);
    };
    this.runtime = goal(this.mock.pi, {
      settingsPath: DEFAULT_SETTINGS_PATH,
      notifier: () => undefined,
      wakeTiming: { pidIntervalMs: 1_000, commandSecondMs: 1_000, commandTimeoutMs: 1_000 },
    });
    this.ctx = createMockContext({
      mode: "tui",
      hasUI: true,
      cwd: process.cwd(),
      isIdle: () => !this.running,
      hasPendingMessages: () => this.queue.length > 0,
      abort: () => {
        this.aborts += 1;
        if (this.running) this.abortRequested = true;
      },
      sessionManager: { getBranch: () => this.branch, getEntries: () => this.branch },
    }).ctx;
    await this.emit("session_start", { reason: "startup" });
  }

  tools() {
    return this.hideGoalTools ? ["read", "bash"] : ["read", "bash", ...GOAL_TOOLS];
  }

  recordCustomMessage(message: unknown) {
    const m = message as { customType?: string; content?: unknown; details?: unknown };
    this.branch.push({ type: "custom_message", customType: m.customType, content: m.content, details: m.details });
  }

  async emit(name: string, event: unknown) {
    let result: unknown;
    for (const handler of this.mock.events.get(name) ?? []) result = await handler(event, this.ctx);
    return result;
  }

  async startRun(text: string, source: "interactive" | "extension") {
    const inputResult = (await this.emit("input", { source, text })) as { action?: string } | undefined;
    if (inputResult?.action === "handled") return;
    this.running = true;
    this.runStartedThisStep = true;
    this.abortRequested = false;
    const boundary = (await this.emit("before_agent_start", { prompt: text, systemPrompt: "base" })) as
      | { message?: unknown }
      | undefined;
    if (boundary?.message) this.recordCustomMessage(boundary.message);
    await this.emit("agent_start", {});
    const message = { role: "user", content: [{ type: "text", text }] };
    await this.emit("message_start", { message });
    this.branch.push({ type: "message", message });
  }

  assistant(toolCall: boolean, stopReason: string, errorMessage?: string) {
    const content = toolCall ? [{ type: "toolCall", id: "call", name: "bash", arguments: {} }] : [{ type: "text", text: "ok" }];
    return { role: "assistant", stopReason, content, ...(errorMessage ? { errorMessage } : {}) };
  }

  currentId() {
    return this.runtime.activeGoal?.id ?? "no-goal";
  }

  async step(action: Action) {
    this.continuationsThisStep = [];
    this.runStartedThisStep = false;
    const before = this.runtime.activeGoal ? structuredClone(this.runtime.activeGoal) : undefined;
    const directInputBefore = this.runtime.directUserInput;
    switch (action.k) {
      case "start":
        await this.mock.commands.get("goal")?.handler(`${action.force ? "--force " : ""}${action.objective}`, this.ctx);
        break;
      case "edit":
        await this.mock.commands.get("goal")?.handler(`edit ${action.objective}`, this.ctx);
        break;
      case "cmd":
        await this.mock.commands.get("goal")?.handler(action.name, this.ctx);
        break;
      case "user":
        if (this.running) {
          await this.emit("input", { source: "interactive", text: action.text, streamingBehavior: "steer" });
          await this.emit("message_start", { message: { role: "user", content: [{ type: "text", text: action.text }] } });
        } else {
          await this.startRun(action.text, "interactive");
        }
        break;
      case "ext":
        if (this.running) await this.emit("input", { source: "extension", text: action.text, streamingBehavior: "followUp" });
        else await this.startRun(action.text, "extension");
        break;
      case "deliver": {
        if (this.running) break;
        const text = this.queue.shift();
        if (text !== undefined) await this.startRun(text, "extension");
        break;
      }
      case "custom":
        await this.emit("message_start", { message: { role: "custom", customType: "other-extension", content: "hi" } });
        break;
      case "tool": {
        if (!this.running) break;
        const call = { toolName: "bash", toolCallId: "call", input: {} };
        this.branch.push({ type: "message", message: this.assistant(true, "toolUse") });
        const blocked = (await this.emit("tool_call", call)) as { block?: boolean } | undefined;
        if (!blocked?.block) {
          await this.emit("tool_execution_end", call);
          await this.emit("tool_result", { type: "tool_result", ...call, content: [{ type: "text", text: "ok" }], isError: false });
        }
        await this.emit("turn_end", { message: this.assistant(true, "toolUse"), toolResults: [] });
        break;
      }
      case "goalTool":
        await this.callGoalTool(action, before, directInputBefore);
        break;
      case "end": {
        if (!this.running) break;
        const stop = this.abortRequested ? "aborted" : action.stop;
        const assistant = this.assistant(action.toolCall, stop, stop === "error" || stop === "aborted" ? action.error : undefined);
        await this.emit("turn_end", { message: assistant, toolResults: [] });
        this.branch.push({ type: "message", message: assistant });
        this.running = false;
        this.abortRequested = false;
        await this.emit("agent_end", { messages: [assistant] });
        break;
      }
      case "settled":
        if (!this.running) await this.emit("agent_settled", {});
        break;
      case "compact":
        if (this.running) break;
        await this.emit("session_before_compact", { reason: "manual", willRetry: action.willRetry });
        this.branch.push({ type: "compaction", summary: "summary" } as BranchEntry);
        await this.emit("session_compact", { reason: "manual", willRetry: action.willRetry });
        break;
      case "time":
        await vi.advanceTimersByTimeAsync(action.ms);
        break;
      case "policy":
        this.hideGoalTools = action.hideGoalTools;
        this.mock.rawPi.setActiveTools(this.tools());
        break;
      case "reload":
        if (this.running) break;
        await this.emit("session_shutdown", {});
        this.queue = [];
        await this.boot();
        break;
    }
    this.checkInvariants(action);
  }

  async callGoalTool(
    action: Extract<Action, { k: "goalTool" }>,
    before: ActiveGoal | undefined,
    directInputBefore: boolean,
  ) {
    if (!this.running || this.hideGoalTools) return;
    const goalId = action.idMode === "current" ? this.currentId() : action.idMode === "stale" ? "stale-goal-id" : "";
    const params: Record<string, unknown> = { goal_id: goalId };
    if (action.tool === "goal_complete") Object.assign(params, { summary: "done and verified", deviations: action.note || undefined });
    if (action.tool === "goal_blocked") Object.assign(params, { reason: "needs a token", evidence: "401" });
    if (action.tool === "goal_progress") Object.assign(params, { note: action.note });
    if (action.tool === "goal_wait") {
      Object.assign(params, { reason: "waiting for CI" });
      if (action.deadline) params.resume_after_ms = 60_000;
      if (action.wake !== "none") params.wake_when = { pid: action.wake === "fires" ? ABORT_PID : LIVE_PID };
    }
    this.branch.push({ type: "message", message: this.assistant(true, "toolUse") });
    const tool = this.mock.tools.find((candidate) => candidate.name === action.tool) as
      | { execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; terminate?: boolean }> }
      | undefined;
    assert.ok(tool, action.tool);
    const result = await tool.execute("call", params, new AbortController().signal, () => undefined, this.ctx);
    const text = result.content?.[0]?.text ?? "";
    const rejected = /rejected/u.test(text);
    this.log.push(`${action.tool}(${action.idMode}) -> ${text.slice(0, 60)}`);
    const idOk = action.idMode === "current" && before !== undefined;
    if (!idOk) assert.ok(rejected, `${action.tool} with a ${action.idMode} id must be rejected: ${text}`);
    if (!rejected) {
      if (action.tool === "goal_resume") {
        assert.ok(before?.status === "paused" || before?.status === "blocked", `resumed a ${before?.status} goal`);
        assert.ok(directInputBefore, "goal_resume accepted without direct user input");
      } else if (action.tool === "goal_wait") {
        assert.ok(before?.status === "active" && !before.waiting, "goal_wait accepted while not actively working");
      } else {
        assert.equal(before?.status, "active", `${action.tool} accepted for a ${before?.status} goal`);
      }
      if (action.tool === "goal_complete") assert.equal(this.runtime.activeGoal, undefined);
    }
    // A terminal tool result ends the turn; mirror pi's turn boundary.
    await this.emit("turn_end", { message: this.assistant(true, "toolUse"), toolResults: [] });
  }

  checkInvariants(action: Action) {
    const live = this.runtime.activeGoal;
    // Continuations: at most one per step, only for the live, active, non-waiting goal.
    assert.ok(this.continuationsThisStep.length <= 1, `${this.continuationsThisStep.length} continuations in one step`);
    for (const prompt of this.continuationsThisStep) {
      const markerGoal = /pi-goal-continuation:([^:]+):/u.exec(prompt)?.[1];
      assert.ok(live && live.status === "active" && !live.waiting, `continuation sent for a ${live?.status ?? "missing"} goal`);
      assert.equal(markerGoal, live.id);
    }
    assert.ok(this.queue.filter((text) => text.includes("pi-goal-continuation:")).length <= 1, "two queued continuations");

    // State consistency.
    if (live) {
      assert.ok(!live.waiting || live.status === "active", "waiting while stopped");
      assert.equal(live.pauseReason !== undefined, live.status === "paused", `pauseReason ${live.pauseReason} with status ${live.status}`);
      if (live.status === "active") assert.ok(live.toolFreeRuns < 3, `active with ${live.toolFreeRuns} tool-free runs`);
      assert.notEqual(live.status, "complete", "a complete goal stays live");
    }

    // What the session holds restores to the live goal.
    const { goal: restored } = restoreGoalState({ sessionManager: { getBranch: () => this.branch as never } });
    const significant = (g: ActiveGoal | undefined) =>
      g && {
        id: g.id,
        text: g.text,
        status: g.status,
        pauseReason: g.pauseReason,
        stopDetail: g.stopDetail,
        waiting: g.waiting,
        toolFreeRuns: g.toolFreeRuns,
        notes: g.progress?.length ?? 0,
      };
    assert.deepEqual(significant(restored), significant(live), `restore differs after ${action.k}`);

    // A run starts with the contract for the current state.
    if (this.runStartedThisStep && this.running && !this.abortRequested) {
      const latest = [...this.branch].reverse().find((entry) => entry.type === "custom_message" && entry.customType === "goal-contract");
      const expected = goalContractFor(this.runtime.activeGoal);
      if (latest || expected.details.state !== "inactive") {
        assert.equal((latest?.details as { state?: string } | undefined)?.state, expected.details.state, "stale contract at run start");
        assert.equal(latest?.content, expected.content, "contract text differs at run start");
      }
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
});

test("random lifecycles keep Goal invariants", { timeout: Math.max(20_000, RUNS * 400) }, async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: MAX_ACTIONS }), async (actions) => {
      vi.useFakeTimers({ now: Date.parse("2026-09-25T07:36:32Z") });
      const harness = new Harness();
      try {
        await harness.boot();
        for (const [index, action] of actions.entries()) {
          try {
            await harness.step(action);
          } catch (error) {
            throw new Error(
              `step ${index} ${JSON.stringify(action)} failed: ${(error as Error).message}\nstatus=${JSON.stringify(harness.runtime.activeGoal)}\nlog:\n${harness.log.slice(-8).join("\n")}`,
            );
          }
        }
      } finally {
        await harness.emit("session_shutdown", {}).catch(() => undefined);
        vi.useRealTimers();
      }
    }),
    { numRuns: RUNS, ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}) },
  );
});
