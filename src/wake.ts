import { type ChildProcess, spawn } from "node:child_process";
import type { WakeWhen } from "./wait.js";

export interface WakeFired {
  /** What happened, e.g. "process 4242 exited". */
  description: string;
  /** The last lines of the check command's output. */
  outputTail?: string;
}

export interface WakeTiming {
  /** How often to check whether a watched process is still alive. */
  pidIntervalMs: number;
  /** Milliseconds per `interval_s` second; tests shrink it. */
  commandSecondMs: number;
  commandTimeoutMs: number;
}

export const DEFAULT_WAKE_TIMING: WakeTiming = { pidIntervalMs: 5_000, commandSecondMs: 1_000, commandTimeoutMs: 60_000 };
const OUTPUT_TAIL_LINES = 20;
const MAX_CAPTURED_OUTPUT = 64 * 1024;

/**
 * Polls one wake condition in the extension, so a waiting goal costs no model turns.
 * `clear()` cancels the timer and any running check; a stale callback does nothing.
 */
export class WakeWatcher {
  private generation = 0;
  private timer?: NodeJS.Timeout;
  private child?: ChildProcess;
  private readonly timing: () => WakeTiming;

  constructor(timing: () => WakeTiming = () => DEFAULT_WAKE_TIMING) {
    this.timing = timing;
  }

  clear() {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.child?.kill("SIGKILL");
    this.child = undefined;
  }

  watch(wake: WakeWhen, cwd: string, onFired: (fired: WakeFired) => void) {
    this.clear();
    const generation = this.generation;
    const current = () => generation === this.generation;
    const fire = (fired: WakeFired) => {
      if (!current()) return;
      this.clear();
      onFired(fired);
    };
    const timing = this.timing();

    if (wake.pid !== undefined) {
      const pid = wake.pid;
      const check = () => {
        if (!current()) return;
        if (!processExists(pid)) return fire({ description: `process ${pid} exited` });
        this.timer = setTimeout(check, timing.pidIntervalMs);
        this.timer.unref?.();
      };
      check();
      return;
    }

    const command = wake.command ?? "";
    const intervalMs = (wake.intervalSeconds ?? 60) * timing.commandSecondMs;
    const schedule = () => {
      if (!current()) return;
      this.timer = setTimeout(run, intervalMs);
      this.timer.unref?.();
    };
    const run = () => {
      if (!current()) return;
      let output = "";
      const capture = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-MAX_CAPTURED_OUTPUT);
      };
      let child: ChildProcess;
      try {
        child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        return schedule();
      }
      this.child = child;
      const killer = setTimeout(() => child.kill("SIGKILL"), timing.commandTimeoutMs);
      killer.unref?.();
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      child.on("error", () => undefined);
      child.on("close", (code) => {
        clearTimeout(killer);
        if (this.child === child) this.child = undefined;
        if (!current()) return;
        if (code === 0) return fire({ description: `\`${command}\` exited 0`, outputTail: tail(output) });
        schedule();
      });
    };
    schedule();
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tail(output: string) {
  const lines = output.trimEnd().split("\n");
  return lines.slice(-OUTPUT_TAIL_LINES).join("\n");
}
