import type { GoalPromptContext } from "./prompts.js";
import { buildGoalContextPrompt, buildPausedGoalContextPrompt } from "./prompts.js";

export const GOAL_CONTRACT_MESSAGE_TYPE = "goal-contract";
export const GOAL_CONTRACT_VERSION = 3;

const SUPERSEDES = "This Goal contract supersedes every earlier goal-contract message.";

const INACTIVE_GOAL_CONTRACT_CONTENT = [
  "Goal mode is inactive.",
  SUPERSEDES,
  "Do not treat an earlier Goal objective, goal_id, Goal-mode rule, or summary of them as current unless a later Goal contract explicitly reactivates Goal mode.",
].join("\n");

export type GoalContractState = "active" | "paused" | "inactive";

export interface GoalContractMessage {
  role: "custom";
  customType: string;
  content: string;
  display: boolean;
  details: { version: number; state: GoalContractState; goalId?: string };
  timestamp: number;
}

interface ContractMessage {
  role?: string;
  customType?: string;
  content?: unknown;
}

interface ContractSessionEntry extends ContractMessage {
  type?: string;
  message?: unknown;
}

/**
 * The contract that describes the current Goal state: an active goal, a paused or
 * blocked goal the agent may resume when asked, or no goal at all.
 */
export function goalContractFor(goal: GoalPromptContext | undefined): GoalContractMessage {
  if (goal?.status === "active") {
    return contract(
      [SUPERSEDES, "Only the objective and goal_id in this latest Goal contract are current.", buildGoalContextPrompt(goal)].join(
        "\n\n",
      ),
      "active",
      goal.id,
    );
  }
  if (goal?.status === "paused" || goal?.status === "blocked") {
    return contract([SUPERSEDES, buildPausedGoalContextPrompt(goal)].join("\n\n"), "paused", goal.id);
  }
  return contract(INACTIVE_GOAL_CONTRACT_CONTENT, "inactive");
}

function contract(content: string, state: GoalContractState, goalId?: string): GoalContractMessage {
  return {
    role: "custom",
    customType: GOAL_CONTRACT_MESSAGE_TYPE,
    content,
    display: false,
    details: { version: GOAL_CONTRACT_VERSION, state, ...(goalId ? { goalId } : {}) },
    timestamp: 0,
  };
}

/** Whether the latest contract in these messages or entries already says exactly this. */
export function hasCurrentGoalContract(entries: readonly unknown[], expected: GoalContractMessage) {
  return latestGoalContractContent(entries) === expected.content;
}

export function hasGoalContextContractHistory(entries: readonly unknown[]) {
  return entries.some(isGoalContextContract);
}

export function isGoalContextContract(message: unknown) {
  return unwrapMessage(message).customType === GOAL_CONTRACT_MESSAGE_TYPE;
}

/**
 * Append the expected contract when the latest one differs. A first contract after a
 * compaction summary goes right after the summaries so the provider prefix stays stable.
 */
export function reconcileGoalContract(messages: unknown[], expected: GoalContractMessage) {
  if (latestGoalContractContent(messages) === expected.content) return messages;
  const summaryBoundary = leadingSummaryBoundary(messages);
  if (!hasGoalContextContractHistory(messages) && hasLeadingSummary(messages, summaryBoundary)) {
    return [...messages.slice(0, summaryBoundary), expected, ...messages.slice(summaryBoundary)];
  }
  return [...messages, expected];
}

function latestGoalContractContent(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isGoalContextContract(message)) return unwrapMessage(message).content;
  }
  return undefined;
}

function leadingSummaryBoundary(messages: readonly unknown[]) {
  let index = unwrapMessage(messages[0]).role === "system" ? 1 : 0;
  while (index < messages.length) {
    const role = unwrapMessage(messages[index]).role;
    if (role !== "compactionSummary" && role !== "branchSummary") break;
    index += 1;
  }
  return index;
}

function hasLeadingSummary(messages: readonly unknown[], boundary: number): boolean {
  const summaryStart = unwrapMessage(messages[0]).role === "system" ? 1 : 0;
  return boundary > summaryStart;
}

function unwrapMessage(message: unknown): ContractMessage {
  const entry = message as ContractSessionEntry | undefined;
  if (entry?.type === "custom_message") return entry;
  return (entry?.message ?? message ?? {}) as ContractMessage;
}
