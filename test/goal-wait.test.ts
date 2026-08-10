import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createGoal, GoalRuntime } from "../src/runtime.js";
import {
	lastGoal,
	requireGoalTool,
	requireLastGoal,
	restoreStoredGoalForTest,
	settingsPath,
	startGoalForTest,
} from "./support/goal-fixture.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

test("goal_wait keeps an active goal quiet across agent_end and repeated settlement", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	const waitTool = requireGoalTool(waiting.mock, "goal_wait");

	const result = await waitTool.execute(
		"wait-1",
		{ goal_id: goal.id, reason: "Waiting for the review monitor" },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);

	assert.equal(result.terminate, true);
	assert.match(result.content?.[0]?.text ?? "", /goal waiting/i);
	assert.equal(lastGoal(waiting.mock)?.status, "active");
	assert.deepEqual((lastGoal(waiting.mock) as { waiting?: unknown } | null)?.waiting, {
		reason: "Waiting for the review monitor",
	});
	assert.match(waiting.statuses.get("goal") ?? "", /waiting.*review monitor/i);

	const ownedKickoff = waiting.mock.sentUserMessages[0]?.text ?? "";
	waiting.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: ownedKickoff, streamingBehavior: "followUp" },
		waiting.ctx,
	);
	assert.deepEqual((lastGoal(waiting.mock) as { waiting?: unknown } | null)?.waiting, {
		reason: "Waiting for the review monitor",
	});

	await waiting.mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", name: "goal_wait", arguments: {} }],
				},
			],
		},
		waiting.ctx,
	);
	await waiting.mock.events.get("agent_settled")?.[0]?.({}, waiting.ctx);
	await waiting.mock.events.get("agent_settled")?.[0]?.({}, waiting.ctx);

	assert.equal(waiting.mock.sentUserMessages.length, 1);
	assert.deepEqual((lastGoal(waiting.mock) as { waiting?: unknown } | null)?.waiting, {
		reason: "Waiting for the review monitor",
	});
});

test("an external message quoting an owned prompt still wakes the goal and supersedes that prompt", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-quoted",
		{ goal_id: goal.id, reason: "Waiting for quoted output" },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	const ownedKickoff = waiting.mock.sentUserMessages[0]?.text ?? "";
	waiting.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: ownedKickoff, streamingBehavior: "followUp" },
		waiting.ctx,
	);
	assert.ok(requireLastGoal(waiting.mock).waiting);
	const externalMessage = `${ownedKickoff}\n\nExternal monitor result: approved`;

	waiting.mock.events.get("input")?.[0]?.(
		{ source: "extension", text: externalMessage, streamingBehavior: "followUp" },
		waiting.ctx,
	);
	assert.equal(requireLastGoal(waiting.mock).waiting, undefined);
	const startResult = waiting.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: externalMessage, systemPrompt: "base" },
		waiting.ctx,
	);
	assert.match(
		(startResult as { systemPrompt?: string } | undefined)?.systemPrompt ?? "",
		/Active \/goal/i,
	);
	assert.deepEqual(
		waiting.mock.events.get("input")?.[0]?.(
			{ source: "extension", text: ownedKickoff, streamingBehavior: "followUp" },
			waiting.ctx,
		),
		{ action: "handled" },
	);
});

test("a custom follow-up quoting an owned prompt wakes without an input event", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-custom-quoted",
		{ goal_id: goal.id, reason: "Waiting for custom quoted output" },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	const ownedKickoff = waiting.mock.sentUserMessages[0]?.text ?? "";
	const customPrompt = `${ownedKickoff}\n\nCustom monitor result: approved`;

	const startResult = waiting.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: customPrompt, systemPrompt: "base" },
		waiting.ctx,
	);
	assert.equal(requireLastGoal(waiting.mock).waiting, undefined);
	assert.match(
		(startResult as { systemPrompt?: string } | undefined)?.systemPrompt ?? "",
		/Active \/goal/i,
	);
	assert.deepEqual(
		waiting.mock.events.get("input")?.[0]?.(
			{ source: "extension", text: ownedKickoff, streamingBehavior: "followUp" },
			waiting.ctx,
		),
		{ action: "handled" },
	);
});

test("manual compaction preserves a quiet wait without scheduling continuation", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-compact",
		{ goal_id: goal.id, reason: "Waiting across compaction" },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);

	await waiting.mock.events.get("session_before_compact")?.[0]?.({}, waiting.ctx);
	await waiting.mock.events.get("session_compact")?.[0]?.(
		{ reason: "manual", willRetry: false },
		waiting.ctx,
	);
	await vi.runOnlyPendingTimersAsync();
	await waiting.mock.events.get("agent_settled")?.[0]?.({}, waiting.ctx);

	assert.equal(waiting.mock.sentUserMessages.length, 1);
	assert.equal(requireLastGoal(waiting.mock).waiting?.reason, "Waiting across compaction");
});

