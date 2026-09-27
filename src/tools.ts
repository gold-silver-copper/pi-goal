import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  getMarkdownTheme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { notifyTerminal, safeTerminalText } from "./errors.js";
import {
  formatStatus,
  GOAL_BLOCKED_TOOL,
  GOAL_COMPLETE_TOOL,
  GOAL_RESUME_TOOL,
  GOAL_WAIT_TOOL,
  type GoalRuntime,
  goalIdRejectionReason,
  MAX_GOAL_ID_LENGTH,
  STATUS_KEY,
  transitionGoal,
  truncateNotification,
} from "./runtime.js";
import {
  createGoalWait,
  MAX_GOAL_WAIT_DELAY_MS,
  MAX_GOAL_WAIT_REASON_LENGTH,
  MIN_GOAL_WAIT_DELAY_MS,
  resolveGoalWaitDelay,
} from "./wait.js";

interface GoalCompleteDetails {
  goal: string;
  goal_id: string;
  summary: string;
  deviations?: string;
}

interface GoalBlockedDetails {
  goal: string;
  goal_id: string;
  reason: string;
  evidence: string;
}

interface GoalWaitDetails {
  goal: string;
  goal_id: string;
  reason: string;
  requested_resume_after_ms?: number;
  resume_after_ms?: number;
  resume_at?: number;
}

