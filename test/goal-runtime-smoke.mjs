import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionPath = resolve(import.meta.dirname, "../src/goal.ts");

async function createHarness(responses, fauxOptions = {}, prepareSession, goalSettings, piSettings = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-goal-runtime-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  if (goalSettings) {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "pi-goal.json"), `${JSON.stringify(goalSettings)}\n`, "utf8");
  }

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let createdSession;
  let agentDirRestored = false;
  const restoreAgentDir = () => {
    if (agentDirRestored) return;
    agentDirRestored = true;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cleanupResources = async () => {
    try {
      createdSession?.dispose();
    } finally {
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        restoreAgentDir();
      }
    }
  };

  try {
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
    const modelRegistry = new ModelRegistry(modelRuntime);
    const faux = createFauxCore({
      api: `pi-goal-faux-${crypto.randomUUID()}`,
      provider: `pi-goal-faux-${crypto.randomUUID()}`,
      ...fauxOptions,
    });
    const provider = faux.getModel().provider;
    modelRegistry.registerProvider(provider, {
      api: faux.api,
      apiKey: "runtime-smoke",
      baseUrl: "http://localhost",
      streamSimple: faux.streamSimple,
      models: faux.models.map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    });
    const model = modelRegistry.find(provider, faux.getModel().id);
    assert.ok(model, "expected registered faux model");
    faux.setResponses(responses);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...piSettings,
    });
    const lifecycleEvents = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [extensionPath],
      extensionFactories: [
        {
          name: "runtime-smoke-observer",
          factory: (pi) => {
            pi.registerTool({
              name: "probe",
              label: "Probe",
              description: "No-op tool for lifecycle smoke coverage",
              parameters: Type.Object({}),
              async execute() {
                lifecycleEvents.push("probe_execute");
                return { content: [{ type: "text", text: "probe complete" }] };
              },
            });
            pi.on("session_start", () => lifecycleEvents.push("session_start"));
            pi.on("agent_start", () => lifecycleEvents.push("agent_start"));
            pi.on("message_end", (event) => {
              if (event.message.role === "assistant") lifecycleEvents.push("assistant_message_end");
            });
            pi.on("tool_execution_end", () => lifecycleEvents.push("tool_execution_end"));
            pi.on("session_before_compact", () => lifecycleEvents.push("session_before_compact"));
            pi.on("session_compact", (event, ctx) =>
              lifecycleEvents.push(
                `session_compact:idle=${ctx.isIdle()}:pending=${ctx.hasPendingMessages()}:reason=${event.reason}:willRetry=${event.willRetry}`,
              ),
            );
            pi.on("agent_settled", () => lifecycleEvents.push("agent_settled"));
          },
        },
      ],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    prepareSession?.(sessionManager);
    const result = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: "builtin",
    });
    assert.deepEqual(result.extensionsResult.errors, []);
    createdSession = result.session;
    await result.session.bindExtensions({});
    return {
      agentDir,
      extensions: result.extensionsResult.extensions.map((extension) => ({
        path: extension.path,
        handlers: [...extension.handlers.keys()],
      })),
      faux,
      lifecycleEvents,
      session: result.session,
      cleanup: cleanupResources,
    };
  } catch (error) {
    await cleanupResources();
    throw error;
  }
}

function completionResponse(context) {
  const modelContext = [context.systemPrompt ?? "", ...context.messages.map(modelMessageText)].join("\n");
  const goalId = [...modelContext.matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g)].at(-1)?.[1];
  assert.ok(goalId, "expected goal id in appended Goal context");
  return fauxAssistantMessage(
    fauxToolCall("goal_complete", {
      goal_id: goalId,
      summary: "Runtime smoke completed and verified.",
    }),
  );
}

function modelMessageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function userMessageText(message) {
  return message.role === "user" ? modelMessageText(message) : "";
}

async function agentDirectoryIsolationScenario() {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const harness = await createHarness([]);
  try {
    assert.equal(process.env.PI_CODING_AGENT_DIR, harness.agentDir);
  } finally {
    await harness.cleanup();
  }
  assert.equal(process.env.PI_CODING_AGENT_DIR, previousAgentDir);
}

function persistedGoalState(session) {
  return session.sessionManager
    .getBranch()
    .filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-state")
    .at(-1)?.data;
}

