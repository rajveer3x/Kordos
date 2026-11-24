import { z } from "zod";
import {
  dependencySchema,
  nodeForecastSchema,
  scheduleInputSchema,
} from "./forecast.js";
import { idSchema } from "./identity.js";
import { personSchema, workItemSchema } from "./planning.js";

const date = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const version = workItemSchema.shape.version;
const reference = z.object({ id: idSchema, version });
const named = reference.extend({ title: z.string() });
const work = named.extend({
  kind: workItemSchema.shape.kind,
  status: workItemSchema.shape.status,
});
const milestone = nodeForecastSchema
  .pick({ finish: true, slackDays: true, provisional: true })
  .extend({
    ...named.shape,
    commitment: date.nullable(),
    health: z.enum(["on_track", "at_risk", "uncertain", "uncommitted"]),
  });

export const weeklyReportSchema = z.object({
  ...scheduleInputSchema.shape,
  period: date,
  endExclusive: date,
  timeZone: z.string(),
  generatedAt: instant,
  graphVersion: version,
  stale: z.boolean(),
  active: z.array(work),
  milestones: z.array(milestone),
  blockers: z.array(reference),
  missingEstimates: z.array(reference),
  changes: z.array(
    z.object({
      ...named.shape,
      kind: workItemSchema.shape.kind,
      eventId: idSchema,
      action: z.enum([
        "work.created",
        "work.edited",
        "work.completed",
        "work.reopened",
        "work.archived",
        "work.restored",
      ]),
      occurredAt: instant,
    }),
  ),
  decisions: z.array(named),
});
export const weeklyReportsSchema = z.object({
  periods: z.array(date),
  report: weeklyReportSchema.nullable(),
});

const relatedWork = z.object({ id: idSchema, title: z.string() });
const comparedTask = named.extend({
  description: z.string().nullable(),
  owner: personSchema.nullable(),
  status: workItemSchema.shape.status,
  predecessors: z.array(relatedWork),
  successors: z.array(relatedWork),
});

export const duplicateReviewSchema = z.object({
  task: comparedTask,
  graphVersion: version,
  canAct: z.boolean(),
  links: z.array(
    relatedWork.extend({
      relation: z.enum(["related", "consolidated_into", "consolidated_from"]),
    }),
  ),
  candidates: z.array(
    comparedTask.extend({ sharedTerms: z.array(z.string()) }),
  ),
});

export const duplicateActionSchema = z.object({
  mutationId: idSchema,
  taskVersion: version,
  other: reference,
  action: z.enum(["dismiss", "relate", "consolidate"]),
  graphVersion: version,
});

export const consolidationSchema = z.object({
  keep: named,
  archive: named,
  graphVersion: version,
  dependencies: z.array(
    dependencySchema.extend({
      predecessorTitle: z.string(),
      successorTitle: z.string(),
    }),
  ),
});
export type DuplicateAction = z.infer<typeof duplicateActionSchema>;
export type Consolidation = z.infer<typeof consolidationSchema>;
