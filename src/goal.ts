import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./command-registration.js";
import { GoalCommandController } from "./commands.js";
import { registerGoalLifecycle } from "./lifecycle.js";
import { GoalRuntime } from "./runtime.js";
import { registerGoalTools } from "./tools.js";

interface GoalOptions {
  settingsPath?: string;
}

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
  const runtime = new GoalRuntime(pi);
  registerGoalTools(pi, runtime);
  registerGoalCommand(pi, new GoalCommandController(runtime));
  registerGoalLifecycle(pi, runtime, options);
}

export { formatDuration } from "./accounting.js";
export { completeGoalArguments, parseCommand, validateObjective } from "./command.js";
export {
  findFinalAssistantMessage,
  formatStatus,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
} from "./runtime.js";
