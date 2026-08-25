import type { GoalPromptContext } from "./prompts.js";
import { buildGoalContextPrompt } from "./prompts.js";

export const GOAL_CONTRACT_MESSAGE_TYPE = "goal-contract";
export const GOAL_CONTRACT_VERSION = 1;

interface ContractMessage {
	role?: string;
	customType?: string;
	content?: unknown;
}

interface ContractSessionEntry extends ContractMessage {
	type?: string;
	message?: unknown;
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
	const expected = createGoalContextContract(goal);
	const matchingContractIndex = messages.findIndex(
		(message) => goalContractContent(message) === expected.content,
	);
	if (matchingContractIndex >= 0) {
		if (messages.filter(isGoalContextContract).length === 1) return messages;
		return messages.filter(
			(message, index) => !isGoalContextContract(message) || index === matchingContractIndex,
		);
	}

	const withoutContracts = removeGoalContextContracts(messages);
	const summaryBoundary = leadingSummaryBoundary(withoutContracts);
	const insertionIndex = summaryBoundary > 0 ? summaryBoundary : withoutContracts.length;
	return [
		...withoutContracts.slice(0, insertionIndex),
		expected,
		...withoutContracts.slice(insertionIndex),
	];
}

export function removeGoalContextContracts(messages: unknown[]) {
	return messages.some(isGoalContextContract)
		? messages.filter((message) => !isGoalContextContract(message))
		: messages;
}

export function hasGoalContextContract(entries: unknown[], goal: GoalPromptContext) {
	const expectedContent = createGoalContextContract(goal).content;
	return entries.some((entry) => goalContractContent(entry) === expectedContent);
}

export function isGoalContextContract(message: unknown) {
	return unwrapMessage(message).customType === GOAL_CONTRACT_MESSAGE_TYPE;
}

function goalContractContent(message: unknown) {
	return isGoalContextContract(message) ? unwrapMessage(message).content : undefined;
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
	const entry = message as ContractSessionEntry | undefined;
	if (entry?.type === "custom_message") return entry;
	return (entry?.message ?? message ?? {}) as ContractMessage;
}
