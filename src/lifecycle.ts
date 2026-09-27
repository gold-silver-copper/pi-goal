import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyTerminal } from "./errors.js";
import { GOAL_CONTRACT_MESSAGE_TYPE, goalContractFor, isGoalContextContract, reconcileGoalContract } from "./goal-contract.js";
import { type ActiveGoal, loadGoalStateFromSession } from "./persistence.js";
import {
  type AssistantMessageLike,
  abortCurrentTurn,
  blocksStaleGoalToolCalls,
  findFinalAssistantMessage,
  type GoalRuntime,
  incrementGoal,
  isActiveGoal,
  isGoalContextOverflow,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
  isUserInterruption,
  resetGoalSafetyEpoch,
  STATUS_KEY,
  type StatusContext,
  transitionGoal,
  truncateNotification,
} from "./runtime.js";
import { readGoalSettings } from "./settings.js";

interface GoalLifecycleOptions {
  settingsPath?: string;
}

export function registerGoalLifecycle(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  options: GoalLifecycleOptions = {},
) {
  // Pi invalidates this module's ExtensionContext when the session is replaced
  // or reloaded, but detached prompts and queued emits can still invoke these
  // handlers afterward. After session_shutdown every ctx getter throws a stale
  // context error, so late handlers must return before touching ctx. The flag
  // starts true so handlers keep working on runners where session_start was
  // never emitted (for example late extension loading).
  let sessionActive = true;
  pi.on("session_start", async (_event, ctx) => {
    sessionActive = true;
    runtime.replaceSession();
    runtime.clearCompletionStatusTimer();
    runtime.clearContinuationTracking();
    runtime.clearGoalWaitTimer();
    runtime.clearPendingGoalPrompts();
    runtime.clearAgentRun();
    runtime.guardAbortGoalId = undefined;
    runtime.clearGoalRecovery();
    runtime.clearStaleGoalToolCallBlock();
    runtime.directUserInput = false;
    const settingsResult = readGoalSettings(options.settingsPath);
    runtime.settings = settingsResult.settings;
    for (const warning of settingsResult.warnings) notifyTerminal(ctx.ui, `pi-goal: ${warning}`, "warning");
    const loaded = loadGoalStateFromSession(ctx);
    runtime.activeGoal = loaded;

    if (isActiveGoal(loaded)) {
      runtime.recordGoalTime(loaded);
      if (runtime.enforceNoProgressLimit(ctx)) return;
      if (!runtime.goalToolsAvailable()) {
        runtime.pauseGoalForUnavailableTools(ctx, false);
        return;
      }
      runtime.persistGoal(loaded);
      runtime.ensureGoalContract(ctx);
      if (runtime.activeGoal?.id !== loaded.id || !isActiveGoal(runtime.activeGoal)) return;
      runtime.updateStatus(ctx, runtime.activeGoal);
      runtime.restoreGoalWaitTimer(ctx);
      return;
    }

    if (loaded) {
      runtime.persistGoal(loaded);
      runtime.ensureGoalContract(ctx);
      runtime.updateStatus(ctx, loaded);
    } else {
      runtime.ensureGoalContract(ctx);
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionActive = false;
    runtime.replaceSession();
    runtime.clearGoalWaitTimer();
    if (runtime.activeGoal) {
      if (runtime.activeGoal.status === "active") runtime.recordGoalTime(runtime.activeGoal, false);
      runtime.persistGoal(runtime.activeGoal);
    }
    runtime.clearContinuationTracking();
    runtime.clearPendingGoalPrompts();
    runtime.clearAgentRun();
    runtime.guardAbortGoalId = undefined;
    runtime.clearGoalRecovery();
    runtime.clearStaleGoalToolCallBlock();
    runtime.activeGoal = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    runtime.clearCompletionStatusTimer();
  });

  pi.on("session_before_compact", (_event, ctx) => {
    if (!sessionActive) return;
    if (!isActiveGoal(runtime.activeGoal)) return;
    if (!runtime.recordGoalTime(runtime.activeGoal)) return;
    runtime.cancelContinuationWork();
    runtime.persistGoal(runtime.activeGoal);
    runtime.updateStatus(ctx, runtime.activeGoal);
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!sessionActive) return;
    if (!isActiveGoal(runtime.activeGoal)) {
      runtime.clearGoalRecovery();
      return;
    }

    const restoredGoal = loadGoalStateFromSession(ctx);
    if (restoredGoal?.id === runtime.activeGoal.id) {
      runtime.activeGoal = restoredGoal;
    }
    const usageRecorded = runtime.recordGoalTime(runtime.activeGoal);
    if (usageRecorded) {
      runtime.persistGoal(runtime.activeGoal);
      runtime.updateStatus(ctx, runtime.activeGoal);
    }
    const compactedGoalId = runtime.activeGoal.id;
    runtime.ensureGoalContract(ctx);
    if (runtime.activeGoal?.id !== compactedGoalId || !isActiveGoal(runtime.activeGoal)) return;
    if (!usageRecorded) return;

    const wasPiRetry = runtime.isPiOwnedCompactionRetry(event, runtime.activeGoal.id);
    if (wasPiRetry) return;
    runtime.clearGoalRecoveryForGoal(runtime.activeGoal.id);
    runtime.requestContinuation(runtime.activeGoal);
    // Pi emits session_compact before it clears its manual-compaction controller,
    // so sendUserMessage still rejects inside this hook even when ctx reports idle.
    // Defer one task; threshold compaction retains the intent for agent_settled
    // when Pi is still busy.
    runtime.scheduleContinuationDispatch(ctx, runtime.activeGoal.id);
  });

  pi.on("input", (event, ctx) => {
    if (!sessionActive) return;
    if (event.source === "extension") {
      if (
        runtime.consumeCancelledGoalPrompt(event.text) ||
        runtime.consumeCancelledContinuationPrompt(event.text) ||
        runtime.consumeStaleOwnedGoalPrompt(event.text)
      ) {
        return { action: "handled" as const };
      }
      // Streaming input is queued before its model work starts. Keep owned
      // markers pending for message_start, and track non-goal delivery mode so a
      // steer cannot consume a later follow-up's cleanup protection.
      if (runtime.acceptOwnedInputBoundary(event.text)) return;
      runtime.supersedeOwnedInputCollision(event.text);
      if (runtime.activeGoal?.waiting) runtime.clearGoalWait(ctx, runtime.activeGoal.id);
      if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
        runtime.noteQueuedNonGoalInput(event.text, event.streamingBehavior);
      }
      runtime.clearGoalRecovery();
      return;
    }
    if (/^\/goal(?:\s|$)/u.test(event.text.trimStart())) return;
    runtime.directUserInput = true;
    if (runtime.activeGoal?.waiting) runtime.clearGoalWait(ctx, runtime.activeGoal.id);
    if (event.streamingBehavior === "followUp") {
      runtime.noteQueuedNonGoalInput(event.text, "followUp", true);
      return;
    }
    if (event.streamingBehavior === "steer") {
      runtime.noteQueuedNonGoalInput(event.text, "steer");
    }
    runtime.clearGoalRecovery();
    runtime.clearStaleGoalToolCallBlock();
    runtime.resetActiveSafetyEpoch(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    if (!sessionActive) return;
    const message = event.message as { role?: unknown; content?: unknown };
    if (
      message.role === "assistant" &&
      runtime.activeGoal?.status === "paused" &&
      runtime.guardAbortGoalId === runtime.activeGoal.id
    ) {
      abortCurrentTurn(ctx);
      return;
    }
    if (message.role === "custom") {
      if (Reflect.get(message, "customType") === GOAL_CONTRACT_MESSAGE_TYPE) return;
      if (runtime.activeGoal?.waiting) runtime.clearGoalWait(ctx, runtime.activeGoal.id);
      if (runtime.guardAbortGoalId === runtime.activeGoal?.id) {
        runtime.guardAbortGoalId = undefined;
      }
      beginNonGoalFollowUp(ctx, false);
      return;
    }
    if (message.role !== "user") return;
    const prompt = Array.isArray(message.content)
      ? message.content
          .filter((part) => part && typeof part === "object" && Reflect.get(part, "type") === "text")
          .map((part) => Reflect.get(part as object, "text"))
          .filter((text): text is string => typeof text === "string")
          .join("\n")
      : typeof message.content === "string"
        ? message.content
        : "";
    const ownedPrompt = runtime.consumeOwnedGoalPrompt(prompt);
    const ownedPromptBoundary = runtime.hasOwnedPromptBoundary(prompt);
    const queuedNonGoalInput = runtime.consumeQueuedNonGoalInput(prompt, !ownedPromptBoundary);
    if (!ownedPrompt) {
      if (queuedNonGoalInput?.behavior === "followUp") {
        beginNonGoalFollowUp(ctx, queuedNonGoalInput.resetSafetyEpoch);
      }
      return;
    }
    if (runtime.activeGoal?.id !== ownedPrompt.goalId || !isActiveGoal(runtime.activeGoal)) {
      return;
    }
    runtime.beginAgentRun(ownedPrompt.goalId, "manual");
    if (ownedPrompt.resetSafetyEpoch) {
      runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
    }
    runtime.persistGoal(runtime.activeGoal);
    runtime.updateStatus(ctx, runtime.activeGoal);
  });

  pi.on("context", (event, ctx) => {
    if (!sessionActive) return;
    const keptMessages = event.messages;
    const expected = goalContractFor(runtime.activeGoal);
    const needsContract =
      expected.details.state !== "inactive" ||
      keptMessages.some(isGoalContextContract) ||
      runtime.hasGoalContextContractHistory(ctx);
    const messages = needsContract ? reconcileGoalContract(keptMessages, expected) : keptMessages;
    if (runtime.activeGoal?.status === "paused" && runtime.guardAbortGoalId === runtime.activeGoal.id) {
      // A current custom follow-up clears the guard at message_start. Otherwise,
      // context transformation aborts before the provider adapter receives the signal.
      abortCurrentTurn(ctx);
    }
    if (messages !== keptMessages) {
      return { messages: messages as typeof event.messages };
    }
  });

  pi.on("tool_call", (event, ctx) => {
    if (!sessionActive) return;
    runtime.markAgentToolAttempted();
    if (!runtime.staleGoalToolCallsBlocked) return;
    if (!runtime.activeGoal || !blocksStaleGoalToolCalls(runtime.activeGoal.status)) {
      runtime.clearStaleGoalToolCallBlock();
      return;
    }
    // A blocked tool result would normally trigger another model call. Abort the
    // current turn so a tool-seeking model cannot create an unbounded loop that
    // burns provider quota while the goal is stopped.
    abortCurrentTurn(ctx);
    return {
      block: true,
      reason: "Blocked stale /goal tool call after the goal stopped or was interrupted.",
    };
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    if (!sessionActive) return;
    if (!isActiveGoal(runtime.activeGoal)) return;
    if (!runtime.recordGoalTime(runtime.activeGoal)) return;
    runtime.persistGoal(runtime.activeGoal);
    runtime.updateStatus(ctx, runtime.activeGoal);
    if (!runtime.goalToolsAvailable()) runtime.pauseGoalForUnavailableTools(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!sessionActive) return;
    runtime.clearAgentRun();
    // Pi-owned retries emit agent_start directly. Reaching a normal prompt
    // boundary means cleanup no longer owns the next run, so the hard-cap guard
    // must not abort it.
    if (runtime.guardAbortGoalId) runtime.guardAbortGoalId = undefined;
    const goalPrompt = runtime.consumeOwnedGoalPrompt(event.prompt);
    const goalPromptGoalId = goalPrompt?.goalId;
    const continuationGoalId = goalPromptGoalId ? undefined : runtime.markContinuationStarted(event.prompt);
    const ownedPromptGoalId = goalPromptGoalId ?? continuationGoalId;
    const ownedPromptBoundary = runtime.hasOwnedPromptBoundary(event.prompt);
    const activeGoalRecovery = runtime.hasActiveGoalRecovery();
    const queuedNonGoalInput = runtime.consumeQueuedNonGoalInput(
      event.prompt,
      !activeGoalRecovery && ownedPromptGoalId === undefined && !ownedPromptBoundary,
    );
    if (queuedNonGoalInput?.behavior === "followUp") {
      beginNonGoalFollowUp(ctx, queuedNonGoalInput.resetSafetyEpoch);
    }
    if (!ownedPromptGoalId && !ownedPromptBoundary) {
      runtime.supersedeOwnedInputCollision(event.prompt);
      if (runtime.activeGoal?.waiting) runtime.clearGoalWait(ctx, runtime.activeGoal.id);
    }
    const runOrigin = continuationGoalId
      ? "automatic"
      : activeGoalRecovery && runtime.goalRecovery?.automaticOwner
        ? "automatic"
        : "manual";
    if (ownedPromptGoalId && ownedPromptGoalId !== runtime.activeGoal?.id) {
      runtime.beginAgentRun(ownedPromptGoalId, runOrigin);
      if (runtime.activeGoal?.status === "active" && !runtime.goalToolsAvailable()) {
        runtime.pauseGoalForUnavailableTools(ctx, false);
      }
      abortCurrentTurn(ctx);
      return;
    }
    if (!isActiveGoal(runtime.activeGoal)) return goalContractBoundaryResult(ctx);
    runtime.beginAgentRun(runtime.activeGoal.id, runOrigin);
    if (!runtime.goalToolsAvailable()) {
      runtime.pauseGoalForUnavailableTools(ctx, ownedPromptGoalId !== undefined);
      return goalContractBoundaryResult(ctx);
    }
    if (goalPrompt?.resetSafetyEpoch && goalPromptGoalId === runtime.activeGoal.id) {
      runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
      runtime.persistGoal(runtime.activeGoal);
      runtime.updateStatus(ctx, runtime.activeGoal);
    }
    return goalContractBoundaryResult(ctx);
  });

  pi.on("agent_start", (_event, _ctx) => {
    if (!sessionActive) return;
    const activeGoal = runtime.activeGoal;
    if (activeGoal && runtime.guardAbortGoalId === activeGoal.id && activeGoal.status === "paused") {
      if (runtime.consumeQueuedNonGoalFollowUpForAgentStart()) {
        runtime.guardAbortGoalId = undefined;
        runtime.clearStaleGoalToolCallBlock();
        runtime.beginAgentRun(null, undefined);
      }
      // Unknown runs defer cleanup until their message/context boundary: custom
      // follow-ups have no input event, while bare recovery is aborted pre-provider.
      return;
    }
    runtime.beginRecoveryRunIfNeeded();
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!sessionActive) return;
    // Terminal Goal tools transition state synchronously, but their contract must
    // wait until Pi has persisted the real tool result at this turn boundary.
    if (runtime.activeGoal?.status !== "active") runtime.ensureGoalContract(ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    if (!sessionActive) return;
    const run = runtime.finishAgentRun();
    runtime.directUserInput = false;
    if (run.goalId === null) return;
    if (!runtime.runOwnsGoal()) return;
    if (run.goalId && run.goalId !== runtime.activeGoal?.id) return;
    if (!isActiveGoal(runtime.activeGoal)) return;

    const goalId = runtime.activeGoal.id;
    const alreadyAwaitingContinuation = runtime.hasContinuationWorkForGoal(goalId);
    const finalAssistant = findFinalAssistantMessage(event.messages);

    if (!alreadyAwaitingContinuation) runtime.activeGoal = incrementGoal(runtime.activeGoal);
    runtime.recordGoalTime(runtime.activeGoal);

    if (finalAssistant && isUserInterruption(finalAssistant, ctx.signal)) {
      runtime.clearGoalRecoveryForGoal(goalId);
      stopGoalAfterAgentEnd(ctx, runtime.activeGoal, finalAssistant, "paused", "interrupted");
      return;
    }

    if (finalAssistant?.stopReason === "error") {
      if (isRetryableGoalInterruption(finalAssistant)) {
        if (!runtime.goalToolsAvailable()) {
          runtime.pauseGoalForUnavailableTools(ctx);
          return;
        }
        runtime.goalRecovery = {
          goalId,
          kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
          automaticOwner: run.origin === "automatic",
          errorMessage: finalAssistant.errorMessage,
        };
        runtime.cancelContinuationWork();
        runtime.persistGoal(runtime.activeGoal);
        runtime.updateStatus(ctx, runtime.activeGoal);
        return;
      }
      runtime.clearGoalRecoveryForGoal(goalId);
      if (isUsageLimitedGoalInterruption(finalAssistant)) {
        stopGoalAfterAgentEnd(ctx, runtime.activeGoal, finalAssistant, "usage_limited");
      } else {
        stopGoalAfterAgentEnd(ctx, runtime.activeGoal, finalAssistant, "paused", "error");
      }
      return;
    }

    runtime.clearGoalRecoveryForGoal(goalId);

    if (!runtime.goalToolsAvailable()) {
      runtime.pauseGoalForUnavailableTools(ctx);
      return;
    }
    if (
      run.origin === "automatic" &&
      runtime.recordAutomaticRunProgress(ctx, goalId, run.toolAttempted || hasAssistantToolCall(event.messages))
    ) {
      return;
    }

    runtime.persistGoal(runtime.activeGoal);
    runtime.updateStatus(ctx, runtime.activeGoal);

    const currentGoal = runtime.activeGoal;
    if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
    runtime.requestContinuation(currentGoal);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!sessionActive) return;
    runtime.finalizeSettledRecovery(ctx);
    const resumedWait = runtime.dispatchDueGoalWait(ctx);
    if (!resumedWait) runtime.dispatchContinuationIfSettled(ctx);
    runtime.clearSettledSafetyTracking();
  });

  function goalContractBoundaryResult(ctx: StatusContext) {
    const message = runtime.goalContractForPrompt(ctx);
    return message ? { message } : undefined;
  }

  function beginNonGoalFollowUp(ctx: StatusContext, resetSafetyEpoch: boolean) {
    runtime.clearGoalRecovery();
    runtime.clearStaleGoalToolCallBlock();
    const activeGoalId = runtime.activeGoal?.status === "active" ? runtime.activeGoal.id : undefined;
    runtime.beginAgentRun(activeGoalId ?? null, activeGoalId ? "manual" : undefined);
    if (resetSafetyEpoch && activeGoalId) runtime.resetActiveSafetyEpoch(ctx);
  }

  function stopGoalAfterAgentEnd(
    ctx: StatusContext,
    goal: ActiveGoal,
    assistant: AssistantMessageLike,
    status: "paused" | "usage_limited",
    pauseReason?: "interrupted" | "error",
  ) {
    const stoppedGoal = runtime.stopActiveGoal(ctx, {
      kind: "agent_interruption",
      expectedGoalId: goal.id,
      status,
      pauseReason,
      reason: assistant.errorMessage ?? `goal ${status} after agent interruption`,
    });
    if (!stoppedGoal) return;

    const details = assistant.errorMessage ? ` (${truncateNotification(assistant.errorMessage)})` : "";
    if (status === "usage_limited") {
      notifyTerminal(
        ctx.ui,
        `Goal stopped after provider usage limit${details}. Run /goal resume when usage is available.`,
        "warning",
      );
      return;
    }
    if (pauseReason === "interrupted") {
      notifyTerminal(ctx.ui, 'Goal paused. Say "continue" to resume it, or run /goal resume.', "info");
      return;
    }
    notifyTerminal(ctx.ui, `Goal paused after agent error${details}. Say "continue" or run /goal resume to retry.`, "warning");
  }

}

function hasAssistantToolCall(messages: readonly unknown[]) {
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const candidate = message as { role?: unknown; content?: unknown };
    return (
      candidate.role === "assistant" &&
      Array.isArray(candidate.content) &&
      candidate.content.some((block) => block && typeof block === "object" && Reflect.get(block, "type") === "toolCall")
    );
  });
}
