import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkpointGoalActiveTime, formatDuration } from "./accounting.js";
import { formatError, isStaleContextError, notifyTerminal, safeGoalMenuText, truncateNotification } from "./errors.js";
import { goalContractFor, hasCurrentGoalContract, hasGoalContextContractHistory } from "./goal-contract.js";
import { appendGoalPromptMarker, extractContinuationMarker, extractGoalPromptMarker } from "./markers.js";
import { type ObjectiveFile, refreshObjectiveFile } from "./objective-file.js";
import { type ActiveGoal, GOAL_STATE_ENTRY_TYPE, MAX_STOP_DETAIL_LENGTH, serializeGoalState } from "./persistence.js";
import { buildContinuePrompt, type GoalStatus, type PauseReason, stoppedGoalDescription } from "./prompts.js";
import { DEFAULT_GOAL_SETTINGS, type GoalSettings } from "./settings.js";
import { assertGoalToolsAvailable, goalToolsAvailable } from "./tool-policy.js";
import { type GoalWait, GoalWaitTimer } from "./wait.js";

export { GOAL_STATE_ENTRY_TYPE } from "./persistence.js";
export {
  GOAL_BLOCKED_TOOL,
  GOAL_COMPLETE_TOOL,
  GOAL_RESUME_TOOL,
  GOAL_TOOL_NAMES,
  GOAL_WAIT_TOOL,
} from "./tool-policy.js";

export interface ContinuationTicket {
  goalId: string;
  iteration: number;
  marker: string;
  prompt: string;
}

export type GoalRecoveryKind = "provider_retry" | "compaction_retry";

export type GoalRunOrigin = "manual" | "automatic";

export interface GoalRecovery {
  goalId: string;
  kind: GoalRecoveryKind;
  automaticOwner: boolean;
  errorMessage?: string;
}

export interface CompletedGoalRun {
  goalId?: string | null;
  origin?: GoalRunOrigin;
  toolAttempted: boolean;
}

type StoppedGoalStatus = "paused" | "blocked" | "usage_limited";

export type GoalStopRequest =
  | { kind: "explicit_pause"; expectedGoalId: string }
  | {
      kind: "safety_pause";
      expectedGoalId: string;
      cause: "no_progress" | "time_limit";
      abortTurn: boolean;
    }
  | { kind: "retry_exhausted"; expectedGoalId: string; reason: string }
  | {
      kind: "tools_unavailable";
      expectedGoalId: string;
      abortTurn: boolean;
      recordUsage: boolean;
    }
  | { kind: "blocker_report"; expectedGoalId: string; reason: string }
  | {
      kind: "agent_interruption";
      expectedGoalId: string;
      status: "paused" | "usage_limited";
      pauseReason?: "interrupted" | "error";
      reason: string;
    };

export interface StatusContext {
  cwd: string;
  mode?: "tui" | "rpc" | "json" | "print";
  ui: {
    confirm: (title: string, message: string) => Promise<boolean>;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
  };
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  signal?: AbortSignal;
  abort?: () => void;
  sessionManager?: unknown;
}

export const STATUS_KEY = "goal";
export const MAX_GOAL_ID_LENGTH = 128;
/** Consecutive tool-free automatic continuations that pause the goal. */
export const NO_PROGRESS_RUN_LIMIT = 3;

interface PendingGoalPrompt {
  goalId: string;
  resetSafetyEpoch: boolean;
  fingerprint: string;
  prompt: string;
}

interface PendingNonGoalInput {
  behavior: "steer" | "followUp";
  fingerprint: string;
  resetSafetyEpoch: boolean;
}

const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;
const MAX_PENDING_GOAL_PROMPTS = 20;
const MAX_PENDING_NON_GOAL_INPUTS = 20;

export function isActiveGoal(goal: ActiveGoal | undefined): goal is ActiveGoal {
  return goal?.status === "active";
}

// One instance belongs to one extension factory and owns all mutable session state.
// Prompt ownership, continuation, safety and external-wait transitions share
// ordering-sensitive invariants, so they stay together in this class.
export class GoalRuntime {
  settings: GoalSettings = DEFAULT_GOAL_SETTINGS;
  activeGoal?: ActiveGoal;
  completionStatusTimer?: NodeJS.Timeout;
  private continuationDispatchTimer?: NodeJS.Timeout;
  private readonly goalWaitTimer = new GoalWaitTimer();
  private goalWaitDeadlineRetry?: {
    goalId: string;
    resumeAt: number;
    retryAt?: number;
    exhausted: boolean;
  };
  continuationIntent?: ContinuationTicket;
  continuationDelivery?: ContinuationTicket;
  goalRecovery?: GoalRecovery;
  /** `null` marks a run that must not be charged to the active goal. */
  agentRunGoalId?: string | null;
  agentRunOrigin?: GoalRunOrigin;
  agentRunToolAttempted = false;
  guardAbortGoalId?: string;
  staleGoalToolCallsBlocked = false;
  /** Set when the user typed (TUI) or sent (RPC) input for the current run; cleared when the run ends. */
  directUserInput = false;
  pendingGoalPromptMarkers = new Map<string, PendingGoalPrompt>();
  claimedGoalPromptMarkers = new Map<string, string>();
  cancelledGoalPromptMarkers = new Map<string, string>();
  cancelledContinuationMarkers = new Map<string, string>();
  claimedContinuationMarkers = new Map<string, string>();
  pendingNonGoalInputs: PendingNonGoalInput[] = [];
  /** Bumped on session replacement and shutdown so timers from an old session do nothing. */
  sessionGeneration = 0;

  readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  goalToolsAvailable() {
    return goalToolsAvailable(this.pi);
  }

  assertGoalToolsAvailable() {
    assertGoalToolsAvailable(this.pi);
  }

  replaceSession() {
    this.sessionGeneration += 1;
  }