test("non-goal extension input wakes a waiting goal and restores normal continuation", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-2",
		{ goal_id: goal.id, reason: "Waiting for CI" },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	await waiting.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "toolUse" }] },
		waiting.ctx,
	);
	await waiting.mock.events.get("agent_settled")?.[0]?.({}, waiting.ctx);
	assert.equal(waiting.mock.sentUserMessages.length, 1);

	waiting.mock.events.get("input")?.[0]?.(
		{
			source: "extension",
			text: "CI completed",
			streamingBehavior: "followUp",
		},
		waiting.ctx,
	);
	assert.equal((lastGoal(waiting.mock) as { waiting?: unknown } | null)?.waiting, undefined);

	waiting.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "CI completed", systemPrompt: "base" },
		waiting.ctx,
	);
	await waiting.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		waiting.ctx,
	);
	await waiting.mock.events.get("agent_settled")?.[0]?.({}, waiting.ctx);

	assert.equal(waiting.mock.sentUserMessages.length, 2);
	assert.match(waiting.mock.sentUserMessages.at(-1)?.text ?? "", /automatic continuation/i);
});

test("RPC input and custom follow-up boundaries wake waiting goals", async () => {
	const rpc = await startGoalForTest();
	const rpcGoal = requireLastGoal(rpc.mock);
	await requireGoalTool(rpc.mock, "goal_wait").execute(
		"wait-rpc",
		{ goal_id: rpcGoal.id, reason: "Waiting for RPC" },
		new AbortController().signal,
		() => undefined,
		rpc.ctx,
	);
	rpc.mock.events.get("input")?.[0]?.({ source: "rpc", text: "RPC wake" }, rpc.ctx);
	assert.equal(requireLastGoal(rpc.mock).waiting, undefined);

	const custom = await startGoalForTest();
	const customGoal = requireLastGoal(custom.mock);
	await requireGoalTool(custom.mock, "goal_wait").execute(
		"wait-custom",
		{ goal_id: customGoal.id, reason: "Waiting for custom follow-up" },
		new AbortController().signal,
		() => undefined,
		custom.ctx,
	);
	custom.mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "custom wake", systemPrompt: "base" },
		custom.ctx,
	);
	custom.mock.events.get("message_start")?.[0]?.(
		{ message: { role: "custom", content: "custom wake" } },
		custom.ctx,
	);
	assert.equal(requireLastGoal(custom.mock).waiting, undefined);
});

test("user resume clears waiting without rotating the goal or resetting safety", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	goal.automaticModelTurns = 4;
	goal.toolFreeRepeatCount = 2;
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-resume",
		{ goal_id: goal.id, reason: "Waiting for approval" },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);

	await waiting.mock.commands.get("goal")?.handler("status", waiting.ctx);
	assert.ok((lastGoal(waiting.mock) as { waiting?: unknown } | null)?.waiting);
	await waiting.mock.commands.get("goal")?.handler("resume", waiting.ctx);

	const resumed = requireLastGoal(waiting.mock);
	assert.equal(resumed.id, goal.id);
	assert.equal(resumed.waiting, undefined);
	assert.equal(resumed.automaticModelTurns, 4);
	assert.equal(resumed.toolFreeRepeatCount, 2);
	assert.equal(waiting.mock.sentUserMessages.length, 2);
	assert.match(waiting.mock.sentUserMessages.at(-1)?.text ?? "", /resumed.*waiting/is);
});

