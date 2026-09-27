import { validateObjective } from "./command.js";
import { notifyTerminal, safeGoalMenuText, safeTerminalText } from "./errors.js";
import { resolveObjectiveFile } from "./objective-file.js";
import type { ActiveGoal } from "./persistence.js";
import {
  buildGoalPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
  buildWaitingResumePrompt,
} from "./prompts.js";
import {
  blocksStaleGoalToolCalls,
  createGoal,
  editedGoalStatus,
  formatError,
  type GoalRuntime,
  goalSummary,
  isActiveGoal,
  isResumableGoalStatus,
  nextGoalInstance,
  resetGoalSafetyEpoch,
  STATUS_KEY,
  type StatusContext,
  stoppedStatusLabel,
  transitionGoal,
} from "./runtime.js";

// User-command mutations are kept separate from Pi event wiring. Every controller
// receives exactly one per-factory GoalRuntime, preserving session isolation.
export class GoalCommandController {
  private readonly runtime: GoalRuntime;

  constructor(runtime: GoalRuntime) {
    this.runtime = runtime;
  }

  async startGoal(objective: string, ctx: StatusContext, force = false) {
    const validationError = validateObjective(objective);
    if (validationError) return report(ctx, validationError, "warning");

    const existingGoal = this.runtime.activeGoal?.status !== "complete" ? this.runtime.activeGoal : undefined;
    if (existingGoal && !force) {
      if (isNonInteractive(ctx)) {
        throw new Error(`A goal is already set: ${safeGoalMenuText(existingGoal.text)}. Use /goal --force <objective> to replace it.`);
      }
      const shouldReplace = await ctx.ui.confirm(
        "Replace goal?",
        `Current goal: ${safeGoalMenuText(existingGoal.text, 4_000)}\n\nNew goal: ${safeGoalMenuText(objective, 4_000)}`,
      );
      if (!shouldReplace) {
        notifyTerminal(ctx.ui, `Goal kept: ${existingGoal.text}`, "info");
        return;
      }
      if (this.runtime.activeGoal?.id !== existingGoal.id) {
        notifyTerminal(ctx.ui, "The active goal changed while confirmation was open. Try again.", "warning");
        return;
      }
    }

    // Tool registration keeps the Goal schema stable. A missing tool means another
    // policy or allowlist intentionally removed it, so activation must not widen it.
    try {
      this.runtime.assertGoalToolsAvailable();
    } catch (error) {
      report(ctx, `Cannot start /goal: ${formatError(error)}`, "error");
      if (isActiveGoal(existingGoal)) this.runtime.pauseGoalForUnavailableTools(ctx);
      return;
    }

    this.runtime.clearGoalWaitTimer();
    this.runtime.cancelContinuationWork();
    this.runtime.clearGoalRecovery();
    this.runtime.clearStaleGoalToolCallBlock();
    const startedGoal = createGoal(objective, resolveObjectiveFile(objective, ctx.cwd));
    this.runtime.activeGoal = startedGoal;
    this.runtime.persistGoal(startedGoal);
    this.runtime.updateStatus(ctx, startedGoal);
    const sent = await this.runtime.sendOwnedGoalPrompt(ctx, startedGoal.id, buildGoalPrompt(startedGoal));
    if (!sent) {
      if (this.runtime.activeGoal?.id === startedGoal.id) this.restoreAfterFailedDelivery(ctx, existingGoal);
      return;
    }
    if (this.runtime.activeGoal?.id !== startedGoal.id) return;
    const file = startedGoal.objectiveFile ? ` (prompt file ${startedGoal.objectiveFile.path})` : "";
    notifyTerminal(ctx.ui, `${existingGoal ? "Goal replaced" : "Goal started"}: ${objective}${file}`, "info");
  }