  /** False when the current run was explicitly excluded from Goal ownership. */
  runOwnsGoal(goalId?: string) {
    return (
      this.agentRunGoalId !== null &&
      (goalId === undefined || this.agentRunGoalId === undefined || this.agentRunGoalId === goalId)
    );
  }

  hasActiveGoalRecovery() {
    return Boolean(this.activeGoal && this.goalRecovery?.goalId === this.activeGoal.id);
  }

  beginAgentRun(goalId: string | null | undefined, origin: GoalRunOrigin | undefined) {
    this.agentRunGoalId = goalId;
    this.agentRunOrigin = origin;
    this.agentRunToolAttempted = false;
  }

  beginRecoveryRunIfNeeded() {
    if (this.agentRunGoalId !== undefined || !this.activeGoal) return;
    const recovery = this.goalRecovery;
    if (!recovery || recovery.goalId !== this.activeGoal.id) return;
    this.beginAgentRun(recovery.goalId, recovery.automaticOwner ? "automatic" : "manual");
  }

  markAgentToolAttempted() {
    if (this.agentRunGoalId !== undefined) this.agentRunToolAttempted = true;
  }

  finishAgentRun(): CompletedGoalRun {
    const run = {
      goalId: this.agentRunGoalId,
      origin: this.agentRunOrigin,
      toolAttempted: this.agentRunToolAttempted,
    };
    this.clearAgentRun();
    return run;
  }

  clearAgentRun() {
    this.agentRunGoalId = undefined;
    this.agentRunOrigin = undefined;
    this.agentRunToolAttempted = false;
  }

  reclassifyAgentRunAsManual() {
    if (this.agentRunGoalId !== undefined) this.agentRunOrigin = "manual";
  }

  isAutomaticRunForGoal(goalId: string) {
    return this.agentRunGoalId === goalId && this.agentRunOrigin === "automatic";
  }

  /** Checkpoint active elapsed time for a goal the current run may act for. */
  recordGoalTime(goal: ActiveGoal, checkpointActiveTime = goal.status === "active" && !goal.waiting) {
    if (!this.runOwnsGoal(goal.id)) return false;
    const now = Date.now();
    checkpointGoalActiveTime(goal, now, checkpointActiveTime);
    goal.updatedAt = now;
    return true;
  }

  requestContinuation(goal: ActiveGoal) {
    if (!isActiveGoal(goal)) return false;
    if (goal.waiting || this.hasContinuationWorkForGoal(goal.id)) return false;
    const marker = continuationMarker(goal);
    this.continuationIntent = {
      goalId: goal.id,
      iteration: goal.iteration,
      marker,
      prompt: buildContinuePrompt(goal, marker),
    };
    return true;
  }

  dispatchContinuationIfSettled(ctx: StatusContext) {
    const intent = this.continuationIntent;
    if (!isActiveGoal(this.activeGoal)) {
      this.cancelContinuationWork();
      return false;
    }
    if (!intent) return false;
    if (!this.goalToolsAvailable()) {
      this.pauseGoalForUnavailableTools(ctx);
      return false;
    }
    if (this.activeGoal.id !== intent.goalId || this.activeGoal.waiting) {
      this.continuationIntent = undefined;
      return false;
    }
    if (this.enforceNoProgressLimit(ctx)) return false;
    if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;

    this.clearContinuationDispatchTimer();
    this.continuationIntent = undefined;
    this.continuationDelivery = intent;
    try {
      this.pi.sendUserMessage(intent.prompt, { deliverAs: "followUp" });
      return true;
    } catch (error) {
      if (this.continuationDelivery?.marker === intent.marker) {
        this.continuationDelivery = undefined;
      }
      if (this.activeGoal?.id === intent.goalId && this.activeGoal.status === "active") {
        this.continuationIntent = intent;
      }
      notifyWhenSessionAlive(ctx, `Goal prompt failed: ${formatError(error)}`, "error");
      return false;
    }
  }

  hasContinuationWorkForGoal(goalId: string) {
    return this.continuationIntent?.goalId === goalId || this.continuationDelivery?.goalId === goalId;
  }

  enterGoalWait(ctx: StatusContext, goalId: string, waiting: GoalWait) {
    const goal = this.activeGoal;
    if (!isActiveGoal(goal) || goal.id !== goalId) return undefined;
    this.recordGoalTime(goal, false);
    this.cancelContinuationWork();
    this.clearGoalRecoveryForGoal(goal.id);
    this.clearGoalWaitTimer();
    this.activeGoal = {
      ...goal,
      waiting,
      activeStartedAt: undefined,
      updatedAt: Date.now(),
    };
    this.persistGoal(this.activeGoal);
    this.updateStatus(ctx, this.activeGoal);
    this.restoreGoalWaitTimer(ctx);
    return this.activeGoal;
  }

  clearGoalWait(ctx: StatusContext, goalId: string) {
    const goal = this.activeGoal;
    if (!isActiveGoal(goal) || goal.id !== goalId || !goal.waiting) return false;
    this.clearGoalWaitTimer();
    const { waiting: _waiting, ...nextGoal } = goal;
    const now = Date.now();
    checkpointGoalActiveTime(nextGoal, now, true);
    nextGoal.updatedAt = now;
    this.activeGoal = nextGoal;
    this.persistGoal(this.activeGoal);
    this.updateStatus(ctx, this.activeGoal);
    return true;
  }

  restoreGoalWaitTimer(ctx: StatusContext) {
    this.clearGoalWaitTimer();
    const goal = this.activeGoal;
    const resumeAt = isActiveGoal(goal) ? goal.waiting?.resumeAt : undefined;
    if (!goal || resumeAt === undefined) return false;
    this.scheduleGoalWaitTimer(ctx, goal.id, resumeAt);
    return true;
  }

