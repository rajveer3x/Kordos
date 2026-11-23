import { z } from "zod";
import { idSchema } from "./identity.js";
import {
  personSchema,
  projectFieldsSchema,
  workItemSchema,
} from "./planning.js";

const date = projectFieldsSchema.shape.nonworkingDates.element;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const version = workItemSchema.shape.version;

export const dependencySchema = z.object({
  predecessorId: idSchema,
  successorId: idSchema,
});
export const dependencyChangeSchema = dependencySchema.extend({
  action: z.enum(["add", "remove"]),
  expectedVersion: version,
  mutationId: idSchema,
});
export const cyclePathSchema = z.object({
  path: z.array(z.object({ id: idSchema, title: z.string() })).min(2),
});
export const scheduleInputSchema = z.object({
  inputRevision: revision,
  asOf: date,
});
export const scheduleCalendarSchema = projectFieldsSchema.pick({
  timeZone: true,
  workdays: true,
  nonworkingDates: true,
});
export const scheduleItemSchema = workItemSchema
  .pick({
    id: true,
    title: true,
    kind: true,
    status: true,
    version: true,
    estimateDays: true,
    commitment: true,
    completedAt: true,
  })
  .extend({ owner: personSchema.nullable() });

const scheduleChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("handoff"), workId: idSchema, finish: date }),
  z.object({
    kind: z.literal("remaining"),
    workId: idSchema,
    days: workItemSchema.shape.estimateDays.unwrap(),
  }),
]);
const scheduleChanges = z
  .array(scheduleChange)
  .min(1)
  .max(60)
  .refine(
    (changes) =>
      new Set(changes.map(({ workId }) => workId)).size === changes.length,
  );
export const createScenarioSchema = scheduleInputSchema.extend({
  changes: scheduleChanges,
  mutationId: idSchema,
});
export const nodeForecastSchema = z.object({
  id: idSchema,
  start: date.nullable(),
  finish: date.nullable(),
  slackDays: z.number().int().nullable(),
  provisional: z.boolean(),
  depth: z.number().int().nonnegative(),
});
export const graphSchema = scheduleInputSchema.extend({
  graphVersion: version,
  calendar: scheduleCalendarSchema,
  items: z.array(scheduleItemSchema),
  edges: z.array(dependencySchema),
  forecast: z.array(nodeForecastSchema),
});
export const scenarioSchema = scheduleInputSchema.extend({
  id: idSchema,
  version: z.literal(1),
  changes: scheduleChanges,
  baseline: z.array(nodeForecastSchema),
  forecast: z.array(nodeForecastSchema),
  affectedIds: z.array(idSchema),
  affectedEdges: z.array(dependencySchema),
});

export type Dependency = z.infer<typeof dependencySchema>;
export type DependencyChange = z.infer<typeof dependencyChangeSchema>;
export type ScheduleItem = z.infer<typeof scheduleItemSchema>;
export type ScheduleCalendar = z.infer<typeof scheduleCalendarSchema>;
export type ScheduleChange = z.infer<typeof scheduleChange>;
export type CreateScenario = z.infer<typeof createScenarioSchema>;
export type NodeForecast = z.infer<typeof nodeForecastSchema>;
export type ProjectGraph = z.infer<typeof graphSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
