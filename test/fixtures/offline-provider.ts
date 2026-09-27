/**
 * Development aid, never loaded by the package: an offline, scripted model for
 * driving pi by hand or in a pty without calling a real model.
 *
 *   pi -e src/index.ts -e test/fixtures/offline-provider.ts --model offline/echo
 *
 * OFFLINE_SCRIPT names a JSON file holding an array of steps; each request uses the
 * next one:
 *   { "text": "..." }                                      a plain reply
 *   { "tools": [{ "name": "goal_progress", "args": {} }] }  tool calls; the string
 *       "$GOAL_ID" anywhere in args becomes the latest <goal_id> in the context
 *   { "error": "message" }                                  an error reply
 * Without a script, or once it runs out, every request gets "Offline reply N.".
 * OFFLINE_RECORD_DIR, when set, receives each request's context as context-<n>.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Step {
  text?: string;
  error?: string;
  tools?: Array<{ name: string; args: Record<string, unknown> }>;
}

export default function offlineProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: "offline", models: [{ id: "echo" }] });
  const recordDir = process.env.OFFLINE_RECORD_DIR;
  const scriptPath = process.env.OFFLINE_SCRIPT;
  const script: Step[] = scriptPath ? JSON.parse(fs.readFileSync(scriptPath, "utf8")) : [];
  let n = 0;
  const reply = (context: { messages: unknown[] }) => {
    n += 1;
    if (recordDir) {
      fs.mkdirSync(recordDir, { recursive: true });
      fs.writeFileSync(path.join(recordDir, `context-${n}.json`), JSON.stringify(context, null, 1));
    }
    const step = script[n - 1];
    if (!step) return fauxAssistantMessage(`Offline reply ${n}.`);
    if (step.error !== undefined) return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.error });
    if (step.tools) {
      const goalId = latestGoalId(context.messages) ?? "no-goal-id";
      return fauxAssistantMessage(
        step.tools.map((tool) => fauxToolCall(tool.name, substitute(tool.args, goalId) as Parameters<typeof fauxToolCall>[1])),
      );
    }
    return fauxAssistantMessage(step.text ?? "");
  };
  faux.setResponses(Array.from({ length: 500 }, () => reply));
  pi.registerProvider(faux.provider);
}

function latestGoalId(messages: unknown[]) {
  const text = messages.map(messageText).join("\n");
  return [...text.matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/gu)].at(-1)?.[1];
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function substitute(value: unknown, goalId: string): unknown {
  if (typeof value === "string") return value.replaceAll("$GOAL_ID", goalId);
  if (Array.isArray(value)) return value.map((item) => substitute(item, goalId));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, goalId)]));
  }
  return value;
}