  dispatchDueGoalWait(ctx: StatusContext) {
    const goal = this.activeGoal;
    const waiting = isActiveGoal(goal) ? goal.waiting : undefined;
    const resumeAt = waiting?.resumeAt;
    if (!goal || !waiting || resumeAt === undefined) return false;
    const retry = this.goalWaitDeadlineRetry;
    const matchingRetry = retry?.goalId === goal.id && retry.resumeAt === resumeAt ? retry : undefined;
    if (matchingRetry?.exhausted) return false;
    const wakeAt = matchingRetry?.retryAt ?? resumeAt;
    if (Date.now() < wakeAt) return false;
    const retryAttempt = matchingRetry?.retryAt !== undefined;
    if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;
    if (retryAttempt) this.goalWaitDeadlineRetry = undefined;
    if (!this.clearGoalWait(ctx, goal.id)) return false;
    const resumedGoal = this.activeGoal;
    if (!resumedGoal || resumedGoal.id !== goal.id || resumedGoal.status !== "active") return false;
    this.requestContinuation(resumedGoal);
    const dispatched = this.dispatchContinuationIfSettled(ctx);
    if (dispatched) return true;
    if (
      this.activeGoal?.id === goal.id &&
      this.activeGoal.status === "active" &&
      this.continuationIntent?.goalId === goal.id
    ) {
      this.restoreGoalWaitAfterDeadlineFailure(ctx, goal.id, waiting, !retryAttempt);
    }
    return false;
  }

  clearGoalWaitTimer() {
    this.goalWaitTimer.clear();
    this.goalWaitDeadlineRetry = undefined;
  }

  private scheduleGoalWaitTimer(ctx: StatusContext, goalId: string, wakeAt: number) {
    const generation = this.sessionGeneration;
    this.goalWaitTimer.schedule(wakeAt, () => {
      if (generation !== this.sessionGeneration || this.activeGoal?.id !== goalId || !isActiveGoal(this.activeGoal)) {
        return;
      }
      try {
        this.dispatchDueGoalWait(ctx);
      } catch (error) {
        notifyWhenSessionAlive(ctx, `Goal wait deadline failed: ${formatError(error)}`, "error");
      }
    });
  }

  private restoreGoalWaitAfterDeadlineFailure(
    ctx: StatusContext,
    goalId: string,
    waiting: GoalWait,
    allowRetry: boolean,
  ) {
    const goal = this.activeGoal;
    if (!goal || goal.id !== goalId || goal.status !== "active" || waiting.resumeAt === undefined) {
      return;
    }
    this.cancelContinuationWork();
    this.recordGoalTime(goal, false);
    this.goalWaitTimer.clear();
    this.activeGoal = {
      ...goal,
      waiting,
      activeStartedAt: undefined,
      updatedAt: Date.now(),
    };
    const retryAt = allowRetry ? Date.now() + 1_000 : undefined;
    this.goalWaitDeadlineRetry = {
      goalId,
      resumeAt: waiting.resumeAt,
      retryAt,
      exhausted: !allowRetry,
    };
    this.persistGoal(this.activeGoal);
    this.updateStatus(ctx, this.activeGoal);
    if (retryAt !== undefined) this.scheduleGoalWaitTimer(ctx, goalId, retryAt);
  }

  updateStatus(ctx: StatusContext, goal: ActiveGoal) {
    this.clearCompletionStatusTimer();
    ctx.ui.setStatus(STATUS_KEY, formatStatus(goal));
  }

  stopActiveGoal(ctx: StatusContext, request: GoalStopRequest) {
    const goal = this.activeGoal;
    if (!goal || goal.id !== request.expectedGoalId) return undefined;

    this.clearGoalWaitTimer();
    let status: StoppedGoalStatus = "paused";
    let pauseReason: PauseReason | undefined;
    let stopDetail: string | undefined;
    switch (request.kind) {
      case "explicit_pause":
        this.recordGoalTime(goal);
        this.cancelContinuationWork();
        this.clearGoalRecoveryForGoal(goal.id);
        this.blockStaleGoalToolCalls();
        abortCurrentTurn(ctx);
        pauseReason = "user";
        break;
      case "safety_pause":
        this.recordGoalTime(goal);
        this.cancelContinuationWork();
        this.clearGoalRecoveryForGoal(goal.id);
        this.blockStaleGoalToolCalls();
        if (request.abortTurn) {
          this.guardAbortGoalId = goal.id;
          abortCurrentTurn(ctx);
        }
        pauseReason = request.cause;
        break;
      case "retry_exhausted":
        this.clearGoalRecoveryForGoal(goal.id);
        this.cancelContinuationWork();
        this.blockStaleGoalToolCalls();
        status = "blocked";
        stopDetail = request.reason;
        break;
      case "tools_unavailable":
        if (request.recordUsage) this.recordGoalTime(goal);
        this.cancelContinuationWork();
        this.clearGoalRecoveryForGoal(goal.id);
        if (request.abortTurn) {
          this.blockStaleGoalToolCalls();
          abortCurrentTurn(ctx);
        } else {
          this.clearStaleGoalToolCallBlock();
        }
        pauseReason = "tools_unavailable";
        break;
      case "blocker_report":
        this.recordGoalTime(goal);
        this.cancelContinuationWork();
        this.clearGoalRecoveryForGoal(goal.id);
        this.blockStaleGoalToolCalls();
        status = "blocked";
        stopDetail = request.reason;
        break;
      case "agent_interruption":
        this.cancelContinuationWork();
        this.blockStaleGoalToolCalls();
        abortCurrentTurn(ctx);
        status = request.status;
        pauseReason = request.status === "paused" ? request.pauseReason : undefined;
        if (request.pauseReason === "error" || request.status === "usage_limited") stopDetail = request.reason;
        break;
    }

    const stoppedGoal: ActiveGoal = {
      ...transitionGoal(goal, status),
      pauseReason: status === "paused" ? pauseReason : undefined,
      stopDetail: stopDetail?.trim().slice(0, MAX_STOP_DETAIL_LENGTH) || undefined,
    };
    this.activeGoal = stoppedGoal;
    this.persistGoal(stoppedGoal);
    // A goal_blocked result must be persisted before its contract, so turn_end appends it.
    if (request.kind !== "blocker_report") this.ensureGoalContract(ctx);
    if (this.activeGoal === stoppedGoal) this.updateStatus(ctx, stoppedGoal);
    return stoppedGoal;
  }

