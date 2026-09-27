import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** A goal whose objective is a prompt file: its absolute path and the sha256 of its contents at the start. */
export interface ObjectiveFile {
  path: string;
  sha256: string;
  /** Set when a contract written later found different contents. */
  changed?: boolean;
}

/**
 * Recognize `/goal <path>` and `/goal execute <path>` where the path names an existing
 * file. Relative paths resolve against `cwd` and `~` expands to the home directory.
 * Trailing sentence punctuation ("prompt.md." or "prompt.md:") is tolerated.
 */
export function resolveObjectiveFile(objective: string, cwd: string): ObjectiveFile | undefined {
  const candidate = objective.trim().replace(/^execute\s+/iu, "").trim();
  if (!candidate || /\s/u.test(candidate)) return undefined;
  for (const text of [candidate, candidate.replace(/[.,;:!?]+$/u, "")]) {
    const path = absolutePath(unquote(text), cwd);
    const sha256 = hashFile(path);
    if (sha256) return { path, sha256 };
  }
  return undefined;
}

/** Re-hash an objective file. Returns the updated record, or the same object when nothing changed. */
export function refreshObjectiveFile(file: ObjectiveFile): ObjectiveFile {
  const current = hashFile(file.path);
  const changed = current !== file.sha256;
  return changed === Boolean(file.changed) ? file : { ...file, changed: changed || undefined };
}

export function normalizeObjectiveFile(value: unknown): ObjectiveFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { path, sha256, changed } = value as Record<string, unknown>;
  if (typeof path !== "string" || !isAbsolute(path) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
    return undefined;
  }
  return { path, sha256, ...(changed === true ? { changed: true } : {}) };
}

function hashFile(path: string) {
  try {
    if (!statSync(path).isFile()) return undefined;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function absolutePath(path: string, cwd: string) {
  if (path === "~" || path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}

function unquote(text: string) {
  return text.replace(/^(['"`])(.*)\1$/u, "$2");
}
