const MAX_OBJECTIVE_LENGTH = 4_000;

export interface CommandResult {
  kind: "start" | "pause" | "resume" | "clear" | "show" | "edit";
  objective?: string;
  /** Replace an unfinished goal without asking (the only way to replace one in print and JSON modes). */
  force?: boolean;
}

export interface GoalArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

const GOAL_ARGUMENT_COMPLETIONS: readonly GoalArgumentCompletion[] = [
  { value: "status", label: "status", description: "Show the current goal and its progress notes" },
  { value: "pause", label: "pause", description: "Pause the active goal" },
  { value: "resume", label: "resume", description: "Resume a paused or blocked goal, or wake a waiting one" },
  { value: "edit", label: "edit", description: "Replace the current goal's objective" },
  { value: "clear", label: "clear", description: "Clear the current goal" },
];

export function completeGoalArguments(argumentPrefix: string): GoalArgumentCompletion[] | null {
  const prefix = argumentPrefix.trimStart();
  if (prefix === "") return [...GOAL_ARGUMENT_COMPLETIONS];
  if (/\s/.test(prefix)) return null;
  const matches = GOAL_ARGUMENT_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
  return matches.length > 0 ? matches : null;
}

export function parseCommand(args: string): CommandResult | string {
  const tokens = tokenize(args.trim());
  if (tokens.length === 0) return { kind: "show" };
  const [first, ...rest] = tokens;
  if (first === "pause") return rest.length === 0 ? { kind: "pause" } : "Usage: /goal pause";
  if (first === "resume") return rest.length === 0 ? { kind: "resume" } : "Usage: /goal resume";
  if (first === "clear" || first === "stop") return rest.length === 0 ? { kind: "clear" } : "Usage: /goal clear";
  if (first === "status") return rest.length === 0 ? { kind: "show" } : "Usage: /goal status";
  if (first === "edit") {
    return rest.length > 0 ? { kind: "edit", objective: rest.join(" ") } : "Usage: /goal edit <objective>";
  }
  if (first === "--force") {
    return rest.length > 0 ? { kind: "start", objective: rest.join(" "), force: true } : "Usage: /goal --force <objective>";
  }
  return { kind: "start", objective: tokens.join(" ") };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function validateObjective(objective: string): string | undefined {
  const trimmed = objective.trim();
  if (!trimmed) return "Usage: /goal <objective>";
  if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
    return `Goal objective is too long (${trimmed.length}/${MAX_OBJECTIVE_LENGTH} characters). Put long instructions in a file and run /goal <path>.`;
  }
  return undefined;
}
