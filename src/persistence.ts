import { isNonNegativeFiniteNumber, nonNegativeFiniteNumber } from "./accounting.js";
import { isUserAbort } from "./errors.js";
import { normalizeObjectiveFile, type ObjectiveFile } from "./objective-file.js";
import type { GoalStatus, PauseReason } from "./prompts.js";
import { type GoalWait, normalizeGoalWait } from "./wait.js";

export const GOAL_STATE_ENTRY_TYPE = "goal-state";
const MAX_OBJECTIVE_LENGTH = 4_000;
export const MAX_STOP_DETAIL_LENGTH = 300;
const PAUSE_REASONS = new Set<PauseReason>(["user", "interrupted", "error", "no_progress", "time_limit", "tools_unavailable"]);

export interface ActiveGoal {
  id: string;
  text: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  iteration: number;
  timeUsedSeconds: number;
  activeStartedAt?: number;
  /** Consecutive automatic continuations that ended without any tool call. */
  toolFreeRuns: number;
  pauseReason?: PauseReason;
  /** Error text for an `error` pause, or the blocker reason for a blocked goal. */
  stopDetail?: string;
  /** Set when the objective is a prompt file. */
  objectiveFile?: ObjectiveFile;
  waiting?: GoalWait;
}

export interface GoalStateEntryData {
  goal: ActiveGoal | null;
}

interface SessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
}

interface SessionContext {
  sessionManager?: {
    getBranch?: () => SessionEntry[];
    getEntries?: () => SessionEntry[];
  };
}

const STORED_STATUSES = new Set(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]);

export function serializeGoalState(goal: ActiveGoal | undefined): GoalStateEntryData {
  return { goal: goal ?? null };
}

/** Restore the latest `goal-state` entry on the branch. Reads entries written by this package and by pi-goal 0.54.8. */
export function loadGoalStateFromSession(ctx: SessionContext): ActiveGoal | undefined {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  let latest: SessionEntry | undefined;
  let assistantBeforeLatest: SessionEntry["message"];
  let lastAssistant: SessionEntry["message"];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant") lastAssistant = entry.message;
    if (entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE) {
      latest = entry;
      assistantBeforeLatest = lastAssistant;
    }
  }
  if (!latest || !isRecord(latest.data)) return undefined;
  const goal = normalizeLoadedGoal(latest.data.goal);
  if (!goal || goal.status === "complete") return undefined;
  return reclassifyInterruptedGoal(goal, assistantBeforeLatest);
}

/**
 * pi-goal 0.54.8 recorded a user's Esc as "blocked" when the provider reported the
 * abort as an error, and it kept no pause reason. The assistant message that ended
 * the run says what happened.
 */
function reclassifyInterruptedGoal(goal: ActiveGoal, assistant: SessionEntry["message"]): ActiveGoal {
  if (goal.pauseReason || (goal.status !== "blocked" && goal.status !== "paused")) return goal;
  const aborted =
    assistant?.stopReason === "aborted" ||
    (assistant?.stopReason === "error" && typeof assistant.errorMessage === "string" && isUserAbort(assistant.errorMessage));
  if (!aborted) return goal;
  return { ...goal, status: "paused", pauseReason: "interrupted", stopDetail: undefined };
}

export function normalizeLoadedGoal(value: unknown): ActiveGoal | undefined {
  if (!isRecord(value)) return undefined;
  const { id, text } = value;
  if (typeof id !== "string" || !id || id !== id.trim()) return undefined;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_OBJECTIVE_LENGTH) return undefined;
  if (!STORED_STATUSES.has(String(value.status))) return undefined;
  // Token budgets were removed; a budget-limited goal from 0.54.8 comes back paused.
  const status = (value.status === "budget_limited" ? "paused" : value.status) as GoalStatus;
  const now = Date.now();
  const waiting = status === "active" ? normalizeGoalWait(value.waiting) : undefined;
  return {
    id,
    text,
    status,
    startedAt: isNonNegativeFiniteNumber(value.startedAt) ? value.startedAt : now,
    updatedAt: isNonNegativeFiniteNumber(value.updatedAt) ? value.updatedAt : now,
    iteration: Math.floor(nonNegativeFiniteNumber(value.iteration)),
    timeUsedSeconds: nonNegativeFiniteNumber(value.timeUsedSeconds),
    activeStartedAt: status === "active" && !waiting ? now : undefined,
    toolFreeRuns: Math.floor(nonNegativeFiniteNumber(value.toolFreeRuns)),
    pauseReason: normalizePauseReason(value, status),
    stopDetail:
      typeof value.stopDetail === "string" && value.stopDetail.trim()
        ? value.stopDetail.slice(0, MAX_STOP_DETAIL_LENGTH)
        : undefined,
    objectiveFile: normalizeObjectiveFile(value.objectiveFile),
    waiting,
  };
}

function normalizePauseReason(value: Record<string, unknown>, status: GoalStatus): PauseReason | undefined {
  if (status !== "paused") return undefined;
  if (PAUSE_REASONS.has(value.pauseReason as PauseReason)) return value.pauseReason as PauseReason;
  // 0.54.8 recorded only its safety causes.
  return value.safetyPauseCause === "no_progress" ? "no_progress" : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
