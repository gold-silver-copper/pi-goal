import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_COMPLETE_TOOL = "goal_complete";
export const GOAL_BLOCKED_TOOL = "goal_blocked";
export const GOAL_WAIT_TOOL = "goal_wait";
export const GOAL_RESUME_TOOL = "goal_resume";
export const GOAL_PROGRESS_TOOL = "goal_progress";
export const GOAL_TOOL_NAMES = [
  GOAL_COMPLETE_TOOL,
  GOAL_BLOCKED_TOOL,
  GOAL_WAIT_TOOL,
  GOAL_PROGRESS_TOOL,
  GOAL_RESUME_TOOL,
] as const;

/** A goal can only finish through goal_complete, so a policy that hides it makes Goal mode unusable. */
export function goalToolsAvailable(pi: Pick<ExtensionAPI, "getActiveTools">) {
  return pi.getActiveTools().includes(GOAL_COMPLETE_TOOL);
}

export function assertGoalToolsAvailable(pi: Pick<ExtensionAPI, "getActiveTools">) {
  if (goalToolsAvailable(pi)) return;
  throw new Error(
    "goal_complete is unavailable; include it in the active tool allowlist or leave the restrictive tool mode first.",
  );
}