test("goal_wait validates stale ownership, reason, deadline, and duplicate waits", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	const tool = requireGoalTool(waiting.mock, "goal_wait");
	for (const [params, rejection] of [
		[{ goal_id: "stale", reason: "Wait" }, /goal_id does not match/i],
		[{ goal_id: goal.id, reason: "   " }, /reason is empty/i],
		[{ goal_id: goal.id, reason: "x".repeat(1_001) }, /reason is too long/i],
		[{ goal_id: goal.id, reason: "Wait", resume_after_ms: 0 }, /whole number/i],
		[{ goal_id: goal.id, reason: "Wait", resume_after_ms: 1.5 }, /whole number/i],
		[{ goal_id: goal.id, reason: "Wait", resume_after_ms: 2_147_483_648 }, /whole number/i],
	] as const) {
		const result = await tool.execute(
			"invalid-wait",
			params,
			new AbortController().signal,
			() => undefined,
			waiting.ctx,
		);
		assert.match(result.content?.[0]?.text ?? "", rejection);
		assert.equal((lastGoal(waiting.mock) as { waiting?: unknown } | null)?.waiting, undefined);
	}

	await tool.execute(
		"valid-wait",
		{ goal_id: goal.id, reason: "First wait" },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	const duplicate = await tool.execute(
		"duplicate-wait",
		{ goal_id: goal.id, reason: "Second wait" },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	assert.match(duplicate.content?.[0]?.text ?? "", /already waiting/i);
	assert.equal(requireLastGoal(waiting.mock).waiting?.reason, "First wait");
});

test("goal_wait deadline dispatches exactly one continuation through settled gates", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-3",
		{
			goal_id: goal.id,
			reason: "Waiting for a bounded monitor",
			resume_after_ms: 1_000,
		},
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	await waiting.mock.commands.get("goal")?.handler("status", waiting.ctx);
	assert.match(waiting.notifications.at(-1)?.message ?? "", /Status: waiting/i);
	assert.match(
		waiting.notifications.at(-1)?.message ?? "",
		/Waiting: Waiting for a bounded monitor/i,
	);
	assert.match(
		waiting.notifications.at(-1)?.message ?? "",
		/Resume deadline: 2026-08-10T00:00:01.000Z/i,
	);
	await waiting.mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", stopReason: "toolUse" }] },
		waiting.ctx,
	);
	await waiting.mock.events.get("agent_settled")?.[0]?.({}, waiting.ctx);
	assert.equal(waiting.mock.sentUserMessages.length, 1);

	await vi.advanceTimersByTimeAsync(999);
	assert.equal(waiting.mock.sentUserMessages.length, 1);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(waiting.mock.sentUserMessages.length, 2);
	assert.equal((lastGoal(waiting.mock) as { waiting?: unknown } | null)?.waiting, undefined);

	await waiting.mock.events.get("agent_settled")?.[0]?.({}, waiting.ctx);
	await vi.runOnlyPendingTimersAsync();
	assert.equal(waiting.mock.sentUserMessages.length, 2);
});

test("a failed deadline delivery restores waiting and retries exactly once", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-retry",
		{ goal_id: goal.id, reason: "Waiting for retry", resume_after_ms: 100 },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	const sendUserMessage = waiting.mock.rawPi.sendUserMessage.bind(waiting.mock.rawPi);
	waiting.mock.rawPi.sendUserMessage = () => {
		throw new Error("deadline delivery failed");
	};

	await vi.advanceTimersByTimeAsync(100);
	assert.equal(waiting.mock.sentUserMessages.length, 1);
	assert.equal(requireLastGoal(waiting.mock).waiting?.reason, "Waiting for retry");
	assert.equal(requireLastGoal(waiting.mock).activeStartedAt, undefined);

	waiting.mock.rawPi.sendUserMessage = sendUserMessage;
	await vi.advanceTimersByTimeAsync(999);
	assert.equal(waiting.mock.sentUserMessages.length, 1);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(waiting.mock.sentUserMessages.length, 2);
	assert.equal(requireLastGoal(waiting.mock).waiting, undefined);
	await vi.runOnlyPendingTimersAsync();
	assert.equal(waiting.mock.sentUserMessages.length, 2);
});

test("two failed deadline deliveries leave a visible wait without retry looping", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-retry-exhausted",
		{ goal_id: goal.id, reason: "Waiting after retry failure", resume_after_ms: 100 },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	waiting.mock.rawPi.sendUserMessage = () => {
		throw new Error("deadline delivery failed");
	};

	await vi.advanceTimersByTimeAsync(1_100);
	assert.equal(waiting.mock.sentUserMessages.length, 1);
	assert.equal(requireLastGoal(waiting.mock).waiting?.reason, "Waiting after retry failure");
	await vi.advanceTimersByTimeAsync(10_000);
	await waiting.mock.events.get("agent_settled")?.[0]?.({}, waiting.ctx);
	assert.equal(waiting.mock.sentUserMessages.length, 1);
	assert.ok(requireLastGoal(waiting.mock).waiting);
});

test("a deadline that expires while busy waits for the next settled idle boundary", async () => {
	let idle = false;
	const waiting = await startGoalForTest({ isIdle: () => idle });
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-busy",
		{ goal_id: goal.id, reason: "Waiting while busy", resume_after_ms: 100 },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	await vi.advanceTimersByTimeAsync(100);
	assert.equal(waiting.mock.sentUserMessages.length, 1);
	assert.ok(requireLastGoal(waiting.mock).waiting);

	idle = true;
	await waiting.mock.events.get("agent_settled")?.[0]?.({}, waiting.ctx);
	assert.equal(waiting.mock.sentUserMessages.length, 2);
	assert.equal(requireLastGoal(waiting.mock).waiting, undefined);
});

