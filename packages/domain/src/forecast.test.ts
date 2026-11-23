import type { ScheduleItem } from "@kordos/contracts";
import { describe, expect, it } from "vitest";
import {
  calculateForecast,
  compareScenario,
  dependencyPath,
} from "./forecast.js";

function work(id: string, fields: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id,
    title: id,
    kind: "task",
    status: "ready",
    version: 1,
    estimateDays: 1,
    commitment: null,
    completedAt: null,
    owner: null,
    ...fields,
  };
}

function edge(predecessorId: string, successorId: string) {
  return { predecessorId, successorId };
}

const launch = work("Launch", {
  kind: "milestone",
  estimateDays: null,
  commitment: "2026-11-23",
});
const schedule = {
  calendar: {
    timeZone: "America/Los_Angeles",
    workdays: [1, 2, 3, 4, 5],
    nonworkingDates: [] as string[],
  },
  asOf: "2026-11-16",
  items: [
    launch,
    work("QA", { estimateDays: 2 }),
    work("API", { estimateDays: 5 }),
  ],
  edges: [edge("API", "QA"), edge("QA", "Launch")],
};

describe("project forecasts", () => {
  it("forecasts a Wednesday launch after Friday handoff, and a Tuesday launch after Thursday handoff", () => {
    const comparison = compareScenario(schedule, [
      { kind: "handoff", workId: "API", finish: "2026-11-19" },
    ]);
    expect(comparison.baseline).toMatchObject([
      { id: "API", finish: "2026-11-20" },
      { id: "QA", start: "2026-11-23", finish: "2026-11-24" },
      {
        id: "Launch",
        start: "2026-11-25",
        finish: "2026-11-25",
        slackDays: -2,
      },
    ]);
    expect(comparison.forecast).toMatchObject([
      { id: "API", finish: "2026-11-19" },
      { id: "QA", start: "2026-11-20", finish: "2026-11-23" },
      {
        id: "Launch",
        start: "2026-11-24",
        finish: "2026-11-24",
        slackDays: -1,
      },
    ]);
    expect(comparison.affectedIds).toEqual(["API", "QA", "Launch"]);
    expect(comparison.affectedEdges).toEqual(schedule.edges);
    expect(launch.commitment).toBe("2026-11-23");
  });

  it("uses the last predecessor and keeps the milestone in place for a slip within slack", () => {
    const comparison = compareScenario(
      {
        ...schedule,
        items: [launch, work("Primary", { estimateDays: 3 }), work("Parallel")],
        edges: [edge("Primary", "Launch"), edge("Parallel", "Launch")],
      },
      [{ kind: "remaining", workId: "Parallel", days: 2 }],
    );
    expect(
      comparison.baseline.find(({ id }) => id === "Parallel")?.slackDays,
    ).toBe(2);
    expect(
      comparison.forecast.find(({ id }) => id === "Parallel")?.slackDays,
    ).toBe(1);
    expect(comparison.baseline.at(-1)?.finish).toBe("2026-11-19");
    expect(comparison.forecast.at(-1)?.finish).toBe("2026-11-19");
  });

  it("marks a missing estimate and downstream dates uncertain", () => {
    const forecast = calculateForecast({
      ...schedule,
      items: [launch, work("QA", { estimateDays: null }), work("API")],
    });
    expect(forecast).toMatchObject([
      { id: "API", provisional: false, slackDays: null },
      { id: "QA", finish: null, provisional: true, slackDays: null },
      {
        id: "Launch",
        finish: "2026-11-18",
        provisional: true,
        slackDays: null,
      },
    ]);
  });

  it("uses actual completion in the project timezone, despite upstream uncertainty, and skips holidays", () => {
    const extended = {
      ...schedule,
      asOf: "2026-11-20",
      calendar: { ...schedule.calendar, nonworkingDates: ["2026-11-23"] },
      items: [
        ...schedule.items.filter(({ id }) => id !== "API"),
        work("Unknown", { estimateDays: null }),
        work("API", {
          status: "done",
          estimateDays: null,
          completedAt: "2026-11-21T02:00:00.000Z",
        }),
      ],
      edges: [edge("Unknown", "API"), ...schedule.edges],
    };
    const comparison = compareScenario(extended, [
      { kind: "remaining", workId: "Unknown", days: 5 },
    ]);
    expect(comparison.forecast).toMatchObject([
      { id: "Unknown", finish: "2026-11-27" },
      { id: "API", finish: "2026-11-20", provisional: false },
      { id: "QA", start: "2026-11-24", finish: "2026-11-25" },
      { id: "Launch", finish: "2026-11-26", provisional: false },
    ]);
    expect(comparison.affectedIds).toEqual(["Unknown"]);
  });

  it("finds the conflicting path in a branching graph", () => {
    const edges = [
      ...schedule.edges,
      edge("API", "Parallel"),
      edge("Parallel", "Other"),
    ];
    expect(dependencyPath(edges, "API", "Launch")).toEqual([
      "API",
      "QA",
      "Launch",
    ]);
    expect(dependencyPath(edges, "Launch", "API")).toBeUndefined();
  });
});