const MAX_GOAL_TEXT_LENGTH = 4_000;
const MAX_COMPLETION_SUMMARY_LENGTH = 4_000;
const MAX_DEVIATIONS_LENGTH = 2_000;
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalRuntime) {
  const goalCompleteTool = defineTool({
    name: GOAL_COMPLETE_TOOL,
    label: "Goal Complete",
    description:
      "Mark an active /goal complete only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and every requirement is met and verified. List anything done differently or deliberately left out in deviations. Tool visibility alone does not activate Goal mode. Never call for ordinary work, partial progress, blockers or failures.",
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description:
          "The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
      }),
      summary: Type.String({
        minLength: 1,
        maxLength: MAX_COMPLETION_SUMMARY_LENGTH,
        description: "What was done and the evidence that verified it.",
      }),
      deviations: Type.Optional(
        Type.String({
          maxLength: MAX_DEVIATIONS_LENGTH,
          description:
            "Anything done differently from the objective or deliberately left out, each with its reason. Leave it out when there is nothing to report.",
        }),
      ),
    }),
    renderResult(result) {
      return renderGoalCompletion(result);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const completedGoal = runtime.activeGoal;
      const goal = completedGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const summary = typeof params.summary === "string" ? params.summary.trim() : "";
      const deviations = typeof params.deviations === "string" ? params.deviations.trim() : "";
      const details = completionDetails(goal, requestedGoalId, summary, deviations);
      const reject = (reason: string) => {
        const rejection = `Goal completion rejected: ${reason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return { content: toolContent(rejection), details };
      };

      if (!completedGoal) return reject("no active goal");
      if (!runtime.runOwnsGoal()) return reject("current run does not own the active goal");
      const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (completedGoal.status !== "active") return reject(`goal is ${completedGoal.status}, not active`);
      if (!summary) return reject("summary is empty");
      if (summary.length > MAX_COMPLETION_SUMMARY_LENGTH) {
        return reject(`summary is too long (${summary.length}/${MAX_COMPLETION_SUMMARY_LENGTH} characters)`);
      }
      if (deviations.length > MAX_DEVIATIONS_LENGTH) {
        return reject(`deviations is too long (${deviations.length}/${MAX_DEVIATIONS_LENGTH} characters)`);
      }

      runtime.clearGoalWaitTimer();
      runtime.activeGoal = transitionGoal(completedGoal, "complete");
      runtime.recordGoalTime(runtime.activeGoal, false);
      runtime.persistGoal(runtime.activeGoal);

      ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
      runtime.clearCompletedGoal(ctx);
      runtime.showCompletionStatus(ctx);
      notifyTerminal(ctx.ui, `Goal complete: ${goal}`, "info");

      return {
        content: toolContent(`Goal complete: ${summary}${deviations ? `\n\nDeviations:\n${deviations}` : ""}`),
        details,
        terminate: true,
      };
    },
  });

  const goalBlockedTool = defineTool({
    name: GOAL_BLOCKED_TOOL,
    label: "Goal Blocked",
    description:
      "Stop an active /goal only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and the goal cannot go forward at all without an action you cannot take, after trying reasonable alternatives. If the user can do something and you can carry on afterwards, ask in a message and call goal_wait instead. Tool visibility alone does not activate Goal mode. Never call because work is hard, slow, uncertain or failing.",
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description: "The exact goal_id shown in the current active /goal prompt.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_BLOCKER_REASON_LENGTH,
        description: "The specific user or external action required to unblock the goal.",
      }),
      evidence: Type.String({
        minLength: 1,
        maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
        description: "Concrete evidence from the attempts that shows why the goal cannot go forward.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const blockedGoal = runtime.activeGoal;
      const goal = blockedGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
      const reject = (rejectionReason: string, terminate = false) => {
        const rejection = `goal_blocked rejected: ${rejectionReason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: blockerDetails(goal, requestedGoalId, reason, evidence),
          ...(terminate ? { terminate: true as const } : {}),
        };
      };

      if (!blockedGoal) return reject("no active goal");
      if (!runtime.runOwnsGoal()) return reject("current run does not own the active goal");
      const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (blockedGoal.status !== "active") {
        return reject(`goal is ${blockedGoal.status}, not active`);
      }
      if (!reason) return reject("reason is empty");
      if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
      if (!evidence) return reject("evidence is empty");
      if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");

      const stoppedGoal = runtime.stopActiveGoal(ctx, {
        kind: "blocker_report",
        expectedGoalId: blockedGoal.id,
        reason,
      });
      if (!stoppedGoal) return reject("active goal changed before blocker transition");
      notifyTerminal(ctx.ui, `Goal blocked: ${truncateNotification(reason)}`, "warning");

      return {
        content: toolContent(`Goal blocked: ${reason}`),
        details: blockerDetails(goal, requestedGoalId, reason, evidence),
        terminate: true,
      };
    },
  });

  const goalWaitTool = defineTool({
    name: GOAL_WAIT_TOOL,
    label: "Goal Wait",
    description: `Keep an active /goal quiet only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and progress depends on an arranged external wake event or one safety deadline. Tool visibility alone does not activate Goal mode. Call goal_wait alone. Requests below ${MIN_GOAL_WAIT_DELAY_MS}ms are clamped to ${MIN_GOAL_WAIT_DELAY_MS}ms. Never call for ordinary unfinished work.`,
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description: "The exact goal_id shown in the current active /goal prompt.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_WAIT_REASON_LENGTH,
        description: "Why the goal is waiting and which external event should wake it.",
      }),
      resume_after_ms: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_GOAL_WAIT_DELAY_MS,
          description: `Optional safety deadline in milliseconds that requests one continuation if no wake message arrives. Values below ${MIN_GOAL_WAIT_DELAY_MS} are accepted but clamped to ${MIN_GOAL_WAIT_DELAY_MS}.`,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const activeGoal = runtime.activeGoal;
      const goal = activeGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const resumeAfterMs = typeof params.resume_after_ms === "number" ? params.resume_after_ms : undefined;
      const reject = (rejectionReason: string) => {
        const rejection = `goal_wait rejected: ${rejectionReason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: waitDetails(goal, requestedGoalId, reason, resumeAfterMs),
        };
      };

      if (!activeGoal) return reject("no active goal");
      if (!runtime.runOwnsGoal()) return reject("current run does not own the active goal");
      const staleGoalRejection = goalIdRejectionReason(activeGoal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (activeGoal.status !== "active") {
        return reject(`goal is ${activeGoal.status}, not active`);
      }
      if (activeGoal.waiting) return reject("goal is already waiting");
      if (!reason) return reject("reason is empty");
      if (reason.length > MAX_GOAL_WAIT_REASON_LENGTH) return reject("reason is too long");
      if (
        resumeAfterMs !== undefined &&
        (!Number.isInteger(resumeAfterMs) || resumeAfterMs < 1 || resumeAfterMs > MAX_GOAL_WAIT_DELAY_MS)
      ) {
        return reject(`resume_after_ms must be a whole number from 1 to ${MAX_GOAL_WAIT_DELAY_MS}`);
      }

      const { requestedMs, effectiveMs } = resolveGoalWaitDelay(resumeAfterMs);
      const waiting = createGoalWait(reason, resumeAfterMs);
      const waitingGoal = runtime.enterGoalWait(ctx, activeGoal.id, waiting);
      if (!waitingGoal) return reject("active goal changed before waiting transition");
      const clamped = requestedMs !== undefined && effectiveMs !== requestedMs;
      notifyTerminal(ctx.ui, `Goal waiting: ${truncateNotification(reason)}`, "info");
      return {
        content: toolContent(
          clamped
            ? `Goal waiting: ${reason}\nRequested resume_after_ms ${requestedMs} was clamped to ${effectiveMs}.`
            : `Goal waiting: ${reason}`,
        ),
        details: waitDetails(
          goal,
          requestedGoalId,
          reason,
          effectiveMs,
          waiting.resumeAt,
          clamped ? requestedMs : undefined,
        ),
        terminate: true,
      };
    },
  });

  const goalResumeTool = defineTool({
    name: GOAL_RESUME_TOOL,
    label: "Goal Resume",
    description:
      "Resume a paused or blocked /goal only when the latest Goal contract says the goal is paused, supplies the matching goal_id, and the user's latest message asks you to continue it. Tool visibility alone does not activate Goal mode. Never call it on your own initiative or for a message about something else.",
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description: "The exact goal_id shown in the paused Goal contract.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goal = runtime.activeGoal;
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const reject = (reason: string) => {
        const rejection = `goal_resume rejected: ${reason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return { content: toolContent(rejection), details: { goal_id: requestedGoalId.slice(0, MAX_GOAL_ID_LENGTH) } };
      };
      if (!goal) return reject("no goal is set");
      const staleGoalRejection = goalIdRejectionReason(goal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (goal.status !== "paused" && goal.status !== "blocked") return reject(`goal is ${goal.status}, not paused or blocked`);
      if (!runtime.directUserInput) {
        return reject("only a message from the user in this run can resume the goal");
      }
      if (!runtime.goalToolsAvailable()) return reject("goal_complete is not an active tool");
      const resumed = runtime.resumeStoppedGoal(ctx);
      if (!resumed) return reject("the goal changed before it could resume");
      notifyTerminal(ctx.ui, `Goal resumed: ${truncateNotification(resumed.text)}`, "info");
      return {
        content: toolContent(
          [
            "Goal resumed. Goal mode is active again for this objective:",
            "",
            `<goal_objective>\n${escapeXml(resumed.text)}\n</goal_objective>`,
            "",
            `goal_id: ${resumed.id}`,
            "",
            "The Goal-mode rules in the goal contract apply again. Continue from the current state of the work.",
          ].join("\n"),
        ),
        details: { goal: resumed.text.slice(0, MAX_GOAL_TEXT_LENGTH), goal_id: resumed.id },
      };
    },
  });

  pi.registerTool(goalCompleteTool);
  pi.registerTool(goalBlockedTool);
  pi.registerTool(goalWaitTool);
  pi.registerTool(goalResumeTool);
}

