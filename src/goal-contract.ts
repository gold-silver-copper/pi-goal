import type { GoalPromptContext } from "./prompts.js";
import { buildGoalContextPrompt } from "./prompts.js";

export const GOAL_CONTRACT_MESSAGE_TYPE = "goal-contract";
export const GOAL_CONTRACT_VERSION = 1;

interface ContractMessage {
	role?: string;
	customType?: string;
	content?: unknown;
}

export function createGoalContextContract(goal: GoalPromptContext) {
	return {
		role: "custom" as const,
		customType: GOAL_CONTRACT_MESSAGE_TYPE,
		content: buildGoalContextPrompt(goal),
		display: false,
		details: { version: GOAL_CONTRACT_VERSION, goalId: goal.id },
		timestamp: 0,
	};
}

export function reconcileGoalContextContract(messages: unknown[], goal: GoalPromptContext) {
	const summaryBoundary = leadingSummaryBoundary(messages);
	const expected = createGoalContextContract(goal);
	const contractIndexes = messages.flatMap((message, index) =>
		unwrapMessage(message).customType === GOAL_CONTRACT_MESSAGE_TYPE ? [index] : [],
	);
	if (
		contractIndexes.length === 1 &&
		contractIndexes[0] === summaryBoundary &&
		unwrapMessage(messages[summaryBoundary]).content === expected.content
	) {
		return messages;
	}

	const withoutContracts = messages.filter(
		(message) => unwrapMessage(message).customType !== GOAL_CONTRACT_MESSAGE_TYPE,
	);
	const insertionIndex = leadingSummaryBoundary(withoutContracts);
	return [
		...withoutContracts.slice(0, insertionIndex),
		expected,
		...withoutContracts.slice(insertionIndex),
	];
}

function leadingSummaryBoundary(messages: readonly unknown[]) {
	let index = 0;
	while (index < messages.length) {
		const role = unwrapMessage(messages[index]).role;
		if (role !== "compactionSummary" && role !== "branchSummary") break;
		index += 1;
	}
	return index;
}

function unwrapMessage(message: unknown): ContractMessage {
	const entry = message as { message?: unknown } | undefined;
	return (entry?.message ?? message ?? {}) as ContractMessage;
}
