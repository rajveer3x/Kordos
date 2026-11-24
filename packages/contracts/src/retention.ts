import { z } from "zod";
import { idSchema } from "./identity.js";

export const retentionDaysSchema = z.object({
  audioDays: z.number().int().min(1).max(90),
  transcriptDays: z.number().int().min(1).max(3650),
  importedDays: z.number().int().min(1).max(3650),
  logDays: z.number().int().min(1).max(365),
});

const count = z.number().int().nonnegative();
const deletionCounts = z.object({
  audio: count,
  transcripts: count,
  imports: count,
  shares: count,
  logs: count,
});

export const retentionPolicySchema = retentionDaysSchema.extend({
  version: z.number().int().positive(),
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
  pending: deletionCounts,
  removed: deletionCounts,
});
export const updateRetentionSchema = retentionDaysSchema.extend({
  expectedVersion: z.number().int().positive(),
  mutationId: idSchema,
});

export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type UpdateRetention = z.infer<typeof updateRetentionSchema>;
