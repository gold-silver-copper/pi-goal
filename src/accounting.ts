export interface GoalClock {
  timeUsedSeconds: number;
  activeStartedAt?: number;
}

/** Fold the running active clock into `timeUsedSeconds`, then restart or stop it. */
export function checkpointGoalActiveTime(goal: GoalClock, now: number, continueClock: boolean) {
  const accumulated = nonNegativeFiniteNumber(goal.timeUsedSeconds);
  const startedAt = goal.activeStartedAt;
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
    goal.timeUsedSeconds = accumulated + Math.max(0, now - startedAt) / 1000;
  } else {
    goal.timeUsedSeconds = accumulated;
  }
  goal.activeStartedAt = continueClock ? now : undefined;
}

/** Active seconds including the running clock, without mutating the goal. */
export function activeSeconds(goal: GoalClock, now = Date.now()) {
  const running = typeof goal.activeStartedAt === "number" ? Math.max(0, now - goal.activeStartedAt) / 1000 : 0;
  return nonNegativeFiniteNumber(goal.timeUsedSeconds) + running;
}

export function formatDuration(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(nonNegativeFiniteNumber(seconds)));
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const minutes = Math.floor(wholeSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function nonNegativeFiniteNumber(value: unknown) {
  return isNonNegativeFiniteNumber(value) ? value : 0;
}