interface GoalCompletionRenderResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

export function goalCompletionMarkdown(result: GoalCompletionRenderResult) {
  const content = result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const completionPrefix = "Goal complete:";
  if (!content.startsWith(completionPrefix)) return content;

  const details = (result.details && typeof result.details === "object" ? result.details : {}) as {
    summary?: unknown;
    deviations?: unknown;
  };
  const summary = typeof details.summary === "string" ? details.summary : content.slice(completionPrefix.length);
  const sections = ["**Goal complete**"];
  const safeSummary = safeTerminalText(summary);
  if (safeSummary) sections.push(safeSummary);
  const safeDeviations = typeof details.deviations === "string" ? safeTerminalText(details.deviations) : "";
  if (safeDeviations) sections.push("**Deviations**", safeDeviations);
  return sections.join("\n\n");
}

export function renderGoalCompletion(result: GoalCompletionRenderResult) {
  return new Markdown(goalCompletionMarkdown(result), 0, 0, getMarkdownTheme());
}

function toolContent(text: string) {
  return [
    {
      type: "text" as const,
      text: truncateHead(safeTerminalText(text), {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      }).content,
    },
  ];
}

function completionDetails(goal: string, goalId: string, summary: string, deviations: string): GoalCompleteDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    summary: summary.slice(0, MAX_COMPLETION_SUMMARY_LENGTH),
    ...(deviations ? { deviations: deviations.slice(0, MAX_DEVIATIONS_LENGTH) } : {}),
  };
}

function blockerDetails(
  goal: string,
  goalId: string,
  reason: string,
  evidence: string,
): GoalBlockedDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
    evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
  };
}

function waitDetails(
  goal: string,
  goalId: string,
  reason: string,
  resumeAfterMs: number | undefined,
  resumeAt?: number,
  requestedResumeAfterMs?: number,
): GoalWaitDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    reason: reason.slice(0, MAX_GOAL_WAIT_REASON_LENGTH),
    ...(requestedResumeAfterMs === undefined ? {} : { requested_resume_after_ms: requestedResumeAfterMs }),
    ...(resumeAfterMs === undefined ? {} : { resume_after_ms: resumeAfterMs }),
    ...(resumeAt === undefined ? {} : { resume_at: resumeAt }),
  };
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
