import { randomUUID } from "node:crypto";
import type { ModelBrief } from "@kordos/contracts";
import { describe, expect, it } from "vitest";
import { groundBrief } from "./brief-model.js";

describe("brief extraction grounding", () => {
  const ownerId = randomUUID();
  const quote = "Release on Friday. Find a reviewer.";
  const source = {
    capturedAt: "2026-11-20T00:30:00Z",
    timeZone: "America/Los_Angeles",
    sourceRevision: 2,
    content: "🧭\n" + quote,
    owners: [{ id: ownerId, name: "Mira" }],
  };
  const task: ModelBrief["tasks"][number] = {
    id: "release",
    title: "Release",
    description: null,
    owner: "Mira",
    estimateDays: null,
    estimateInferred: false,
    deadline: { kind: "relative", value: "friday" },
    quote,
  };

  it("resolves dates from the source timezone and drops unsupported owners", () => {
    const result = groundBrief({ tasks: [task], edges: [] }, source);
    expect(result).toMatchObject({
      plan: {
        tasks: [
          {
            deadline: "2026-11-20",
            ownerId: null,
            certainty: {
              owner: "missing",
              estimate: "missing",
              deadline: "inferred",
            },
            passages: [{ revision: 2, start: 2, end: 2 + quote.length }],
          },
        ],
      },
    });
    expect(
      groundBrief(
        {
          tasks: [{ ...task, deadline: { kind: "relative", value: "today" } }],
          edges: [],
        },
        source,
      ),
    ).toMatchObject({ plan: { tasks: [{ deadline: null }] } });
    expect(
      groundBrief(
        {
          tasks: [
            {
              ...task,
              deadline: { kind: "relative", value: "today" },
              quote: "Release today.",
            },
          ],
          edges: [],
        },
        { ...source, content: "Release today." },
      ),
    ).toMatchObject({ plan: { tasks: [{ deadline: "2026-11-19" }] } });
  });

  it("rejects fabricated or ambiguous spans and invalid model dependencies", () => {
    expect(
      groundBrief(
        { tasks: [{ ...task, quote: "Never in the source" }], edges: [] },
        source,
      ),
    ).toEqual({ failure: "invalid_output" });
    expect(
      groundBrief(
        { tasks: [task], edges: [] },
        { ...source, content: quote.repeat(2) },
      ),
    ).toEqual({ failure: "invalid_output" });
    expect(
      groundBrief(
        {
          tasks: [task],
          edges: [{ predecessorId: task.id, successorId: task.id }],
        },
        source,
      ),
    ).toEqual({ failure: "invalid_output" });
  });
});
