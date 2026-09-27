import assert from "node:assert/strict";
import { test } from "vitest";
import { parseResetTime } from "../src/reset-time.js";

// The message two parallel goals hit in the audited sessions, 36 minutes before the reset.
const FIVE_HOUR_LIMIT =
  "Claude rate limit (five_hour) — resets 1:10:00 AM: You've hit your session limit · resets 1:10am (America/Los_Angeles)";
const NOW = Date.parse("2026-09-25T07:36:32Z"); // 00:36:32 in Los Angeles (PDT)

test("the five-hour limit message resets at 1:10 AM Los Angeles time", () => {
  assert.equal(new Date(parseResetTime(FIVE_HOUR_LIMIT, NOW) ?? 0).toISOString(), "2026-09-25T08:10:00.000Z");
});

test("a reset time already past today means the same time tomorrow", () => {
  const after = Date.parse("2026-09-25T09:00:00Z"); // 02:00 in Los Angeles
  assert.equal(new Date(parseResetTime(FIVE_HOUR_LIMIT, after) ?? 0).toISOString(), "2026-09-26T08:10:00.000Z");
  assert.equal(
    new Date(parseResetTime("resets 11:30pm (America/Los_Angeles)", NOW) ?? 0).toISOString(),
    "2026-09-26T06:30:00.000Z",
  );
  assert.equal(new Date(parseResetTime("resets 13:10 (UTC)", NOW) ?? 0).toISOString(), "2026-09-25T13:10:00.000Z");
});

test("a reset time without a zone uses the local clock", () => {
  const reset = parseResetTime("Usage limit reached; resets 3:00 PM", NOW);
  assert.ok(reset !== undefined && reset > NOW && reset - NOW <= 24 * 3_600_000);
  const local = new Date(reset ?? 0);
  assert.equal(local.getHours(), 15);
  assert.equal(local.getMinutes(), 0);
});

test("retry-after, try again in, and ISO timestamps", () => {
  assert.equal(parseResetTime("HTTP 429 Too Many Requests, retry-after: 120", NOW), NOW + 120_000);
  assert.equal(parseResetTime("Retry-After: 30 seconds", NOW), NOW + 30_000);
  assert.equal(parseResetTime("You have hit your usage limit. Please try again in 3 hours.", NOW), NOW + 3 * 3_600_000);
  assert.equal(parseResetTime("try again in 45 minutes", NOW), NOW + 45 * 60_000);
  assert.equal(parseResetTime("try again in 20s", NOW), NOW + 20_000);
  assert.equal(parseResetTime("limit resets at 2026-09-25T09:00:00Z", NOW), Date.parse("2026-09-25T09:00:00Z"));
  assert.equal(
    parseResetTime("quota window ends 2026-09-25T02:00:00-07:00 (Pacific)", NOW),
    Date.parse("2026-09-25T09:00:00Z"),
  );
});

test("messages that name no reset time give undefined", () => {
  for (const message of [
    "rate limit exceeded",
    "Provider account is out of credits",
    "resets 5 requests",
    "HTTP 503: Service Unavailable",
    "resets 25:99",
  ]) {
    assert.equal(parseResetTime(message, NOW), undefined, message);
  }
});
