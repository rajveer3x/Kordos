import {
  foundationJobEffect,
  foundationJobPayloadSchema,
  type FoundationJobEffect,
  type FoundationJobPayload,
} from "@kordos/contracts";

export function runFoundationJob(input: unknown): {
  id: FoundationJobPayload["id"];
  effect: FoundationJobEffect;
} {
  const { id } = foundationJobPayloadSchema.parse(input);
  return { id, effect: foundationJobEffect };
}

export * from "./forecast.js";
export * from "./risks.js";
export * from "./source-dates.js";
export * from "./meetings.js";
