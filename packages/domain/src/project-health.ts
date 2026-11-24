import type { ProjectGraph } from "@kordos/contracts";
import { calculateForecast, commitmentSlack } from "./forecast.js";

export function weeklySchedule(schedule: Omit<ProjectGraph, "forecast">) {
  const { items, asOf, graphVersion, inputRevision, calendar } = schedule;
  const forecasts = calculateForecast(schedule);
  const active = items.filter(({ status }) => status !== "done");
  const forecastById = new Map(
    forecasts.map((forecast) => [forecast.id, forecast]),
  );
  return {
    asOf,
    inputRevision,
    graphVersion,
    timeZone: calendar.timeZone,
    active: active.map(({ id, title, kind, status, version }) => ({
      id,
      title,
      kind,
      status,
      version,
    })),
    missingEstimates: active
      .filter(
        ({ kind, estimateDays }) => kind === "task" && estimateDays === null,
      )
      .map(({ id, version }) => ({ id, version })),
    milestones: active
      .filter(({ kind }) => kind === "milestone")
      .map(({ id, title, commitment, version }) => {
        const { finish, provisional } = forecastById.get(id)!;
        const health =
          provisional || !finish
            ? "uncertain"
            : !commitment
              ? "uncommitted"
              : finish > commitment
                ? "at_risk"
                : "on_track";
        const slackDays =
          !provisional && finish && commitment
            ? commitmentSlack(calendar, finish, commitment)
            : null;
        return {
          id,
          title,
          version,
          commitment,
          finish,
          slackDays,
          provisional,
          health,
        };
      }),
  };
}

const commonWords = new Set([
  "and",
  "for",
  "from",
  "into",
  "the",
  "this",
  "with",
]);

export function sharedDeliverableTerms(first: string, second: string) {
  const terms = (value: string) =>
    new Set(
      value
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]{3,}/gu),
    );
  const other = terms(second);
  return [...terms(first)]
    .filter((term) => other.has(term) && !commonWords.has(term))
    .slice(0, 8);
}
