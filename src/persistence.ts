import { isNonNegativeFiniteNumber, nonNegativeFiniteNumber } from "./accounting.js";
import { isUserAbort } from "./errors.js";
import { normalizeObjectiveFile, type ObjectiveFile } from "./objective-file.js";
import type { GoalStatus, PauseReason } from "./prompts.js";
import { type GoalWait, normalizeGoalWait } from "./wait.js";

export const GOAL_STATE_ENTRY_TYPE = "goal-state";
const MAX_OBJECTIVE_LENGTH = 4_000;
export const MAX_STOP_DETAIL_LENGTH = 300;
export const MAX_PROGRESS_NOTES = 20;
export const MAX_PROGRESS_NOTE_LENGTH = 300;

export interface ProgressNote {
  at: number;
  note: string;
}
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
  /** The last goal_progress notes, oldest first. */
  progress?: ProgressNote[];
  /** Active seconds at the last progress note or reminder. */
  progressCheckpointSeconds?: number;
  /** Active seconds when the goal was last resumed after its time limit; the limit counts from here. */
  timeLimitBaseSeconds?: number;
  waiting?: GoalWait;
}

/** Objectives longer than this are stored once per goal id; later entries leave `text` out. */
export const INLINE_OBJECTIVE_LENGTH = 200;

export interface GoalStateEntryData {
  goal: ActiveGoal | Omit<ActiveGoal, "text"> | null;
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

export function serializeGoalState(goal: ActiveGoal | undefined, omitText = false): GoalStateEntryData {
  if (!goal) return { goal: null };
  if (!omitText) return { goal };
  const { text: _text, ...rest } = goal;
  return { goal: rest };
}

/**
 * What must reach the session when it changes. Elapsed time, the iteration count and
 * timestamps are left out: they are written with the next significant change, every
 * five minutes of active time, and at shutdown.
 */
export function persistenceKey(goal: ActiveGoal) {
  return JSON.stringify([
    goal.id,
    goal.text.length,
    goal.status,
    goal.pauseReason,
    goal.stopDetail,
    goal.waiting,
    goal.objectiveFile,
    goal.toolFreeRuns,
    goal.progress?.length,
    goal.progress?.at(-1)?.at,
    goal.progressCheckpointSeconds,
    goal.timeLimitBaseSeconds,
  ]);
}

/** Restore the latest `goal-state` entry on the branch. Reads entries written by this package and by pi-goal 0.54.8. */
export function loadGoalStateFromSession(ctx: SessionContext): ActiveGoal | undefined {
  return restoreGoalState(ctx).goal;
}

/**
 * The goal to restore, and the state the session actually holds for it (before an
 * Esc-caused 0.54.8 stop is reclassified), so an unchanged goal is not written again.
 */
export function restoreGoalState(ctx: SessionContext): { goal?: ActiveGoal; stored?: ActiveGoal } {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  let latest: SessionEntry | undefined;
  let assistantBeforeLatest: SessionEntry["message"];
  let lastAssistant: SessionEntry["message"];
  const objectives = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant") lastAssistant = entry.message;
    if (entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE) {
      latest = entry;
      assistantBeforeLatest = lastAssistant;
      const stored = isRecord(entry.data) && isRecord(entry.data.goal) ? entry.data.goal : undefined;
      if (typeof stored?.id === "string" && typeof stored.text === "string") objectives.set(stored.id, stored.text);
    }
  }
  if (!latest || !isRecord(latest.data)) return {};
  const stored = latest.data.goal;
  // A long objective is written once; later entries for the same goal id leave it out.
  const withText =
    isRecord(stored) && stored.text === undefined && typeof stored.id === "string"
      ? { ...stored, text: objectives.get(stored.id) }
      : stored;
  const goal = normalizeLoadedGoal(withText);
  if (!goal || goal.status === "complete") return {};
  return { goal: reclassifyInterruptedGoal(goal, assistantBeforeLatest), stored: goal };
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
    progress: normalizeProgress(value.progress),
    progressCheckpointSeconds: isNonNegativeFiniteNumber(value.progressCheckpointSeconds)
      ? value.progressCheckpointSeconds
      : undefined,
    timeLimitBaseSeconds: isNonNegativeFiniteNumber(value.timeLimitBaseSeconds) ? value.timeLimitBaseSeconds : undefined,
    waiting,
  };
}

function normalizeProgress(value: unknown): ProgressNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes = value
    .filter(
      (item): item is ProgressNote =>
        isRecord(item) && isNonNegativeFiniteNumber(item.at) && typeof item.note === "string" && item.note.trim() !== "",
    )
    .map(({ at, note }) => ({ at, note: note.slice(0, MAX_PROGRESS_NOTE_LENGTH) }))
    .slice(-MAX_PROGRESS_NOTES);
  return notes.length > 0 ? notes : undefined;
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
