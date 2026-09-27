import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeGoalArguments, parseCommand } from "./command.js";
import { type GoalCommandController, report } from "./commands.js";
import { isStaleContextError, safeTerminalText } from "./errors.js";

export function registerGoalCommand(pi: ExtensionAPI, commands: GoalCommandController) {
  pi.registerCommand("goal", {
    description: "Keep working on one objective until it is done: /goal <objective or path to a prompt file>",
    getArgumentCompletions: (prefix) => completeGoalArguments(prefix),
    handler: async (args, ctx) => {
      try {
        const result = parseCommand(args);
        if (typeof result === "string") {
          if (ctx.mode === "print" || ctx.mode === "json") throw new Error(safeTerminalText(result));
          report(ctx, result, "warning");
          return;
        }
        switch (result.kind) {
          case "show":
            commands.showGoal(ctx);
            return;
          case "pause":
            commands.pauseGoal(ctx);
            return;
          case "resume":
            await commands.resumeGoal(ctx);
            return;
          case "clear":
            commands.clearGoal(ctx);
            return;
          case "edit":
            await commands.editGoal(result.objective ?? "", ctx);
            return;
          case "start":
            await commands.startGoal(result.objective ?? "", ctx, result.force);
            return;
        }
      } catch (error) {
        // Pi invalidates command ctx when the session is replaced while a
        // confirmation is still in flight. The dead session's command result is
        // discarded, so a stale context is not an error.
        if (isStaleContextError(error)) return;
        throw error;
      }
    },
  });
}
