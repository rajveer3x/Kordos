import { z } from "zod";

const dependencyStatusSchema = z.enum(["up", "down"]);

export const readinessSchema = z.object({
  status: z.enum(["ready", "degraded"]),
  checks: z.object({
    postgres: dependencyStatusSchema,
    redis: dependencyStatusSchema,
    storage: dependencyStatusSchema,
  }),
});

export type Readiness = z.infer<typeof readinessSchema>;

export const foundationQueue = "kordos-foundation";
export const foundationJobKind = "synthetic-smoke-test";
export const foundationJobIdSchema = z
  .uuidv4()
  .transform((id) => id.toLowerCase());
export const foundationJobRequestSchema = z.object({
  id: foundationJobIdSchema,
});
export const foundationJobPayloadSchema = foundationJobRequestSchema.extend({
  kind: z.literal(foundationJobKind),
});
export type FoundationJobPayload = z.infer<typeof foundationJobPayloadSchema>;

export const foundationJobEffect = "synthetic-job-processed";
const foundationJobEffectSchema = z.literal(foundationJobEffect);

export const foundationJobSchema = z.discriminatedUnion("status", [
  foundationJobRequestSchema.extend({ status: z.literal("pending") }),
  foundationJobRequestSchema.extend({
    status: z.literal("completed"),
    effect: foundationJobEffectSchema,
    completedAt: z.iso.datetime(),
  }),
]);

export type FoundationJob = z.infer<typeof foundationJobSchema>;
export type FoundationJobEffect = z.infer<typeof foundationJobEffectSchema>;
