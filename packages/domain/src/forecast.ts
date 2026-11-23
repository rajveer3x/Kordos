import type {
  Dependency,
  NodeForecast,
  ScheduleCalendar,
  ScheduleChange,
  ScheduleItem,
} from "@kordos/contracts";

const dayMillis = 86_400_000;
const dayNumber = (date: string) => Date.parse(date) / dayMillis;
const weekday = (day: number) => ((((day + 3) % 7) + 7) % 7) + 1;
const firstDay = dayNumber("0001-01-01");
const lastDay = dayNumber("9999-12-31");

function isoDate(day: number | null) {
  return day !== null && day >= firstDay && day <= lastDay
    ? new Date(day * dayMillis).toISOString().slice(0, 10)
    : null;
}

function businessDateFormat(timeZone: string) {
  return new Intl.DateTimeFormat("en", {
    calendar: "iso8601",
    numberingSystem: "latn",
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatBusinessDate(format: Intl.DateTimeFormat, instant: Date) {
  const parts = format.formatToParts(instant);
  const get = (part: string) => parts.find(({ type }) => type === part)!.value;
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

export function businessDate(timeZone: string, instant: Date) {
  return formatBusinessDate(businessDateFormat(timeZone), instant);
}

function projectCalendar(calendar: ScheduleCalendar) {
  const workdays = new Set(calendar.workdays);
  const holidays = calendar.nonworkingDates
    .map(dayNumber)
    .filter((day) => workdays.has(weekday(day)));
  const holidaySet = new Set(holidays);
  const local = businessDateFormat(calendar.timeZone);

  function opening(day: number) {
    while (!workdays.has(weekday(day)) || holidaySet.has(day)) day++;
    return day;
  }

  // Both endpoints are nominal workdays. Skip whole weeks, then account for
  // any holidays crossed, including holidays crossed by the correction.
  function shift(day: number, days: number) {
    const direction = Math.sign(days);
    let remaining = Math.abs(days);
    while (remaining) {
      const previous = day;
      day += Math.trunc(remaining / workdays.size) * 7 * direction;
      remaining %= workdays.size;
      while (remaining) {
        day += direction;
        if (workdays.has(weekday(day))) remaining--;
      }
      for (const holiday of holidays) {
        if (
          direction > 0
            ? holiday > previous && holiday <= day
            : holiday < previous && holiday >= day
        ) {
          remaining++;
        }
      }
    }
    return day;
  }

  // Count workdays between two opening dates, excluding the destination.
  function distance(from: number, to: number): number {
    if (from > to) return -distance(to, from);
    const weeks = Math.floor((to - from) / 7);
    let days = weeks * workdays.size;
    for (let day = from + weeks * 7; day < to; day++) {
      if (workdays.has(weekday(day))) days++;
    }
    for (const holiday of holidays) {
      if (holiday >= from && holiday < to) days--;
    }
    return days;
  }

  function actualDay(instant: string) {
    return dayNumber(formatBusinessDate(local, new Date(instant)));
  }

  return { opening, shift, distance, actualDay };
}

export function dependencyPath(
  edges: readonly Dependency[],
  from: string,
  to: string,
): string[] | undefined {
  const successors = new Map<string, string[]>();
  for (const { predecessorId, successorId } of edges) {
    const children = successors.get(predecessorId) ?? [];
    children.push(successorId);
    successors.set(predecessorId, children);
  }
  const path = [from];
  const parents = new Map<string, string | null>([[from, null]]);
  for (const id of path) {
    if (id === to) {
      const result = [id];
      for (let parent = parents.get(id); parent; parent = parents.get(parent)) {
        result.push(parent);
      }
      return result.reverse();
    }
    for (const child of successors.get(id) ?? []) {
      if (parents.has(child)) continue;
      parents.set(child, id);
      path.push(child);
    }
  }
}

type Schedule = {
  items: ScheduleItem[];
  edges: Dependency[];
  calendar: ScheduleCalendar;
  asOf: string;
};

type Node = {
  item: ScheduleItem;
  parents: Node[];
  children: Node[];
  remainingParents: number;
  depth: number;
  start: number | null;
  finish: number | null;
  release: number;
  effort: number;
  provisional: boolean;
  latest: number | null;
  slackUncertain: boolean;
};

export function calculateForecast(
  schedule: Schedule,
  changes: readonly ScheduleChange[] = [],
): NodeForecast[] {
  const { items, edges, calendar, asOf } = schedule;
  const { opening, shift, distance, actualDay } = projectCalendar(calendar);
  const today = opening(dayNumber(asOf));
  const overrides = new Map(changes.map((change) => [change.workId, change]));
  const nodes = new Map<string, Node>(
    items.map((item) => [
      item.id,
      {
        item,
        parents: [],
        children: [],
        remainingParents: 0,
        depth: 0,
        start: null,
        finish: null,
        release: today,
        effort: 0,
        provisional: false,
        latest: null,
        slackUncertain: false,
      },
    ]),
  );
  for (const { predecessorId, successorId } of edges) {
    const parent = nodes.get(predecessorId)!;
    const child = nodes.get(successorId)!;
    parent.children.push(child);
    child.parents.push(parent);
    child.remainingParents++;
  }

  const ordered = [...nodes.values()].filter(
    ({ remainingParents }) => remainingParents === 0,
  );
  for (const node of ordered) {
    const { item, parents } = node;
    const change = overrides.get(item.id);
    const milestone = item.kind === "milestone";
    const commitment = item.commitment ? dayNumber(item.commitment) : null;
    let start = today;
    for (const parent of parents) {
      start = Math.max(start, parent.release);
      node.provisional ||= parent.provisional;
      node.depth = Math.max(node.depth, parent.depth + 1);
    }

    if (item.completedAt) {
      node.provisional = false;
      node.finish = actualDay(item.completedAt);
      node.release = opening(node.finish + 1);
    } else if (milestone) {
      // A standalone committed milestone uses its planned day as its anchor.
      node.start =
        parents.length === 0 && commitment !== null
          ? Math.max(start, opening(commitment))
          : start;
      node.finish = node.start;
      node.release = opening(node.finish + 1);
      node.effort = 1;
    } else {
      node.start = start;
      const remaining =
        change?.kind === "remaining" ? change.days : item.estimateDays;
      if (change?.kind === "handoff") {
        node.finish = Math.max(start, dayNumber(change.finish));
        node.release = opening(node.finish + 1);
        node.effort = distance(start, node.release);
      } else if (remaining === null) {
        node.provisional = true;
        node.release = opening(start + 1);
        node.effort = 1;
      } else {
        node.finish = shift(start, remaining - 1);
        node.release = opening(node.finish + 1);
        node.effort = remaining;
      }
    }
    if (node.finish !== null && isoDate(node.finish) === null)
      node.provisional = true;

    for (const child of node.children) {
      if (--child.remainingParents === 0) ordered.push(child);
    }
  }
  if (ordered.length !== nodes.size)
    throw new Error("The dependency graph contains a cycle.");

  // Anchor to the tighter of the forecast and the commitment. Work with
  // positive slack can move without changing the current milestone forecast.
  for (let index = ordered.length - 1; index >= 0; index--) {
    const node = ordered[index]!;
    if (node.start === null) continue;
    if (node.item.kind === "milestone") {
      const commitment =
        node.item.commitment && dayNumber(node.item.commitment);
      let target = commitment ? Math.min(node.start, commitment) : node.start;
      while (opening(target) !== target) target--;
      node.latest = target;
      node.slackUncertain = node.provisional;
    }
    for (const child of node.children) {
      if (child.latest === null) continue;
      const latest = shift(child.latest, -node.effort);
      node.latest =
        node.latest === null ? latest : Math.min(node.latest, latest);
      node.slackUncertain ||= child.slackUncertain;
    }
  }

  return ordered.map((node) => ({
    id: node.item.id,
    start: isoDate(node.start),
    finish: isoDate(node.finish),
    slackDays:
      node.start === null ||
      node.latest === null ||
      node.provisional ||
      node.slackUncertain
        ? null
        : distance(node.start, node.latest),
    provisional: node.provisional,
    depth: node.depth,
  }));
}

export function compareScenario(schedule: Schedule, changes: ScheduleChange[]) {
  const baseline = calculateForecast(schedule);
  const forecast = calculateForecast(schedule, changes);
  const affected = new Set(changes.map(({ workId }) => workId));
  const outgoing = new Map<string, Dependency[]>();
  for (const edge of schedule.edges) {
    const edges = outgoing.get(edge.predecessorId) ?? [];
    edges.push(edge);
    outgoing.set(edge.predecessorId, edges);
  }
  const affectedEdges: Dependency[] = [];
  const completed = new Set(
    schedule.items.filter(({ completedAt }) => completedAt).map(({ id }) => id),
  );
  const affectedIds = [];
  for (const { id } of forecast) {
    if (!affected.has(id)) continue;
    affectedIds.push(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (completed.has(edge.successorId)) continue;
      affected.add(edge.successorId);
      affectedEdges.push(edge);
    }
  }
  return { baseline, forecast, affectedIds, affectedEdges };
}
