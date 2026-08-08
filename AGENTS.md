# Pi Goal Guidelines

## Continuations and lifecycle

- Record continuation intent at `agent_end`, queue it with `deliverAs: "followUp"`, and retry retained intent only at `agent_settled`.
- Use a narrowly idle-gated manual-compaction fallback because manual compaction does not emit `agent_settled`.
- Do not dispatch a follow-up directly from `session_compact`; defer through one owned cancellable task because Pi has not cleared its compaction controller yet.
- Revalidate session and goal ownership after `pi.events.emit()` because sibling listeners can synchronously re-enter the extension.
- Use `tool_execution_end` for a tool-using turn's just-finished usage and `agent_end` as the no-tool fallback.
- Activate completed-goal successors and busy priority changes only at the settled idle boundary.
- Persist pending priority intent so reload cannot lose it or charge the old run to the new goal.
- Classify only explicit quota, subscription, credit, or billing exhaustion as `usage_limited`; do not include rate limits, HTTP 429, or server failures.

## Ownership and recovery

- Bind goal-owned markers to the originating goal ID and add a unique nonce when iterations can repeat.
- On failed delivery, restore prior state only while that prompt still owns the current goal.
- If always-mode tool restoration fails, leave visibility unlocked while retaining the exact hidden-tool ownership set for a later retry.
- Reject exhausted stopped goals before rotating their ID.
- If `/goal resume` delivery fails, restore the original stopped state, ID, and stale-tool guard.
- When blocking a Pi `tool_call` in a bounded flow, abort the turn too because a blocked tool result does not terminate agent-core.
