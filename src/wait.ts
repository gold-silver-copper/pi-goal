/** A condition the extension polls while a goal waits. Exactly one of `pid` or `command`. */
export interface WakeWhen {
  pid?: number;
  command?: string;
  /** Seconds between command runs. */
  intervalSeconds?: number;
}

export interface GoalWait {
  reason: string;
  resumeAt?: number;
  wakeWhen?: WakeWhen;
}

export const MAX_GOAL_WAIT_REASON_LENGTH = 1_000;
export const MIN_GOAL_WAIT_DELAY_MS = 10_000;
export const MAX_GOAL_WAIT_DELAY_MS = 2_147_483_647;
export const DEFAULT_WAKE_INTERVAL_SECONDS = 60;
export const MIN_WAKE_INTERVAL_SECONDS = 30;
export const MAX_WAKE_COMMAND_LENGTH = 2_000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export function resolveGoalWaitDelay(resumeAfterMs: number | undefined): {
  requestedMs?: number;
  effectiveMs?: number;
} {
  if (resumeAfterMs === undefined) return {};
  return {
    requestedMs: resumeAfterMs,
    effectiveMs: Math.max(MIN_GOAL_WAIT_DELAY_MS, resumeAfterMs),
  };
}

export function createGoalWait(
  reason: string,
  resumeAfterMs: number | undefined,
  wakeWhen?: WakeWhen,
  now = Date.now(),
): GoalWait {
  const { effectiveMs } = resolveGoalWaitDelay(resumeAfterMs);
  return {
    reason,
    ...(effectiveMs === undefined ? {} : { resumeAt: now + effectiveMs }),
    ...(wakeWhen ? { wakeWhen } : {}),
  };
}

/** Validate a model-supplied wake_when. Returns the normalized condition or a rejection reason. */
export function parseWakeWhen(value: unknown): WakeWhen | string {
  if (!isRecord(value)) return "wake_when must be an object";
  const hasPid = value.pid !== undefined;
  const hasCommand = value.command !== undefined;
  if (hasPid === hasCommand) return "wake_when needs exactly one of pid or command";
  if (hasPid) {
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return "wake_when.pid must be a positive whole number";
    return { pid: value.pid as number };
  }
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!command) return "wake_when.command is empty";
  if (command.length > MAX_WAKE_COMMAND_LENGTH) return "wake_when.command is too long";
  const interval = value.interval_s ?? value.intervalSeconds;
  if (interval !== undefined && (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0)) {
    return "wake_when.interval_s must be a positive number of seconds";
  }
  return {
    command,
    intervalSeconds: Math.max(MIN_WAKE_INTERVAL_SECONDS, Math.round((interval as number | undefined) ?? DEFAULT_WAKE_INTERVAL_SECONDS)),
  };
}

export function describeWakeWhen(wake: WakeWhen) {
  return wake.pid !== undefined ? `process ${wake.pid} exits` : `\`${wake.command}\` exits 0 (checked every ${wake.intervalSeconds}s)`;
}

export function normalizeGoalWait(value: unknown): GoalWait | undefined {
  if (!isRecord(value)) return undefined;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!reason || reason.length > MAX_GOAL_WAIT_REASON_LENGTH) return undefined;
  const wake = value.wakeWhen === undefined ? undefined : parseWakeWhen(value.wakeWhen);
  const wakeWhen = typeof wake === "object" ? wake : undefined;
  if (!Object.hasOwn(value, "resumeAt") || value.resumeAt === undefined) {
    return { reason, ...(wakeWhen ? { wakeWhen } : {}) };
  }
  if (
    typeof value.resumeAt !== "number" ||
    !Number.isSafeInteger(value.resumeAt) ||
    value.resumeAt < 0 ||
    value.resumeAt > MAX_DATE_TIMESTAMP_MS
  ) {
    return undefined;
  }
  return { reason, resumeAt: value.resumeAt, ...(wakeWhen ? { wakeWhen } : {}) };
}

export class GoalWaitTimer {
  private generation = 0;
  private timer?: NodeJS.Timeout;

  clear() {
    this.generation += 1;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  schedule(resumeAt: number, onDue: () => void) {
    this.clear();
    const generation = this.generation;
    const delay = Math.max(0, Math.min(MAX_GOAL_WAIT_DELAY_MS, resumeAt - Date.now()));
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.timer = undefined;
      onDue();
    }, delay);
    // A deadline hours away must not keep a finished pi process (print mode, tests) alive.
    this.timer.unref?.();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
