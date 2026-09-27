/**
 * When a provider says its limit resets. Recognizes, in order of precedence:
 * ISO-8601 timestamps, "resets 1:10:00 AM" / "resets 1:10am" (with an optional IANA
 * zone in parentheses anywhere in the message, otherwise local time; a time already
 * past means the next day), "retry-after: <seconds>", and "try again in <n> <unit>".
 * Returns epoch milliseconds, or undefined when the message names no reset.
 */
export function parseResetTime(message: string, now = Date.now()): number | undefined {
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/u.exec(message)?.[1];
  if (iso) {
    const at = Date.parse(iso);
    if (Number.isFinite(at)) return at;
  }

  const zone = /\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\)/u.exec(message)?.[1];
  for (const match of message.matchAll(
    /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap])\.?m\.?(?![a-z])|\bresets?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\s*[ap]\.?m)/giu,
  )) {
    const twelveHour = match[1] !== undefined;
    let hour = Number(twelveHour ? match[1] : match[5]);
    const minute = Number((twelveHour ? match[2] : match[6]) ?? 0);
    const second = Number((twelveHour ? match[3] : match[7]) ?? 0);
    if (twelveHour) {
      if (hour < 1 || hour > 12) continue;
      const pm = match[4]?.toLowerCase() === "p";
      hour = (hour % 12) + (pm ? 12 : 0);
    }
    if (hour > 23 || minute > 59 || second > 59) continue;
    return nextWallTime(hour, minute, second, zone, now);
  }

  const retryAfter = /\bretry[-_ ]after:?\s*(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?\b/iu.exec(message)?.[1];
  if (retryAfter) return now + Number(retryAfter) * 1_000;

  const tryAgain = /\btry again in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/iu.exec(message);
  if (tryAgain) {
    const unit = tryAgain[2]?.toLowerCase() ?? "s";
    const multiplier = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1_000;
    return now + Number(tryAgain[1]) * multiplier;
  }
  return undefined;
}

/** The next time the wall clock in `zone` (or the local zone) shows hour:minute:second. */
function nextWallTime(hour: number, minute: number, second: number, zone: string | undefined, now: number) {
  const timeZone = validZone(zone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = zonedParts(timeZone, now);
  for (const dayOffset of [0, 1]) {
    const at = zonedWallTimeToEpoch(timeZone, today.year, today.month, today.day + dayOffset, hour, minute, second);
    if (at > now) return at;
  }
  return zonedWallTimeToEpoch(timeZone, today.year, today.month, today.day + 2, hour, minute, second);
}

function zonedWallTimeToEpoch(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Correct by the zone's offset at the guessed instant; a second pass settles DST edges.
  let guess = wallAsUtc;
  for (let pass = 0; pass < 2; pass += 1) guess = wallAsUtc - zoneOffsetMs(timeZone, guess);
  return guess;
}

function zoneOffsetMs(timeZone: string, epoch: number) {
  const parts = zonedParts(timeZone, epoch);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(epoch / 1_000) * 1_000;
}

function zonedParts(timeZone: string, epoch: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epoch));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function validZone(zone: string | undefined) {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}