  /**
   * Reactivate a paused or blocked goal from inside the current run (goal_resume).
   * The goal keeps its goal_id: the aborted run that stopped it has ended, so none of
   * its tool calls can arrive later. The run becomes Goal-owned, so its agent_end
   * follows the normal continuation rules.
   */
  resumeStoppedGoal(ctx: StatusContext) {
    const goal = this.activeGoal;
    if (!goal || (goal.status !== "paused" && goal.status !== "blocked")) return undefined;
    this.cancelContinuationWork();
    this.clearGoalRecovery();
    this.clearStaleGoalToolCallBlock();
    const resumed = resetGoalSafetyEpoch(transitionGoal(goal, "active"));
    this.activeGoal = resumed;
    this.persistGoal(resumed);
    this.updateStatus(ctx, resumed);
    this.beginAgentRun(resumed.id, "manual");
    // Pi defers a custom message sent mid-run to the end of the turn, after the tool result.
    this.ensureGoalContract(ctx);
    return resumed;
  }

  blockStaleGoalToolCalls() {
    this.staleGoalToolCallsBlocked = true;
  }

  clearStaleGoalToolCallBlock() {
    this.staleGoalToolCallsBlocked = false;
  }

  clearGoalRecovery() {
    this.goalRecovery = undefined;
  }

  /** Count automatic continuations that ended without trying any tool; enough of them in a row pause the goal. */
  recordAutomaticRunProgress(ctx: StatusContext, goalId: string, toolAttempted: boolean) {
    const goal = this.activeGoal;
    if (goal?.id !== goalId || goal.status !== "active") return false;
    goal.toolFreeRuns = toolAttempted ? 0 : goal.toolFreeRuns + 1;
    return this.enforceNoProgressLimit(ctx);
  }

  enforceNoProgressLimit(ctx: StatusContext, abortTurn = false) {
    const goal = this.activeGoal;
    if (goal?.status !== "active" || goal.toolFreeRuns < NO_PROGRESS_RUN_LIMIT) return false;
    return this.pauseGoalForSafety(ctx, "no_progress", abortTurn);
  }

  pauseGoalForSafety(ctx: StatusContext, cause: "no_progress", abortTurn: boolean) {
    const goal = this.activeGoal;
    if (goal?.status !== "active") return false;
    const stoppedGoal = this.stopActiveGoal(ctx, { kind: "safety_pause", expectedGoalId: goal.id, cause, abortTurn });
    if (!stoppedGoal) return false;
    notifyTerminal(
      ctx.ui,
      `Goal paused: ${stoppedGoal.toolFreeRuns} automatic continuations in a row ended without using a tool. Say "continue" or run /goal resume.`,
      "warning",
    );
    return true;
  }

  /** Direct user input resets the no-progress count and makes the current run manual. */
  resetActiveSafetyEpoch(ctx: StatusContext) {
    const goal = this.activeGoal;
    if (goal?.status !== "active") return false;
    this.reclassifyAgentRunAsManual();
    if (goal.toolFreeRuns === 0) return true;
    this.activeGoal = resetGoalSafetyEpoch(goal);
    this.persistGoal(this.activeGoal);
    this.updateStatus(ctx, this.activeGoal);
    return true;
  }

  finalizeSettledRecovery(ctx: StatusContext) {
    const recovery = this.goalRecovery;
    if (!recovery) return false;
    this.goalRecovery = undefined;
    const goal = this.activeGoal;
    if (goal?.id !== recovery.goalId || goal.status !== "active") return false;
    const details = recovery.errorMessage ? `: ${truncateNotification(recovery.errorMessage)}` : "";
    if (recovery.kind === "provider_retry") {
      const waitingGoal = this.enterGoalWait(ctx, goal.id, {
        reason: `Provider retries exhausted${details}`,
      });
      if (!waitingGoal) return false;
      notifyTerminal(
        ctx.ui,
        `Goal waiting after provider retries were exhausted${details}. Send a follow-up or run /goal resume to retry.`,
        "warning",
      );
      return true;
    }
    const stoppedGoal = this.stopActiveGoal(ctx, {
      kind: "retry_exhausted",
      expectedGoalId: goal.id,
      reason: `agent error after retries${details}`,
    });
    if (!stoppedGoal) return false;
    notifyTerminal(
      ctx.ui,
      `Goal blocked after agent error retries were exhausted${details}. Resolve the blocker or run /goal resume to retry.`,
      "warning",
    );
    return true;
  }

  clearSettledSafetyTracking() {
    this.guardAbortGoalId = undefined;
    this.pendingNonGoalInputs = [];
    this.claimedGoalPromptMarkers.clear();
    this.claimedContinuationMarkers.clear();
    this.clearAgentRun();
  }

  clearGoalRecoveryForGoal(goalId: string) {
    if (this.goalRecovery?.goalId === goalId) this.goalRecovery = undefined;
  }

  isPiOwnedCompactionRetry(event: unknown, goalId: string) {
    const compaction = event as { reason?: unknown; willRetry?: unknown };
    if (compaction.willRetry === true) return true;
    return (
      this.goalRecovery?.goalId === goalId &&
      this.goalRecovery.kind === "compaction_retry" &&
      (compaction.reason === undefined || compaction.reason === "overflow")
    );
  }

