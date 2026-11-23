import { describe, expect, it } from "vitest";
import type { ProjectGraph, RiskSource, ScheduleItem } from "@kordos/contracts";
import { assessDelay } from "./risks.js";

const date = "2026-11-19";
function item(
  id: string,
  title: string,
  estimateDays: number | null,
  commitment: string | null = null,
): ScheduleItem {
  return {
    id,
    title,
    estimateDays,
    commitment,
    version: 1,
    owner: null,
    kind: commitment ? "milestone" : "task",
    status: "ready",
    completedAt: null,
  };
}
const api = item("api", "API handoff", 1);
const qa = item("qa", "QA", 2);
const launch = item("launch", "Launch", null, "2026-11-23");
const copy = item("copy", "Copy edit", 1);
const schedule: Pick<ProjectGraph, "calendar" | "asOf" | "items" | "edges"> = {
  calendar: {
    timeZone: "America/Los_Angeles",
    workdays: [1, 2, 3, 4, 5],
    nonworkingDates: [],
  },
  asOf: date,
  items: [api, qa, launch, copy],
  edges: [
    { predecessorId: api.id, successorId: qa.id },
    { predecessorId: qa.id, successorId: launch.id },
  ],
};
function source(body: string): RiskSource {
  return {
    body,
    sourceVersion: 1,
    commentId: "comment",
    capturedAt: "2026-11-20T00:30:00Z",
    projectId: "project",
    subject: { kind: "project", id: "project" },
  };
}

describe("delay reports", () => {
  it("uses the local source date and forecasts Wednesday with a Monday commitment", () => {
    const body = "API handoff is delayed until Friday.";
    expect(assessDelay(schedule, source(body))).toMatchObject({
      severity: "at_risk",
      excerpt: body,
      handoff: "2026-11-20",
      milestones: [
        {
          baseline: "2026-11-24",
          forecast: "2026-11-25",
          commitment: "2026-11-23",
          path: [{ id: api.id }, { id: qa.id }, { id: launch.id }],
        },
      ],
    });
    expect(
      assessDelay(schedule, source("API handoff is delayed until today."))
        ?.handoff,
    ).toBe(date);
  });

  it("keeps independent delays out of milestone risk and ignores a retracted delay", () => {
    expect(
      assessDelay(
        schedule,
        source("Copy edit is late and will finish on Friday."),
      ),
    ).toMatchObject({ severity: "unchanged", milestones: [] });
    expect(
      assessDelay(
        schedule,
        source("API handoff is not delayed. QA starts tomorrow."),
      ),
    ).toBeNull();
  });

  it("keeps a delayed parallel branch within its available slack", () => {
    const withSlack = {
      ...schedule,
      edges: [
        ...schedule.edges,
        { predecessorId: copy.id, successorId: launch.id },
      ],
    };
    const result = assessDelay(
      withSlack,
      source("Copy edit is late and will finish on Friday."),
    );
    expect(result).toMatchObject({
      severity: "unchanged",
      milestones: [],
      affected: [
        { id: copy.id, baseline: "2026-11-19", forecast: "2026-11-20" },
        { id: launch.id, baseline: "2026-11-24", forecast: "2026-11-24" },
      ],
    });
  });

  it("requires clarification for duplicate names and conflicting handoffs", () => {
    const duplicate = item("duplicate", api.title, 1);
    const withDuplicate = {
      ...schedule,
      items: [...schedule.items, duplicate],
    };
    expect(
      assessDelay(withDuplicate, source("API handoff is delayed to Friday.")),
    ).toMatchObject({
      severity: "clarify",
      task: null,
      candidates: [{ id: api.id }, { id: duplicate.id }],
    });
    expect(
      assessDelay(
        withDuplicate,
        source("API handoff is delayed to Friday."),
        duplicate.id,
      ),
    ).toMatchObject({
      severity: "unchanged",
      task: { id: duplicate.id },
      taskClarified: true,
    });
    expect(
      assessDelay(
        schedule,
        source("API handoff could be delayed to Friday or to Monday."),
      ),
    ).toMatchObject({
      severity: "clarify",
      handoff: null,
    });
  });
});
