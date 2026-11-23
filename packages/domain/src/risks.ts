import type {
  ProjectGraph,
  RiskAssessment,
  RiskSource,
} from "@kordos/contracts";
import { businessDate, compareScenario, dependencyPath } from "./forecast.js";
import { sourceDate } from "./source-dates.js";

type Schedule = Pick<ProjectGraph, "items" | "edges" | "calendar" | "asOf">;
const delay =
  /\b(?:delay(?:ed|s)?|blocked|slip(?:s|ped|ping)?|running late|(?:is|are|will be) late|behind schedule|won['’]t (?:finish|be ready|ship)|cannot (?:finish|ship))\b/i;
const negation =
  /\b(?:no (?:longer )?(?:delay|blocked|late)|not (?:delayed|blocked|late)|on track)\b/i;
const timing =
  /\b(?:until|to|by|on|eta\s*:?|finish(?:es)?|ready)\s+((?:next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|today|tomorrow|\d{4}-\d{2}-\d{2})\b/gi;

function containsTitle(text: string, title: string) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}

export function delayPassage(body: string) {
  return body
    .split(/\n|(?<=[.!?])\s+/)
    .find((part) => delay.test(part) && !negation.test(part));
}

export function assessDelay(
  schedule: Schedule,
  source: RiskSource,
  clarifiedTask?: string,
): RiskAssessment | null {
  const report = delayPassage(source.body);
  if (!report) return null;
  const excerpt = Array.from(report.trim()).slice(0, 1000).join("");
  const eligible = schedule.items.filter(
    ({ kind, status }) => kind === "task" && status !== "done",
  );
  const tagged =
    source.subject.kind === "task"
      ? eligible.find(({ id }) => id === source.subject.id)
      : undefined;
  const mentioned = eligible.filter(({ title }) =>
    containsTitle(report, title),
  );
  const scoped = mentioned.filter(
    ({ title }) =>
      !mentioned.some(
        (other) =>
          other.title.length > title.length &&
          containsTitle(other.title, title),
      ),
  );
  const candidates = (scoped.length ? scoped : eligible).slice(0, 40);
  const task = clarifiedTask
    ? eligible.find(({ id }) => id === clarifiedTask)
    : (tagged ?? (scoped.length === 1 ? scoped[0] : undefined));
  const dates = Array.from(report.matchAll(timing), ([, phrase]) =>
    sourceDate(phrase!, schedule.calendar.timeZone, source.capturedAt),
  );
  const handoff =
    dates.length && dates.every((date) => date === dates[0]) ? dates[0]! : null;
  const asOf = businessDate(
    schedule.calendar.timeZone,
    new Date(source.capturedAt),
  );
  const base = {
    excerpt,
    handoff,
    task: task ?? null,
    taskClarified: !!clarifiedTask && !!task,
    candidates: task ? [] : candidates,
    affected: [],
    milestones: [],
  };
  if (!task || !handoff || handoff < asOf)
    return { ...base, severity: "clarify" };

  const comparison = compareScenario({ ...schedule, asOf }, [
    { kind: "handoff", workId: task.id, finish: handoff },
  ]);
  const items = new Map(schedule.items.map((item) => [item.id, item]));
  const before = new Map(
    comparison.baseline.map((item) => [item.id, item.finish]),
  );
  const forecast = new Map(comparison.forecast.map((item) => [item.id, item]));
  const affected = comparison.affectedIds.map((id) => ({
    ...items.get(id)!,
    baseline: before.get(id) ?? null,
    forecast: forecast.get(id)?.finish ?? null,
    provisional: forecast.get(id)!.provisional,
  }));
  const shifted = new Set(
    affected
      .filter(
        ({ baseline, forecast }) => forecast && baseline && forecast > baseline,
      )
      .map(({ id }) => id),
  );
  const shiftedEdges = comparison.affectedEdges.filter(({ successorId }) =>
    shifted.has(successorId),
  );
  const milestones = affected.flatMap((item) => {
    if (
      item.kind !== "milestone" ||
      !item.forecast ||
      !item.baseline ||
      item.forecast <= item.baseline
    )
      return [];
    const path =
      dependencyPath(shiftedEdges, task.id, item.id) ??
      dependencyPath(comparison.affectedEdges, task.id, item.id);
    return path ? [{ ...item, path: path.map((id) => items.get(id)!) }] : [];
  });

  return {
    ...base,
    affected,
    milestones,
    severity: milestones.some(
      ({ forecast, commitment }) => commitment && forecast! > commitment,
    )
      ? "at_risk"
      : milestones.length
        ? "watch"
        : "unchanged",
  };
}
