# Pi Goal Guidelines

## Continuations and lifecycle

- Record continuation intent at `agent_end`, and dispatch or retry it only after `agent_settled` proves the session idle.
- Use one owned cancellable task for the narrowly idle-gated manual-compaction fallback because `session_compact` fires before Pi clears its controller and does not emit `agent_settled`.
- Classify only explicit quota, subscription, credit, or billing exhaustion as `usage_limited`; rate limits, HTTP 429 and server failures are retryable. A limit that names its reset time waits for it instead of stopping.
- A run the user stopped pauses the goal (`interrupted`), whether the provider reports `stopReason: "aborted"`, an abort error such as "This operation was aborted", or only pi's aborted signal. Only `goal_blocked` and an unrecoverable context overflow block a goal.
- Keep external waits canonically active but continuation-ineligible, and exclude their quiet wall time from active elapsed accounting.
- Route wait deadlines and fired `wake_when` conditions through the settled continuation dispatcher, bind timers to exact session and Goal identity, cancel them on every superseding transition and shutdown, and `unref` long timers so they never keep a finished process alive.
- Treat an extension message as Goal-owned only when its exact accepted prompt fingerprint or an accepted transformed-prompt boundary matches; quoted markers in external messages must still wake waiting work.

## Ownership and recovery

- Bind goal-owned markers to the originating goal ID and add a unique nonce when iterations can repeat.
- Restore failed-delivery state only while that prompt still owns the current goal.
- Keep Goal tool schemas stable from registration onward, and reject or pause when an external active-tool policy removes `goal_complete` instead of changing the active tool set.
- `goal_resume` is accepted only from a run the user started with their own input; a Goal-owned prompt or another extension's message must never resume a goal.
- When blocking a Pi `tool_call` in a bounded flow, abort the turn too because a blocked tool result does not terminate agent-core.

## Contracts and persistence

- The Goal-mode rules live only in the goal contract. Kickoff, continuation, resume and edit prompts carry the objective, the `goal_id` and a pointer to the contract.
- The latest contract wins: active, paused (paused and blocked goals, objective kept) or inactive. Append a new one only when the latest differs, and after a terminal tool only at `turn_end`, once the tool result is persisted.
- `persistGoal` decides whether to write: significant changes, five more minutes of active time, or shutdown. Entries are snapshots; tests seed and read live state through the runtime that `goal()` returns.
- Sessions written by pi-goal 0.54.8 must keep restoring.
