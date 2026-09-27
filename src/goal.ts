import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./command-registration.js";
import { GoalCommandController } from "./commands.js";
import { registerGoalLifecycle } from "./lifecycle.js";
import { GoalRuntime, type GoalRuntimeOptions } from "./runtime.js";
import { registerGoalTools } from "./tools.js";

interface GoalOptions extends GoalRuntimeOptions {
  settingsPath?: string;
}

/** Registers Goal mode. Returns the runtime so tests can inspect live state; Pi ignores it. */
export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
  const runtime = new GoalRuntime(pi, options);
  registerGoalTools(pi, runtime);
  registerGoalCommand(pi, new GoalCommandController(runtime));
  registerGoalLifecycle(pi, runtime, options);
  return runtime;
}

export { formatDuration } from "./accounting.js";
export { completeGoalArguments, parseCommand, validateObjective } from "./command.js";
export {
  findFinalAssistantMessage,
  formatStatus,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
} from "./runtime.js";