function persistedGoalStatus(session) {
  return persistedGoalState(session)?.goal?.status ?? null;
}

function persistedGoalHistory(session) {
  return session.sessionManager
    .getBranch()
    .filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-state")
    .map((candidate) => candidate.data?.goal)
    .filter(Boolean);
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function normalContinuationScenario() {
  const harness = await createHarness([
    fauxAssistantMessage("First pass stopped without completion."),
    completionResponse,
  ]);
  const events = [];
  const unsubscribe = harness.session.subscribe((event) => events.push(event.type));
  try {
    await harness.session.prompt("/goal runtime continuation smoke");
    await waitFor(() => harness.faux.state.callCount === 2, "settled continuation");
    await harness.session.agent.waitForIdle();
    assert.equal(events.filter((type) => type === "agent_settled").length, 2);
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(harness.session.messages.map(userMessageText).some((text) => text.includes("pi-goal-continuation:")));
  } finally {
    unsubscribe();
    await harness.cleanup();
  }
}

async function runawayNoProgressScenario() {
  const harness = await createHarness([
    fauxAssistantMessage("Required phrase"),
    fauxAssistantMessage(""),
    fauxAssistantMessage("   ...   "),
    fauxAssistantMessage(""),
  ]);
  try {
    await harness.session.prompt('/goal Reply with exactly: "Required phrase"');
    await waitFor(() => harness.faux.state.callCount === 4, "no-progress safety pause");
    await harness.session.agent.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.faux.state.callCount, 4);
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "no_progress");
    assert.equal(persistedGoalState(harness.session)?.goal?.toolFreeRuns, 3);
    assert.equal(
      harness.session.messages.map(userMessageText).filter((text) => text.includes("pi-goal-continuation:")).length,
      3,
    );
  } finally {
    await harness.cleanup();
  }
}

async function automaticRetryOwnershipScenario() {
  const harness = await createHarness(
    [
      fauxAssistantMessage("Initial unfinished result."),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "HTTP 524: transient upstream timeout",
      }),
      fauxAssistantMessage("Recovered provider response."),
      completionResponse,
    ],
    {},
    undefined,
    undefined,
    {
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    },
  );
  try {
    await harness.session.prompt("/goal runtime retry ownership smoke");
    await waitFor(() => harness.faux.state.callCount === 4, "provider retry and continuation");
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(
      // Only automatic runs count toward the no-progress guard, so a tool-free
      // recovered response counted once proves the retry kept automatic ownership.
      persistedGoalHistory(harness.session).some((goal) => goal.toolFreeRuns === 1 && goal.status === "active"),
      "retry response must retain automatic ownership",
    );
    assert.ok(
      harness.lifecycleEvents.filter((event) => event === "agent_start").length >= 3,
      "expected retry to emit agent_start",
    );
  } finally {
    await harness.cleanup();
  }
}

