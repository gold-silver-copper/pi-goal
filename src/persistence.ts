import { isNonNegativeFiniteNumber, nonNegativeFiniteNumber } from "./accounting.js";
import type { GoalStatus } from "./prompts.js";
import { type GoalWait, normalizeGoalWait } from "./wait.js";

export const GOAL_STATE_ENTRY_TYPE = "goal-state";
const MAX_OBJECTIVE_LENGTH = 4_000;

export type SafetyPauseCause = "no_progress";

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
  safetyPauseCause?: SafetyPauseCause;
  waiting?: GoalWait;
}

export interface GoalStateEntryData {
  goal: ActiveGoal | null;
}

interface SessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
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
  const latest = entries.filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE).pop();
  if (!latest || !isRecord(latest.data)) return undefined;
  const goal = normalizeLoadedGoal(latest.data.goal);
  return goal?.status === "complete" ? undefined : goal;
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
    safetyPauseCause: value.safetyPauseCause === "no_progress" ? "no_progress" : undefined,
    waiting,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
