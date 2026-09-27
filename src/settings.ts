import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const GOAL_SETTINGS_FILE = "pi-goal.json";

export interface GoalSettings {
  /** Minutes of active time between checkpoint notifications; `null` turns checkpoints off. */
  checkpointMinutes: number | null;
  /** Active hours after which the goal pauses; `null` means no limit. */
  maxActiveHours: number | null;
  notifications: boolean;
}

export const DEFAULT_GOAL_SETTINGS: GoalSettings = {
  checkpointMinutes: 120,
  maxActiveHours: null,
  notifications: true,
};

export interface GoalSettingsLoad {
  settings: GoalSettings;
  warnings: string[];
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_GOAL_SETTINGS));

export function defaultGoalSettingsPath() {
  return join(getAgentDir(), GOAL_SETTINGS_FILE);
}

/** Missing file: defaults. Unknown keys: ignored with one warning. Invalid values: default plus a warning. */
export function readGoalSettings(settingsPath = defaultGoalSettingsPath()): GoalSettingsLoad {
  let contents: string;
  try {
    contents = readFileSync(settingsPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { settings: { ...DEFAULT_GOAL_SETTINGS }, warnings: [] };
    return { settings: { ...DEFAULT_GOAL_SETTINGS }, warnings: [`${settingsPath}: ${formatError(error)}; using defaults.`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return { settings: { ...DEFAULT_GOAL_SETTINGS }, warnings: [`${settingsPath}: ${formatError(error)}; using defaults.`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { settings: { ...DEFAULT_GOAL_SETTINGS }, warnings: [`${settingsPath}: expected a JSON object; using defaults.`] };
  }
  return normalizeGoalSettings(parsed as Record<string, unknown>, settingsPath);
}

export function normalizeGoalSettings(raw: Record<string, unknown>, source = GOAL_SETTINGS_FILE): GoalSettingsLoad {
  const settings = { ...DEFAULT_GOAL_SETTINGS };
  const warnings: string[] = [];
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) warnings.push(`${source}: ignoring unknown settings ${unknown.join(", ")}.`);

  const invalid = (key: string, expected: string) =>
    warnings.push(`${source}: ${key} must be ${expected}; using ${JSON.stringify(DEFAULT_GOAL_SETTINGS[key as keyof GoalSettings])}.`);
  if (Object.hasOwn(raw, "checkpointMinutes")) {
    const value = raw.checkpointMinutes;
    if (value === null || isPositiveNumber(value)) settings.checkpointMinutes = value;
    else invalid("checkpointMinutes", "a positive number or null");
  }
  if (Object.hasOwn(raw, "maxActiveHours")) {
    const value = raw.maxActiveHours;
    if (value === null || isPositiveNumber(value)) settings.maxActiveHours = value;
    else invalid("maxActiveHours", "a positive number or null");
  }
  if (Object.hasOwn(raw, "notifications")) {
    if (typeof raw.notifications === "boolean") settings.notifications = raw.notifications;
    else invalid("notifications", "true or false");
  }
  return { settings, warnings };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
