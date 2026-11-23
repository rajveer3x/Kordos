import { businessDate } from "./forecast.js";

const week = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export function sourceDate(
  phrase: string,
  timeZone: string,
  timestamp: string,
): string | null {
  const local = new Date(
    businessDate(timeZone, new Date(timestamp)) + "T00:00:00Z",
  );
  const weekday = (local.getUTCDay() + 6) % 7;
  const relative = phrase.toLowerCase();
  if (relative === "tomorrow") local.setUTCDate(local.getUTCDate() + 1);
  else if (relative !== "today") {
    const explicit = /^\d{4}-\d{2}-\d{2}$/.test(relative)
      ? new Date(relative + "T00:00:00Z")
      : null;
    if (explicit)
      return !isNaN(+explicit) &&
        explicit.toISOString().slice(0, 10) === relative &&
        !relative.startsWith("0000")
        ? relative
        : null;
    const next = relative.startsWith("next ");
    const named = week.indexOf(next ? relative.slice(5) : relative);
    if (named < 0) return null;
    local.setUTCDate(
      local.getUTCDate() +
        (next ? 7 + named - weekday : (named - weekday + 7) % 7),
    );
  }
  return local.toISOString().slice(0, 10);
}
