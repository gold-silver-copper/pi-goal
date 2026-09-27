# pi-goal

A pi extension that keeps the agent working on one objective until it proves the objective done.

Give pi a goal with `/goal <objective>`, or point it at a prompt file with `/goal execute prompt.md`. The agent then works until it calls `goal_complete` with a summary and the evidence. When a run ends early, pi-goal continues it. It stops when the goal is complete, when the agent is blocked or waiting, or when you pause it.

Forked from [`@narumitw/pi-goal`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal) 0.54.8 (`github.com/narumiruna/pi-extensions`, `packages/pi-goal`, commit `9058c15011ed250e69b89dbd680d785a82deb87d`, MIT). See [What changed from upstream](#what-changed-from-upstream).

## Install

```bash
pi remove npm:@narumitw/pi-goal        # if installed: two /goal commands would clash
pi install git:github.com/gold-silver-copper/pi-goal
```

pi loads `src/index.ts` directly; there is no build step. Goal mode can run paid model turns for hours and uses every tool pi has.

## Using it

```text
/goal execute docs/prompt.md
/goal migrate the storage layer to the new schema and open a PR
```

- **File objective:** when the objective (after an optional `execute`) is a single path to an existing file, the goal records the file's absolute path and hash. The agent is told to read the file in full before starting and after every compaction, and is told when the file changes.
- **The goal contract:** the objective, its `goal_id` and the Goal-mode rules travel in a hidden goal contract message. The rules ask the agent to:
  - pursue the whole objective
  - verify in proportion: expensive checks once at the end, no re-runs just for "stronger evidence", nothing over 15 minutes unless required
  - post progress notes
  - wait with `wake_when` instead of sleeping
  - finish with `goal_complete`
- **Continuation:** when a run ends and the goal is still active, pi-goal sends a continuation prompt once pi is idle. Three automatic continuations in a row that use no tool pause the goal.

## Commands

| Command | What it does |
| --- | --- |
| `/goal <objective>` | Start a goal. Replacing an unfinished goal asks first in the TUI. |
| `/goal --force <objective>` | Start a goal, replacing an unfinished one without asking (needed in print and JSON modes). |
| `/goal` or `/goal status` | Show the objective, status, active time and the last 10 progress notes. Works while the agent is running. In print mode it writes to stdout; in JSON mode to stderr. |
| `/goal edit <objective>` | Replace the objective. An active goal gets the new objective at once. |
| `/goal pause` | Pause and abort the current run. |
| `/goal resume` | Resume a paused, blocked or usage-limited goal, or wake a waiting one. |
| `/goal clear` (or `stop`) | Forget the goal. |

## Tools the agent uses

The tools are always registered; the goal contract says when Goal mode is active.

| Tool | When |
| --- | --- |
| `goal_complete({ goal_id, summary, deviations? })` | Every requirement is met. `deviations` lists anything done differently or deliberately left out, each with its reason; it is shown under **Deviations**. |
| `goal_progress({ goal_id, note })` | At the start with the plan, after each milestone, and at least every 45 minutes. Up to 300 characters. The latest note shows in the status line. |
| `goal_wait({ goal_id, reason, wake_when?, resume_after_ms? })` | Progress depends on something slow or on you. See [Waiting](#waiting). |
| `goal_resume({ goal_id })` | Accepted only for a paused or blocked goal, from a run you started by typing, when your message asks to continue. |
| `goal_blocked({ goal_id, reason, evidence })` | The goal cannot move at all without an action the agent cannot take. |

## Stopping and resuming

- **Esc pauses the goal (`paused (interrupted)`).** This holds whether the provider reports the abort as `aborted`, as an error such as "This operation was aborted", or only through pi's abort signal.
- **The paused goal stays visible to the agent.** A paused contract keeps its objective. Say "continue" (or "go ahead", "keep going"…) and the agent calls `goal_resume` and carries on. Ask something else and it answers, leaving the goal paused. `/goal resume` works too.
- **Other errors:**
  - a non-retryable error pauses the goal with reason `error`
  - `blocked` is reserved for `goal_blocked` and an unrecoverable context overflow
  - an exhausted quota with no reset time is `usage limited`
- **The status line shows why:** `paused (interrupted)`, `paused (error)`, `paused (no progress)`, `paused (time limit)`, `blocked`, `usage limited`.

## Waiting

- **`wake_when: { pid }`**: pi-goal checks every 5 s and wakes the goal when the process exits.
- **`wake_when: { command, interval_s }`**: pi-goal runs the command in the working directory every `interval_s` seconds (default 60, at least 30), with a 60 s timeout. It wakes the goal when the command exits 0.
  - Example: `gh run view 123 --json status -q .status | grep -qx completed`.
  - The continuation says what fired and includes the command's last 20 output lines as untrusted data.
- **No `wake_when`:** your next message wakes the goal, and you get a "waiting on you" notification.
- **`resume_after_ms`** is a safety deadline (at least 10 s).
- **Rate and usage limits:** when a limit error names its reset time and pi's retries run out, the goal waits until 60 s after the reset. Recognized forms: "resets 1:10am (America/Los_Angeles)", `retry-after`, "try again in 3 hours", ISO-8601. Without a reset time, a retryable error waits for your next message.
- **Polling stops** when the wait ends, and on pause, clear, your input or shutdown. It restarts after a reload.

## Progress, checkpoints and notifications

- **Progress notes:**
  - The status line reads `active 1h42m · <latest note>`, and `/goal status` lists the last 10 notes with their age.
  - After 45 minutes of active time without a note, the next tool result carries one line: "No goal_progress note for 45 min."
- **Checkpoints:** every `checkpointMinutes` of active time sends a notification with the elapsed time and the latest note. With `maxActiveHours` set, the goal pauses at that much active time, counted from the last resume.
- **Desktop notifications** (macOS Notification Center, a terminal bell elsewhere; TUI only) are sent on:
  - completion and blocking
  - waiting on you, and rate-limit waits (with the resume time)
  - pauses you did not cause (error, no progress, time limit)
  - checkpoints

  The title names the project directory, since you may run several goals at once.

## Settings

`~/.pi/agent/pi-goal.json` (read at session start and `/reload`):

```json
{ "checkpointMinutes": 120, "maxActiveHours": null, "notifications": true }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `checkpointMinutes` | `120` | Minutes of active time between checkpoint notifications; `null` turns them off. |
| `maxActiveHours` | `null` | Pause after this many active hours; `null` means no limit. |
| `notifications` | `true` | Desktop notifications. |

- A missing file means the defaults.
- Unknown keys are ignored, with one warning naming them.
- An invalid value falls back to its default, with a warning.

## Session state

- **Where the goal lives:** in the pi session. It survives reload, resume and compaction, and a new session does not inherit it.
- **When state is written:** only when something significant changes (status, pause reason, wait, notes), every five minutes of active time, and at shutdown.
- **Long objectives:** an objective over 200 characters is written once per goal.
- **Older sessions:** sessions written by pi-goal 0.54.8 restore; a goal that Esc left `blocked` there comes back `paused (interrupted)`.

## Development

```bash
npm install
npm run typecheck
npm test               # vitest: unit and lifecycle tests against a mock pi
npm run test:runtime   # a real pi AgentSession with pi-ai's faux provider
```

**Offline check in the real TUI:** `python3 test/fixtures/drive-tui.py [dir]` (needs `pip install pyte`) drives pi in a pty with the scripted offline provider in `test/fixtures/offline-provider.ts`. The run:

1. starts `/goal execute prompt.md`
2. presses Esc during a long bash
3. types "continue"
4. waits on a check command
5. completes with deviations

It saves every screen, provider request and the session under `dir`. It uses a fresh agent directory, so no installed packages load. To try the extension by hand without a real model:

```bash
pi -e ./src/index.ts -e ./test/fixtures/offline-provider.ts --model offline/echo
```

## What changed from upstream

- Esc pauses instead of blocking. A paused goal keeps its objective, and the agent resumes it with `goal_resume` when you say "continue".
- `goal_complete`: no more regex rejecting summaries that mention deviations; there is a `deviations` field instead.
- New Goal-mode rules (proportionate verification, progress notes, real waits), carried only in the contract.
- New `goal_progress`, `goal_resume`, and `wake_when` on `goal_wait`.
- Rate-limit reset waits, checkpoint and desktop notifications, an optional active-time limit, and file objectives.
- Goal state is written only when it changes.
- Removed:
  - token budgets and `--tokens`
  - the response-count limit (`automaticTurns`) and the output-fingerprint guard
  - managed-run RPC
  - the workflow mutex
  - the goal menu and settings UI (and `@narumitw/pi-tui-kit`)
  - legacy queue and global-file migrations
  - `goal_blocked`'s `repeated_turns`
  - the generated `dist/` runtime

## Known limits

- `goal_resume` depends on the model recognizing that your message asks to continue. It cannot resume on its own: only a run you started by typing can resume.
- Esc detection relies on the provider's stop reason, pi's abort signal or the abort error text. A provider that reports an Esc in other words would pause the goal as `error` rather than `interrupted`; you can still say "continue".
- Rate-limit waits only happen when the error names a reset time; otherwise your next message wakes the goal.
- Progress reminders arrive on the next tool result, so a single tool call that runs for hours gets its reminder only when it returns.

## License

MIT. See [LICENSE](./LICENSE).