  pauseGoal(ctx: StatusContext) {
    const goal = this.runtime.activeGoal;
    if (!goal) return report(ctx, "No active goal.", "info");
    if (goal.status !== "active") {
      return report(ctx, `Goal is ${goal.status}; only active goals can be paused.`, "warning");
    }
    const stoppedGoal = this.runtime.stopActiveGoal(ctx, { kind: "explicit_pause", expectedGoalId: goal.id });
    if (stoppedGoal) notifyTerminal(ctx.ui, `Goal paused: ${stoppedGoal.text}`, "info");
  }

  async resumeGoal(ctx: StatusContext) {
    const stoppedGoal = this.runtime.activeGoal;
    if (!stoppedGoal) return report(ctx, "No active goal.", "info");
    if (stoppedGoal.status === "active" && stoppedGoal.waiting) return this.resumeWaitingGoal(ctx);
    if (!isResumableGoalStatus(stoppedGoal.status)) {
      return report(ctx, `Goal is ${stoppedGoal.status}; only paused, blocked, or usage-limited goals can be resumed.`, "warning");
    }
    try {
      this.runtime.assertGoalToolsAvailable();
    } catch (error) {
      return report(ctx, `Cannot resume /goal: ${formatError(error)}`, "error");
    }
    const stoppedStatus = stoppedGoal.status;
    this.runtime.cancelContinuationWork();
    this.runtime.clearGoalRecovery();
    this.runtime.clearStaleGoalToolCallBlock();
    const resumedGoal = resetGoalSafetyEpoch(transitionGoal(nextGoalInstance(stoppedGoal), "active"));
    this.runtime.activeGoal = resumedGoal;
    this.runtime.persistGoal(resumedGoal);
    this.runtime.updateStatus(ctx, resumedGoal);
    const sent = await this.runtime.sendOwnedGoalPrompt(ctx, resumedGoal.id, buildResumePrompt(resumedGoal, stoppedStatus));
    if (!sent) {
      if (this.runtime.activeGoal?.id === resumedGoal.id && this.runtime.activeGoal.status === "active") {
        this.restoreAfterFailedDelivery(ctx, stoppedGoal);
      }
      return;
    }
    notifyTerminal(ctx.ui, `Goal resumed from ${stoppedStatusLabel(stoppedStatus)}: ${resumedGoal.text}`, "info");
  }

  private async resumeWaitingGoal(ctx: StatusContext) {
    const waitingGoal = this.runtime.activeGoal;
    const waiting = waitingGoal?.waiting;
    if (waitingGoal?.status !== "active" || !waiting) return;
    try {
      this.runtime.assertGoalToolsAvailable();
    } catch (error) {
      return report(ctx, `Cannot resume /goal: ${formatError(error)}`, "error");
    }
    if (!this.runtime.clearGoalWait(ctx, waitingGoal.id)) return;
    const resumedGoal = this.runtime.activeGoal;
    if (!resumedGoal || resumedGoal.id !== waitingGoal.id || resumedGoal.status !== "active") return;
    const sent = await this.runtime.sendOwnedGoalPrompt(
      ctx,
      resumedGoal.id,
      buildWaitingResumePrompt(resumedGoal, waiting.reason),
      false,
    );
    if (!sent) {
      if (this.runtime.activeGoal?.id === waitingGoal.id) this.runtime.enterGoalWait(ctx, waitingGoal.id, waiting);
      return;
    }
    notifyTerminal(ctx.ui, `Goal resumed from waiting: ${waitingGoal.text}`, "info");
  }

  clearGoal(ctx: StatusContext) {
    const goal = this.runtime.activeGoal;
    if (!goal) {
      this.runtime.cancelContinuationWork();
      this.runtime.clearGoalRecovery();
      this.runtime.clearStaleGoalToolCallBlock();
      this.runtime.clearPersistedGoal();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return report(ctx, "No active goal.", "info");
    }
    this.runtime.clearActiveGoal(ctx);
    notifyTerminal(ctx.ui, `Goal cleared: ${goal.text}`, "warning");
  }