  clearContinuationTracking() {
    this.clearContinuationDispatchTimer();
    this.continuationIntent = undefined;
    this.continuationDelivery = undefined;
    this.cancelledContinuationMarkers.clear();
    this.claimedContinuationMarkers.clear();
  }

  clearPendingGoalPrompts() {
    this.pendingGoalPromptMarkers.clear();
    this.claimedGoalPromptMarkers.clear();
    this.cancelledGoalPromptMarkers.clear();
    this.pendingNonGoalInputs = [];
  }

  /** Append the contract for the current state when the session does not already end with it. */
  ensureGoalContract(ctx: StatusContext) {
    const contract = this.goalContractForPrompt(ctx);
    if (contract) this.pi.sendMessage(contract, { triggerTurn: false });
  }

  /** The contract for the current state, or undefined when the context already carries it. */
  goalContractForPrompt(ctx: StatusContext) {
    this.refreshObjectiveFile();
    const expected = goalContractFor(this.activeGoal);
    const { contextEntries, historyEntries } = goalContractEntries(ctx);
    if (hasCurrentGoalContract(contextEntries, expected)) return undefined;
    if (
      expected.details.state === "inactive" &&
      !hasGoalContextContractHistory(contextEntries) &&
      !hasGoalContextContractHistory(historyEntries)
    ) {
      return undefined;
    }
    return expected;
  }

  /** A contract about to be written says whether the objective file changed, so re-hash it first. */
  private refreshObjectiveFile() {
    const goal = this.activeGoal;
    if (!goal?.objectiveFile) return;
    const file = refreshObjectiveFile(goal.objectiveFile);
    if (file === goal.objectiveFile) return;
    this.activeGoal = { ...goal, objectiveFile: file };
    this.persistGoal(this.activeGoal);
  }

  hasGoalContextContractHistory(ctx: StatusContext) {
    const { contextEntries, historyEntries } = goalContractEntries(ctx);
    return hasGoalContextContractHistory(contextEntries) || hasGoalContextContractHistory(historyEntries);
  }

  async sendOwnedGoalPrompt(
    ctx: StatusContext,
    goalId: string,
    prompt: string,
    resetSafetyEpoch = true,
    isCurrent?: () => boolean,
  ) {
    if (this.activeGoal?.id !== goalId || !isActiveGoal(this.activeGoal)) return false;
    const pending = this.rememberPendingGoalPrompt(goalId, prompt, resetSafetyEpoch);
    const sent = await sendPrompt(this.pi, ctx, pending.prompt, isCurrent);
    if (!sent || (isCurrent && !isCurrent()) || this.activeGoal?.id !== goalId || !isActiveGoal(this.activeGoal)) {
      this.pendingGoalPromptMarkers.delete(pending.marker);
      return false;
    }
    return true;
  }

  cancelContinuationWork() {
    this.clearContinuationDispatchTimer();
    if (this.continuationDelivery) {
      this.rememberCancelledContinuationMarker(this.continuationDelivery);
    }
    this.continuationIntent = undefined;
    this.continuationDelivery = undefined;
  }

  scheduleContinuationDispatch(ctx: StatusContext, goalId: string) {
    this.clearContinuationDispatchTimer();
    const generation = this.sessionGeneration;
    this.continuationDispatchTimer = setTimeout(() => {
      this.continuationDispatchTimer = undefined;
      if (generation !== this.sessionGeneration || this.activeGoal?.id !== goalId || !isActiveGoal(this.activeGoal)) {
        return;
      }
      this.dispatchContinuationIfSettled(ctx);
    }, 0);
  }

  private clearContinuationDispatchTimer() {
    if (!this.continuationDispatchTimer) return;
    clearTimeout(this.continuationDispatchTimer);
    this.continuationDispatchTimer = undefined;
  }

  consumeCancelledGoalPrompt(prompt: string) {
    const marker = extractGoalPromptMarker(prompt);
    if (!marker) return false;
    const cancelledPrompt = this.cancelledGoalPromptMarkers.get(marker);
    if (!cancelledPrompt || !preservesOwnedPromptAtTerminalBoundary(prompt, cancelledPrompt)) {
      return false;
    }
    this.cancelledGoalPromptMarkers.delete(marker);
    return true;
  }

  consumeCancelledContinuationPrompt(prompt: string) {
    const marker = extractContinuationMarker(prompt);
    if (!marker) return false;
    const cancelledPrompt = this.cancelledContinuationMarkers.get(marker);
    if (!cancelledPrompt || !preservesOwnedPromptAtTerminalBoundary(prompt, cancelledPrompt)) {
      return false;
    }
    this.cancelledContinuationMarkers.delete(marker);
    return true;
  }

  acceptOwnedInputBoundary(prompt: string) {
    const fingerprint = inputFingerprint(prompt);
    const goalMarker = extractGoalPromptMarker(prompt);
    if (goalMarker) {
      const pending = this.pendingGoalPromptMarkers.get(goalMarker);
      if (pending && preservesOwnedPromptAtTerminalBoundary(prompt, pending.prompt)) return true;
      if (this.claimedGoalPromptMarkers.get(goalMarker) === fingerprint) return true;
    }
    const continuationMarker = extractContinuationMarker(prompt);
    if (!continuationMarker) return false;
    if (
      this.continuationDelivery?.marker === continuationMarker &&
      preservesOwnedPromptAtTerminalBoundary(prompt, this.continuationDelivery.prompt)
    ) {
      return true;
    }
    return this.claimedContinuationMarkers.get(continuationMarker) === fingerprint;
  }

