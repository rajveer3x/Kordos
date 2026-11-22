import { foundationJobEffect, foundationJobKind } from "@kordos/contracts";
import { describe, expect, it } from "vitest";
import { runFoundationJob } from "./index.js";

describe("foundation job", () => {
  const id = "01a20434-8bc1-4273-86a3-f60e93f6bdc3";

  it("returns the same harmless effect for every delivery of a job", () => {
    const payload = { id: id.toUpperCase(), kind: foundationJobKind };
    const first = runFoundationJob(payload);
    expect(first).toEqual({ id, effect: foundationJobEffect });
    expect(runFoundationJob(payload)).toEqual(first);
  });

  it.each([
    { id: "invalid", kind: foundationJobKind },
    { id, kind: "unknown" },
  ])("rejects invalid queue data", (payload) => {
    expect(() => runFoundationJob(payload)).toThrow();
  });
});