test("frozen queues and pending transitions cannot dispatch a waiting deadline", async () => {
	for (const state of ["frozen", "pending"] as const) {
		const mock = createMockPi();
		const context = createMockContext();
		const runtime = new GoalRuntime(mock.pi);
		runtime.activeGoal = createGoal(`goal-${state}`, undefined, 0);
		runtime.enterGoalWait(context.ctx, runtime.activeGoal.id, {
			reason: `Waiting while ${state}`,
			resumeAt: Date.now() + 100,
		});
		if (state === "frozen") runtime.queueFrozen = true;
		else {
			runtime.pendingQueueAction = {
				kind: "prioritize",
				objective: "urgent",
			};
		}
		runtime.restoreGoalWaitTimer(context.ctx);
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(mock.sentUserMessages.length, 0);
		assert.ok(runtime.activeGoal.waiting);
		assert.equal(runtime.dispatchDueGoalWait(context.ctx), false);
	}
});

test("shutdown cancels a waiting deadline without discarding persisted waiting state", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-shutdown",
		{ goal_id: goal.id, reason: "Waiting through reload", resume_after_ms: 100 },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	await waiting.mock.events.get("session_shutdown")?.[0]?.({}, waiting.ctx);
	await vi.advanceTimersByTimeAsync(100);

	assert.equal(waiting.mock.sentUserMessages.length, 1);
	assert.equal(lastGoal(waiting.mock)?.waiting?.reason, "Waiting through reload");
});

test("pause, clear, edit, completion, and blocking cancel waiting deadlines", async () => {
	for (const action of ["pause", "clear", "edit", "complete", "block"] as const) {
		const waiting = await startGoalForTest();
		const goal = requireLastGoal(waiting.mock);
		await requireGoalTool(waiting.mock, "goal_wait").execute(
			`wait-${action}`,
			{ goal_id: goal.id, reason: `Waiting before ${action}`, resume_after_ms: 100 },
			new AbortController().signal,
			() => undefined,
			waiting.ctx,
		);

		if (action === "pause" || action === "clear") {
			await waiting.mock.commands.get("goal")?.handler(action, waiting.ctx);
		} else if (action === "edit") {
			await waiting.mock.commands.get("goal")?.handler("edit revised objective", waiting.ctx);
		} else if (action === "complete") {
			await requireGoalTool(waiting.mock, "goal_complete").execute(
				"complete-waiting",
				{ goal_id: goal.id, summary: "The monitored work is complete and verified." },
				new AbortController().signal,
				() => undefined,
				waiting.ctx,
			);
		} else {
			await requireGoalTool(waiting.mock, "goal_blocked").execute(
				"block-waiting",
				{
					goal_id: goal.id,
					reason: "External system permanently rejected access",
					evidence: "The same rejection was verified in three separate goal turns.",
					repeated_turns: 3,
				},
				new AbortController().signal,
				() => undefined,
				waiting.ctx,
			);
		}

		const messagesAfterAction = waiting.mock.sentUserMessages.length;
		assert.equal(lastGoal(waiting.mock)?.waiting, undefined, action);
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(waiting.mock.sentUserMessages.length, messagesAfterAction, action);
	}
});

test("failed edit and replacement delivery restore the exact waiting goal and deadline", async () => {
	for (const command of ["edit revised objective", "replacement objective"] as const) {
		const waiting = await startGoalForTest();
		const goal = requireLastGoal(waiting.mock);
		await requireGoalTool(waiting.mock, "goal_wait").execute(
			"wait-rollback",
			{ goal_id: goal.id, reason: "Waiting before failed delivery", resume_after_ms: 100 },
			new AbortController().signal,
			() => undefined,
			waiting.ctx,
		);
		const sendUserMessage = waiting.mock.rawPi.sendUserMessage.bind(waiting.mock.rawPi);
		waiting.mock.rawPi.sendUserMessage = () => {
			throw new Error("delivery failed");
		};

		await waiting.mock.commands.get("goal")?.handler(command, waiting.ctx);
		const restored = requireLastGoal(waiting.mock);
		assert.equal(restored.id, goal.id);
		assert.deepEqual(restored.waiting, {
			reason: "Waiting before failed delivery",
			resumeAt: Date.now() + 100,
		});

		waiting.mock.rawPi.sendUserMessage = sendUserMessage;
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(waiting.mock.sentUserMessages.length, 2);
	}
});

