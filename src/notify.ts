import { spawn } from "node:child_process";

export type DesktopNotifier = (title: string, message: string) => void;

/**
 * macOS: a Notification Center banner through osascript, with the text passed as
 * arguments so it is never interpreted as AppleScript. Elsewhere: a terminal bell.
 */
export const systemNotifier: DesktopNotifier = (title, message) => {
  if (process.platform !== "darwin") {
    process.stdout.write("\u0007");
    return;
  }
  try {
    const child = spawn(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        message,
      ],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // A missing osascript must not disturb the goal.
  }
};

/** Strip control characters and bound the length; notification centers show one or two lines. */
export function notificationText(value: string, maxCharacters: number) {
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = [...text];
  return characters.length <= maxCharacters ? text : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}