async function queuedInputScenario() {
  const observedPrompts = [];
  const harness = await createHarness(
    [
      (context) => {
        observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
        return fauxAssistantMessage("x".repeat(120));
      },
      (context) => {
        observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
        return fauxAssistantMessage("Queued request handled.");
      },
      (context) => {
        observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
        return completionResponse(context);
      },
    ],
    { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
  );
  try {
    await harness.session.prompt("/goal queued work smoke");
    await waitFor(() => harness.session.isStreaming, "initial turn streaming");
    await harness.session.prompt("queued user work", { streamingBehavior: "followUp" });
    await waitFor(() => harness.faux.state.callCount === 3, "continuation after queued input");
    await harness.session.agent.waitForIdle();
    const queuedIndex = observedPrompts.findIndex((text) => text.includes("queued user work"));
    const continuationIndex = observedPrompts.findIndex((text) => text.includes("pi-goal-continuation:"));
    assert.ok(queuedIndex >= 0, "expected queued work to reach the model");
    assert.ok(continuationIndex > queuedIndex, "continuation must yield to queued work");
  } finally {
    await harness.cleanup();
  }
}

async function busyEditOwnershipScenario() {
  const harness = await createHarness(
    [
      fauxAssistantMessage("x".repeat(120)),
      fauxAssistantMessage("Edited objective handled in the current run."),
      completionResponse,
    ],
    { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
  );
  try {
    await harness.session.prompt("/goal original busy objective");
    await waitFor(() => harness.session.isStreaming, "busy goal turn");
    await harness.session.prompt("/goal edit revised busy objective");
    await waitFor(() => harness.faux.state.callCount === 3, "edited-goal continuation");
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(
      harness.session.messages.map(userMessageText).some((text) => text.includes("updated objective supersedes")),
    );
  } finally {
    await harness.cleanup();
  }
}

async function pauseScenario() {
  const harness = await createHarness([fauxAssistantMessage("x".repeat(200))], {
    tokensPerSecond: 100,
    tokenSize: { min: 1, max: 1 },
  });
  try {
    await harness.session.prompt("/goal interrupt runtime smoke");
    await waitFor(() => harness.session.isStreaming, "goal turn streaming");
    await harness.session.prompt("/goal pause");
    await waitFor(() => !harness.session.isStreaming, "goal turn abort");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      harness.faux.state.callCount <= 1,
      "an interrupted stream may stop before Faux records its completed call",
    );
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(
      harness.session.messages.map(userMessageText).filter((text) => text.includes("pi-goal-continuation:")).length,
      0,
    );
  } finally {
    await harness.cleanup();
  }
}

async function staleBlockedToolAbortScenario() {
  const observedSignals = [];
  const harness = await createHarness([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Unauthorized: invalid API key",
    }),
    fauxAssistantMessage(fauxToolCall("probe", {})),
    (_context, options) => {
      observedSignals.push(options?.signal?.aborted === true);
      return fauxAssistantMessage("Synthetic stale-turn cleanup.");
    },
  ]);
  try {
    await harness.session.prompt("/goal stale blocked-tool runtime smoke");
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), "blocked");

    // Bypass the normal input boundary to model provider-owned stale work that
    // arrives after the interrupted goal has already installed its tool guard.
    await harness.session.agent.prompt("Simulate a stale provider-owned turn.");
    await harness.session.agent.waitForIdle();
    assert.ok(harness.faux.state.callCount <= 3, "stale guard must allow at most one cleanup call");
    assert.equal(observedSignals.includes(false), false, "any cleanup call must inherit abort");
    assert.equal(harness.lifecycleEvents.filter((event) => event === "probe_execute").length, 0);
  } finally {
    await harness.cleanup();
  }
}

async function manualCompactionScenario() {
  const now = Date.now();
  const harness = await createHarness(
    [fauxAssistantMessage("Compacted prior work."), completionResponse],
    {},
    (sessionManager) => {
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: `Old request ${"x".repeat(100_000)}` }],
        timestamp: now - 4_000,
      });
      sessionManager.appendMessage(fauxAssistantMessage(`Old result ${"y".repeat(100_000)}`));
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Recent request" }],
        timestamp: now - 2_000,
      });
      sessionManager.appendMessage(fauxAssistantMessage("Recent result"));
      sessionManager.appendCustomEntry("goal-state", {
        goal: {
          id: crypto.randomUUID(),
          text: "finish after manual compaction",
          status: "active",
          startedAt: now - 1_000,
          updatedAt: now - 1_000,
          iteration: 1,
          timeUsedSeconds: 1,
        },
      });
    },
  );
  const events = [];
  const unsubscribe = harness.session.subscribe((event) => events.push(event));
  try {
    await harness.session.compact("Summarize for the runtime smoke test.");
    await waitFor(
      () => harness.faux.state.callCount === 2,
      `manual-compaction continuation (${JSON.stringify({
        callCount: harness.faux.state.callCount,
        goalStatus: persistedGoalStatus(harness.session),
        isIdle: harness.session.isIdle,
        events: events.map((event) => event.type),
        extensions: harness.extensions,
        lifecycleEvents: harness.lifecycleEvents,
      })})`,
    );
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(harness.session.messages.map(userMessageText).some((text) => text.includes("pi-goal-continuation:")));
  } finally {
    unsubscribe();
    await harness.cleanup();
  }
}

await agentDirectoryIsolationScenario();
await normalContinuationScenario();
await runawayNoProgressScenario();
await automaticRetryOwnershipScenario();
await queuedInputScenario();
await busyEditOwnershipScenario();
await pauseScenario();
await staleBlockedToolAbortScenario();
await manualCompactionScenario();
console.log(
  "pi-goal runtime smoke: normal continuation, no-progress guard, retry and busy-edit ownership, queued input, pause, stale blocked-tool aborts, and manual compaction passed",
);