test("failed priority delivery restores the waiting head and its deadline", async () => {
	const queueSettings = settingsPath("wait-priority-rollback.json");
	writeFileSync(queueSettings, '{"experimental":{"goals":true}}\n');
	const waiting = await startGoalForTest({}, "original goal", queueSettings);
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-priority-rollback",
		{ goal_id: goal.id, reason: "Waiting before failed priority", resume_after_ms: 100 },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	const sendUserMessage = waiting.mock.rawPi.sendUserMessage.bind(waiting.mock.rawPi);
	waiting.mock.rawPi.sendUserMessage = () => {
		throw new Error("priority delivery failed");
	};

	await waiting.mock.commands.get("goal")?.handler("prioritize urgent goal", waiting.ctx);
	assert.equal(requireLastGoal(waiting.mock).id, goal.id);
	assert.equal(requireLastGoal(waiting.mock).waiting?.reason, "Waiting before failed priority");

	waiting.mock.rawPi.sendUserMessage = sendUserMessage;
	await vi.advanceTimersByTimeAsync(100);
	assert.equal(waiting.mock.sentUserMessages.length, 2);
});

test("priority displacement cancels waiting before shelving the old goal", async () => {
	const queueSettings = settingsPath("wait-queue.json");
	writeFileSync(queueSettings, '{"experimental":{"goals":true}}\n');
	const waiting = await startGoalForTest({}, "original goal", queueSettings);
	const goal = requireLastGoal(waiting.mock);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-priority",
		{ goal_id: goal.id, reason: "Waiting before priority", resume_after_ms: 100 },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);

	await waiting.mock.commands.get("goal")?.handler("prioritize urgent goal", waiting.ctx);
	const state = waiting.mock.entries.filter((entry) => entry.customType === "goal-state").at(-1)
		?.data as
		| { goal?: { text?: string; waiting?: unknown }; queue?: Array<{ waiting?: unknown }> }
		| undefined;
	assert.equal(state?.goal?.text, "urgent goal");
	assert.equal(state?.queue?.[0]?.waiting, undefined);
	const messagesAfterPriority = waiting.mock.sentUserMessages.length;
	await vi.advanceTimersByTimeAsync(100);
	assert.equal(waiting.mock.sentUserMessages.length, messagesAfterPriority);
});

test("session restore keeps a waiting deadline absolute and wakes once", async () => {
	const original = await startGoalForTest();
	const goal = requireLastGoal(original.mock);
	await requireGoalTool(original.mock, "goal_wait").execute(
		"wait-restore",
		{ goal_id: goal.id, reason: "Waiting across reload", resume_after_ms: 1_000 },
		new AbortController().signal,
		() => undefined,
		original.ctx,
	);
	const stored = structuredClone(requireLastGoal(original.mock));
	await original.mock.events.get("session_shutdown")?.[0]?.({}, original.ctx);

	await vi.advanceTimersByTimeAsync(400);
	const restored = restoreStoredGoalForTest(stored);
	assert.equal(restored.mock.sentUserMessages.length, 0);
	await vi.advanceTimersByTimeAsync(599);
	assert.equal(restored.mock.sentUserMessages.length, 0);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(restored.mock.sentUserMessages.length, 1);
	assert.equal(requireLastGoal(restored.mock).waiting, undefined);
	await vi.runOnlyPendingTimersAsync();
	assert.equal(restored.mock.sentUserMessages.length, 1);
});

test("waiting excludes idle wall time from active elapsed accounting", async () => {
	const waiting = await startGoalForTest();
	const goal = requireLastGoal(waiting.mock);
	await vi.advanceTimersByTimeAsync(5_000);
	await requireGoalTool(waiting.mock, "goal_wait").execute(
		"wait-time",
		{ goal_id: goal.id, reason: "Waiting for time evidence" },
		new AbortController().signal,
		() => undefined,
		waiting.ctx,
	);
	assert.equal(requireLastGoal(waiting.mock).timeUsedSeconds, 5);

	await vi.advanceTimersByTimeAsync(10_000);
	waiting.mock.events.get("input")?.[0]?.({ source: "interactive", text: "wake now" }, waiting.ctx);
	assert.equal(requireLastGoal(waiting.mock).timeUsedSeconds, 5);

	await vi.advanceTimersByTimeAsync(2_000);
	await waiting.mock.commands.get("goal")?.handler("status", waiting.ctx);
	assert.equal(requireLastGoal(waiting.mock).timeUsedSeconds, 7);
});
