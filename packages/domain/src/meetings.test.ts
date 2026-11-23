import { describe, expect, it } from "vitest";
import { extractMeetingItems, splitMeetingText } from "./meetings.js";

const owners = [{ id: "maya", name: "Maya" }];
const instant = "2026-11-19T00:50:00Z";

describe("meeting follow-up extraction", () => {
  it("keeps the person being asked separate from ownership", () => {
    const segments = splitMeetingText(
      "Maya: We should ask Maya about rollout next week.\nQuestion: Which group goes first?",
    );
    const items = extractMeetingItems(
      segments,
      1,
      instant,
      "America/Los_Angeles",
      owners,
    );
    expect(items).toMatchObject([
      {
        kind: "action",
        ownerId: null,
        date: null,
        ownerExplicit: false,
        dateExplicit: false,
      },
      { kind: "question", ownerId: null, date: null },
    ]);
    expect(
      extractMeetingItems(segments, 1, instant, "America/Los_Angeles", owners),
    ).toEqual(items);
  });

  it("resolves a first-person commitment after a speaker correction", () => {
    const [original] = splitMeetingText(
      "Speaker A: I’ll send the release checklist Thursday.",
    );
    const before = extractMeetingItems(
      [original!],
      1,
      instant,
      "America/Los_Angeles",
      owners,
    )[0]!;
    const after = extractMeetingItems(
      [{ ...original!, speaker: "Maya" }],
      2,
      instant,
      "America/Los_Angeles",
      owners,
    )[0]!;
    expect(before.ownerId).toBeNull();
    expect(after).toMatchObject({
      key: before.key,
      ownerId: "maya",
      date: "2026-11-19",
      anchor: { revision: 2, segmentId: original!.id },
    });
  });

  it("anchors a decision after an emoji to the exact transcript text", () => {
    const quote = "Decision: Ship the pilot in two phases.";
    const [segment] = splitMeetingText("Maya: 🧭 Notes. " + quote);
    const [item] = extractMeetingItems([segment!], 1, instant, "UTC", owners);
    expect(item?.kind).toBe("decision");
    expect(
      Array.from(segment!.text)
        .slice(item!.anchor.start, item!.anchor.end)
        .join(""),
    ).toBe(quote);
  });
});