  supersedeOwnedInputCollision(prompt: string) {
    const fingerprint = inputFingerprint(prompt);
    const goalMarker = extractGoalPromptMarker(prompt);
    if (goalMarker) {
      const pending = this.pendingGoalPromptMarkers.get(goalMarker);
      if (pending && pending.fingerprint !== fingerprint) {
        this.pendingGoalPromptMarkers.delete(goalMarker);
        this.rememberCancelledGoalPromptMarker(goalMarker, pending.prompt);
      }
      this.claimedGoalPromptMarkers.delete(goalMarker);
    }
    const continuationMarker = extractContinuationMarker(prompt);
    if (!continuationMarker) return;
    if (
      (this.continuationDelivery?.marker === continuationMarker &&
        !preservesOwnedPromptAtTerminalBoundary(prompt, this.continuationDelivery.prompt)) ||
      this.continuationIntent?.marker === continuationMarker
    ) {
      this.cancelContinuationWork();
    }
    this.claimedContinuationMarkers.delete(continuationMarker);
  }

  hasOwnedPromptBoundary(prompt: string) {
    const fingerprint = inputFingerprint(prompt);
    const goalMarker = extractGoalPromptMarker(prompt);
    if (goalMarker) {
      const pending = this.pendingGoalPromptMarkers.get(goalMarker);
      if (
        (pending && preservesOwnedPromptAtTerminalBoundary(prompt, pending.prompt)) ||
        this.claimedGoalPromptMarkers.get(goalMarker) === fingerprint
      ) {
        return true;
      }
    }
    const continuationMarker = extractContinuationMarker(prompt);
    if (!continuationMarker) return false;
    return (
      (this.continuationDelivery?.marker === continuationMarker &&
        preservesOwnedPromptAtTerminalBoundary(prompt, this.continuationDelivery.prompt)) ||
      this.claimedContinuationMarkers.get(continuationMarker) === fingerprint
    );
  }

  consumeStaleOwnedGoalPrompt(prompt: string) {
    const marker = extractGoalPromptMarker(prompt);
    if (!marker) return false;
    const pending = this.pendingGoalPromptMarkers.get(marker);
    if (!pending || !preservesOwnedPromptAtTerminalBoundary(prompt, pending.prompt)) return false;
    if (this.activeGoal?.id === pending.goalId && this.activeGoal.status === "active") {
      return false;
    }
    this.pendingGoalPromptMarkers.delete(marker);
    return true;
  }

  noteQueuedNonGoalInput(prompt: string, behavior: "steer" | "followUp", resetSafetyEpoch = false) {
    this.pendingNonGoalInputs.push({
      behavior,
      fingerprint: inputFingerprint(prompt),
      resetSafetyEpoch,
    });
    if (this.pendingNonGoalInputs.length > MAX_PENDING_NON_GOAL_INPUTS) {
      this.pendingNonGoalInputs.shift();
    }
  }

  consumeQueuedNonGoalInput(prompt: string, allowDeliveryFallback = true) {
    if (typeof prompt !== "string") return undefined;
    const fingerprint = inputFingerprint(prompt);
    // Pi delivers steers before follow-ups. Prefer a matching steer even when an
    // identical follow-up was queued first so it cannot steal follow-up ownership.
    const steerIndex = this.pendingNonGoalInputs.findIndex(
      (pending) => pending.behavior === "steer" && pending.fingerprint === fingerprint,
    );
    const exactIndex =
      steerIndex >= 0
        ? steerIndex
        : this.pendingNonGoalInputs.findIndex(
            (pending) => pending.behavior === "followUp" && pending.fingerprint === fingerprint,
          );
    if (exactIndex >= 0) return this.pendingNonGoalInputs.splice(exactIndex, 1)[0];
    if (!allowDeliveryFallback) return undefined;

    // Skills, templates, and later input handlers can transform the raw text after
    // pi-goal records it. Fall back to Pi's delivery priority as a bounded marker:
    // steers drain before follow-ups, and settlement clears stale entries.
    const fallbackSteerIndex = this.pendingNonGoalInputs.findIndex((pending) => pending.behavior === "steer");
    const fallbackIndex =
      fallbackSteerIndex >= 0
        ? fallbackSteerIndex
        : this.pendingNonGoalInputs.findIndex((pending) => pending.behavior === "followUp");
    if (fallbackIndex < 0) return undefined;
    return this.pendingNonGoalInputs.splice(fallbackIndex, 1)[0];
  }

  consumeQueuedNonGoalFollowUpForAgentStart() {
    // A pending steer owns the next intra-run boundary. Do not let a later
    // follow-up suppress cleanup until all earlier-priority steers have started.
    if (this.pendingNonGoalInputs.some((pending) => pending.behavior === "steer")) return false;
    const index = this.pendingNonGoalInputs.findIndex((pending) => pending.behavior === "followUp");
    if (index < 0) return false;
    this.pendingNonGoalInputs.splice(index, 1);
    return true;
  }

  markContinuationStarted(prompt: string) {
    const marker = extractContinuationMarker(prompt);
    if (!marker) {
      // A user, retry, or another extension started newer work. Cancel both an
      // unsent intent and a delivery that may have lost the non-atomic idle race;
      // the newer work's agent_end will record a fresh intent.
      this.cancelContinuationWork();
      return undefined;
    }
    const fingerprint = inputFingerprint(prompt);
    if (this.continuationDelivery?.marker === marker) {
      const delivery = this.continuationDelivery;
      if (preservesOwnedPromptAtTerminalBoundary(prompt, delivery.prompt)) {
        this.continuationDelivery = undefined;
        this.rememberClaimedContinuationMarker(marker, prompt);
        return marker.split(":", 1)[0];
      }
    }
    const cancelledPrompt = this.cancelledContinuationMarkers.get(marker);
    if (
      this.claimedContinuationMarkers.get(marker) === fingerprint ||
      (cancelledPrompt && preservesOwnedPromptAtTerminalBoundary(prompt, cancelledPrompt))
    ) {
      return marker.split(":", 1)[0];
    }
    this.cancelContinuationWork();
    return undefined;
  }