  async editGoal(objective: string, ctx: StatusContext) {
    const validationError = validateObjective(objective);
    if (validationError) return report(ctx, validationError, "warning");
    const currentGoal = this.runtime.activeGoal;
    if (!currentGoal) return report(ctx, "No active goal. Use /goal <objective> to start one.", "warning");

    const previousStatus = currentGoal.status;
    const intendsActive = editedGoalStatus(previousStatus) === "active";
    if (intendsActive) {
      try {
        this.runtime.assertGoalToolsAvailable();
      } catch (error) {
        report(ctx, `Cannot reactivate /goal: ${formatError(error)}`, "error");
        if (currentGoal.status === "active") this.runtime.pauseGoalForUnavailableTools(ctx);
        return;
      }
    }

    this.runtime.recordGoalTime(currentGoal);
    const previousGoal = { ...currentGoal };
    this.runtime.clearGoalWaitTimer();
    this.runtime.cancelContinuationWork();
    this.runtime.clearGoalRecovery();
    const transitionedGoal = transitionGoal(
      {
        ...nextGoalInstance(currentGoal),
        text: objective,
        objectiveFile: resolveObjectiveFile(objective, ctx.cwd),
        waiting: undefined,
      },
      editedGoalStatus(previousStatus),
    );
    const editedGoal = transitionedGoal.status === "active" ? resetGoalSafetyEpoch(transitionedGoal) : transitionedGoal;
    this.runtime.activeGoal = editedGoal;
    this.runtime.persistGoal(editedGoal);
    this.runtime.updateStatus(ctx, editedGoal);
    if (editedGoal.status === "active") {
      this.runtime.clearStaleGoalToolCallBlock();
      const sent = await this.runtime.sendOwnedGoalPrompt(ctx, editedGoal.id, buildObjectiveUpdatedPrompt(editedGoal));
      if (!sent) {
        if (this.runtime.activeGoal?.id === editedGoal.id) this.restoreAfterFailedDelivery(ctx, previousGoal);
        return;
      }
    } else if (blocksStaleGoalToolCalls(editedGoal.status)) {
      this.runtime.blockStaleGoalToolCalls();
    }
    notifyTerminal(ctx.ui, `Goal updated: ${objective}`, "info");
  }

  showGoal(ctx: StatusContext) {
    const goal = this.runtime.activeGoal;
    if (!goal) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return report(ctx, "No goal is set. Start one with /goal <objective>.", "info");
    }
    this.runtime.recordGoalTime(goal);
    this.runtime.updateStatus(ctx, goal);
    report(ctx, goalSummary(goal), "info");
  }

  /** A goal prompt could not be delivered: put back whatever was there before, or clear the new goal. */
  private restoreAfterFailedDelivery(ctx: StatusContext, previousGoal: ActiveGoal | undefined) {
    if (!previousGoal) {
      this.runtime.clearActiveGoal(ctx);
      return;
    }
    this.runtime.activeGoal = previousGoal;
    if (blocksStaleGoalToolCalls(previousGoal.status)) this.runtime.blockStaleGoalToolCalls();
    else this.runtime.clearStaleGoalToolCallBlock();
    this.runtime.persistGoal(previousGoal);
    this.runtime.updateStatus(ctx, previousGoal);
    if (isActiveGoal(previousGoal) && previousGoal.waiting) this.runtime.restoreGoalWaitTimer(ctx);
  }
}

function isNonInteractive(ctx: StatusContext) {
  return ctx.mode === "print" || ctx.mode === "json";
}

/**
 * Show a command result. Pi's print and JSON modes have no UI, so the text goes
 * to stdout in print mode and to stderr in JSON mode (stdout carries the event stream).
 */
export function report(ctx: StatusContext, message: string, level: "info" | "warning" | "error") {
  if (ctx.mode === "print") {
    process.stdout.write(`${safeTerminalText(message)}\n`);
    return;
  }
  if (ctx.mode === "json") {
    process.stderr.write(`${safeTerminalText(message)}\n`);
    return;
  }
  notifyTerminal(ctx.ui, message, level);
}