  persistGoal(goal: ActiveGoal) {
    this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, serializeGoalState(goal));
  }

  clearPersistedGoal() {
    this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, serializeGoalState(undefined));
  }

  clearActiveGoal(ctx: StatusContext) {
    this.clearActiveGoalState(ctx);
    this.ensureGoalContract(ctx);
  }

  clearCompletedGoal(ctx: StatusContext) {
    this.clearActiveGoalState(ctx);
  }

  private clearActiveGoalState(ctx: StatusContext) {
    this.clearGoalWaitTimer();
    this.cancelContinuationWork();
    this.clearGoalRecovery();
    this.clearStaleGoalToolCallBlock();
    this.activeGoal = undefined;
    this.clearPersistedGoal();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  pauseGoalForUnavailableTools(ctx: StatusContext, abortTurn = true, recordUsage = true) {
    const goal = this.activeGoal;
    if (goal?.status !== "active") return false;
    const stoppedGoal = this.stopActiveGoal(ctx, {
      kind: "tools_unavailable",
      expectedGoalId: goal.id,
      abortTurn,
      recordUsage,
    });
    if (!stoppedGoal) return false;
    notifyTerminal(
      ctx.ui,
      "Goal tools are unavailable, so the active goal was paused. Restore the tools and run /goal resume.",
      "warning",
    );
    return true;
  }

  showCompletionStatus(ctx: StatusContext) {
    this.clearCompletionStatusTimer();
    ctx.ui.setStatus(STATUS_KEY, "complete");
    this.completionStatusTimer = setTimeout(() => {
      this.completionStatusTimer = undefined;
      try {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      } catch {
        // The completion status is best-effort; the captured ctx may be stale after
        // session replacement or reload before this timer fires.
      }
    }, 8_000);
  }

  clearCompletionStatusTimer() {
    if (!this.completionStatusTimer) return;
    clearTimeout(this.completionStatusTimer);
    this.completionStatusTimer = undefined;
  }

  private rememberPendingGoalPrompt(goalId: string, prompt: string, resetSafetyEpoch: boolean) {
    const marker = randomUUID();
    const ownedPrompt = appendGoalPromptMarker(prompt, marker);
    this.pendingGoalPromptMarkers.set(marker, {
      goalId,
      resetSafetyEpoch,
      fingerprint: inputFingerprint(ownedPrompt),
      prompt: ownedPrompt,
    });
    if (this.pendingGoalPromptMarkers.size > MAX_PENDING_GOAL_PROMPTS) {
      const oldest = this.pendingGoalPromptMarkers.keys().next().value;
      if (oldest) this.pendingGoalPromptMarkers.delete(oldest);
    }
    return { marker, prompt: ownedPrompt };
  }

  consumeOwnedGoalPrompt(prompt: string) {
    const marker = extractGoalPromptMarker(prompt);
    if (!marker) return undefined;
    const pending = this.pendingGoalPromptMarkers.get(marker);
    if (!pending || !preservesOwnedPromptAtTerminalBoundary(prompt, pending.prompt)) {
      return undefined;
    }
    this.pendingGoalPromptMarkers.delete(marker);
    this.rememberClaimedGoalPromptMarker(marker, inputFingerprint(prompt));
    return pending;
  }

  private rememberCancelledGoalPromptMarker(marker: string, prompt: string) {
    this.cancelledGoalPromptMarkers.set(marker, prompt);
    if (this.cancelledGoalPromptMarkers.size <= MAX_PENDING_GOAL_PROMPTS) return;
    const oldest = this.cancelledGoalPromptMarkers.keys().next().value;
    if (oldest) this.cancelledGoalPromptMarkers.delete(oldest);
  }

  private rememberClaimedGoalPromptMarker(marker: string, fingerprint: string) {
    this.claimedGoalPromptMarkers.set(marker, fingerprint);
    if (this.claimedGoalPromptMarkers.size <= MAX_PENDING_GOAL_PROMPTS) return;
    const oldest = this.claimedGoalPromptMarkers.keys().next().value;
    if (oldest) this.claimedGoalPromptMarkers.delete(oldest);
  }

  private rememberClaimedContinuationMarker(marker: string, prompt: string) {
    this.claimedContinuationMarkers.set(marker, inputFingerprint(prompt));
    if (this.claimedContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
    const oldest = this.claimedContinuationMarkers.keys().next().value;
    if (oldest) this.claimedContinuationMarkers.delete(oldest);
  }

  private rememberCancelledContinuationMarker(ticket: ContinuationTicket) {
    this.cancelledContinuationMarkers.set(ticket.marker, ticket.prompt);
    if (this.cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
    const oldest = this.cancelledContinuationMarkers.keys().next().value;
    if (oldest) this.cancelledContinuationMarkers.delete(oldest);
  }
}

export function createGoal(text: string, objectiveFile?: ObjectiveFile): ActiveGoal {
  const now = Date.now();
  return {
    id: randomUUID(),
    text,
    ...(objectiveFile ? { objectiveFile } : {}),
    status: "active",
    startedAt: now,
    updatedAt: now,
    iteration: 0,
    timeUsedSeconds: 0,
    activeStartedAt: now,
    toolFreeRuns: 0,
  };
}

export function resetGoalSafetyEpoch(goal: ActiveGoal): ActiveGoal {
  return { ...goal, toolFreeRuns: 0 };
}

/** Change status; leaving a stopped state drops its reason, and only an active goal can wait. */
export function transitionGoal(goal: ActiveGoal, status: GoalStatus): ActiveGoal {
  const now = Date.now();
  const next: ActiveGoal = {
    ...goal,
    status,
    updatedAt: now,
    ...(status === "active" ? { pauseReason: undefined, stopDetail: undefined } : { waiting: undefined }),
  };
  checkpointGoalActiveTime(next, now, status === "active" && !next.waiting);
  return next;
}

export function nextGoalInstance(goal: ActiveGoal): ActiveGoal {
  return { ...goal, id: randomUUID(), updatedAt: Date.now() };
}

export function editedGoalStatus(status: GoalStatus): GoalStatus {
  if (status === "paused" || status === "blocked" || status === "usage_limited") return status;
  return "active";
}

export function incrementGoal(goal: ActiveGoal): ActiveGoal {
  return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

export function formatStatus(goal: ActiveGoal | undefined) {
  if (!goal) return undefined;
  if (goal.status === "complete") return "complete";
  if (goal.waiting) return `waiting ${safeGoalMenuText(goal.waiting.reason)}`;
  if (goal.status === "paused" && goal.pauseReason && goal.pauseReason !== "user") {
    return `paused (${goal.pauseReason.replace("_", " ")})`;
  }
  if (goal.status === "usage_limited") return "usage limited";
  if (goal.status !== "active") return goal.status;
  return `active ${formatDuration(goal.timeUsedSeconds)}`;
}

export function goalSummary(goal: ActiveGoal) {
  const summary = [
    `Goal: ${goal.text}`,
    `Status: ${goal.waiting ? "waiting" : goal.status}`,
    ...(goal.waiting
      ? [
          `Waiting: ${safeGoalMenuText(goal.waiting.reason, 1_000)}`,
          ...(goal.waiting.resumeAt === undefined
            ? []
            : [`Resume deadline: ${new Date(goal.waiting.resumeAt).toISOString()}`]),
        ]
      : []),
    `Active elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
  ];
  if (goal.status === "paused" || goal.status === "blocked") {
    summary.push(`Stopped: the goal is ${stoppedGoalDescription(goal)}. Say "continue" or run /goal resume.`);
  } else if (goal.status === "usage_limited") {
    summary.push(`Stopped: provider usage limit${goal.stopDetail ? ` (${safeGoalMenuText(goal.stopDetail, 300)})` : ""}.`);
  }
  summary.push(`Commands: ${goalCommandHint(goal)}`);
  return summary.join("\n");
}

export function hasPendingMessages(ctx: StatusContext) {
  return ctx.hasPendingMessages?.() ?? false;
}

export function abortCurrentTurn(ctx: StatusContext) {
  try {
    ctx.abort?.();
  } catch {
    // Best effort: stale goal guards still prevent follow-on tool calls.
  }
}

export function blocksStaleGoalToolCalls(status: GoalStatus) {
  return status === "paused" || status === "blocked" || status === "usage_limited";
}

export function isResumableGoalStatus(status: GoalStatus) {
  return blocksStaleGoalToolCalls(status);
}

export function stoppedStatusLabel(status: GoalStatus) {
  if (status === "usage_limited") return "usage-limited";
  return status;
}

export function goalIdRejectionReason(goal: ActiveGoal, requestedGoalId: string) {
  if (!requestedGoalId) return "missing goal_id";
  if (requestedGoalId.length > MAX_GOAL_ID_LENGTH) return "goal_id is too long";
  if (requestedGoalId !== goal.id) return "goal_id does not match the active goal";
  return undefined;
}

function preservesOwnedPromptAtTerminalBoundary(prompt: string, ownedPrompt: string) {
  // Earlier input handlers may prefix a live pi-goal message before this runtime
  // can fingerprint it. Require the complete generated prompt as the terminal
  // boundary so a quoted marker or text appended by an external sender is not owned.
  return prompt === ownedPrompt || prompt.endsWith(ownedPrompt);
}

function inputFingerprint(prompt: unknown) {
  return createHash("sha256")
    .update(typeof prompt === "string" ? prompt : "", "utf8")
    .digest("hex");
}

function goalContractEntries(ctx: StatusContext) {
  const sessionManager = ctx.sessionManager as
    | {
        buildContextEntries?: () => unknown[];
        buildSessionContext?: () => { messages?: unknown[] };
        getBranch?: () => unknown[];
        getEntries?: () => unknown[];
      }
    | undefined;
  const historyEntries = sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [];
  return {
    contextEntries:
      sessionManager?.buildSessionContext?.().messages ?? sessionManager?.buildContextEntries?.() ?? historyEntries,
    historyEntries,
  };
}

async function sendPrompt(pi: ExtensionAPI, ctx: StatusContext, prompt: string, isCurrent?: () => boolean) {
  try {
    await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    return true;
  } catch (error) {
    if (!isCurrent || isCurrent()) {
      notifyWhenSessionAlive(ctx, `Goal prompt failed: ${formatError(error)}`, "error");
    }
    return false;
  }
}

// A delayed callback can outlive its session: after replacement or reload Pi
// throws a stale-context error from every ctx getter, so reporting through the
// dead session's UI must not turn into another throw inside a timer or a catch
// block.
function notifyWhenSessionAlive(ctx: StatusContext, message: string, level?: "info" | "warning" | "error") {
  try {
    notifyTerminal(ctx.ui, message, level);
  } catch (error) {
    if (!isStaleContextError(error)) throw error;
  }
}

function goalCommandHint(goal: ActiveGoal) {
  if (goal.waiting) return "/goal resume, /goal edit <objective>, /goal pause, /goal clear";
  if (goal.status === "active") return "/goal edit <objective>, /goal pause, /goal clear";
  if (isResumableGoalStatus(goal.status)) return "/goal edit <objective>, /goal resume, /goal clear";
  return "/goal edit <objective>, /goal clear";
}

function continuationMarker(goal: ActiveGoal) {
  return `${goal.id}:${goal.iteration}:${randomUUID()}`;
}

export type { AssistantMessageLike } from "./errors.js";
export {
  findFinalAssistantMessage,
  formatError,
  isGoalContextOverflow,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
  isUserInterruption,
  truncateNotification,
} from "./errors.js";
