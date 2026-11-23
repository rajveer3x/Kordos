import {
  auditFilterSchema,
  auditPageSchema,
  createProposalSchema,
  idSchema,
  proposalDetailSchema,
  proposalPageSchema,
  reviseProposalSchema,
  saveBriefPlanSchema,
  reviseBriefPlanSchema,
  reviewReasonSchema,
  reviewResponseSchema,
  reviewVersionSchema,
  workItemSchema,
} from "@kordos/contracts";
import type { connectDatabase } from "@kordos/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdentityError, parse, unavailable } from "../identity/http.js";

const workspace = "/workspaces/:workspaceId";
const proposals = workspace + "/proposals";
const proposal = proposals + "/:id";
const workspaceParams = z.object({ workspaceId: idSchema });
const projectParams = workspaceParams.extend({ projectId: idSchema });
const proposalPatchSchema = z.union([
  reviseBriefPlanSchema,
  reviseProposalSchema,
]);
const proposalParams = workspaceParams.extend({ id: idSchema });
const proposalQuery = z.object({
  revision: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .pipe(z.number().max(2147483647))
    .optional(),
});
const listQuery = z.object({
  cursor: idSchema.optional(),
  status: z.literal("pending").optional(),
});

function saved(value: { result: string; cycle?: string[] }, current?: unknown) {
  switch (value.result) {
    case "saved":
      return reviewResponseSchema.parse(value);
    case "unavailable":
      throw unavailable();
    case "forbidden":
      throw new IdentityError(
        403,
        "forbidden",
        "A project lead must review this change.",
      );
    case "cycle":
      throw new IdentityError(
        400,
        "invalid_input",
        value.cycle
          ? `Dependencies contain a cycle (${value.cycle.join(" → ")}). Remove a dependency and try again.`
          : "Dependencies contain a cycle. Remove a dependency and try again.",
      );
    case "invalid_owner":
      throw new IdentityError(
        400,
        "invalid_input",
        "Choose an eligible project owner or leave the task unassigned.",
      );
    case "invalid_plan":
      throw new IdentityError(
        400,
        "invalid_input",
        "Use unique tasks and dependencies between tasks in this plan.",
      );
    case "invalid_expiry":
      throw new IdentityError(
        400,
        "invalid_input",
        "Choose an expiration within the next 30 days.",
      );
    case "target_changed":
      throw new IdentityError(
        409,
        "conflict",
        "The work item changed. Open the latest work version and revise the proposal.",
        current,
      );
    case "risk_stale":
      throw new IdentityError(
        409,
        "conflict",
        "The delay report or schedule changed. Open the latest risk and refresh its forecast before requesting a new approval.",
      );
    case "evidence_changed":
      throw new IdentityError(
        409,
        "conflict",
        "The evidence changed or is unavailable. Review the sources and save a new revision.",
      );
    case "expired":
      throw new IdentityError(
        409,
        "invalid_state",
        "This proposal expired. Save a new revision and submit it for review.",
      );
    case "conflict":
    case "mutation_conflict":
      throw new IdentityError(
        409,
        "conflict",
        "The proposal changed. Review the latest revision and try again.",
      );
    case "invalid_state":
      throw new IdentityError(
        409,
        "invalid_state",
        "This change is unavailable in the current state.",
      );
    default:
      throw new Error("Unexpected review command outcome.");
  }
}

export function registerReviews(
  api: FastifyInstance,
  {
    reviews: db,
    planning,
  }: Pick<ReturnType<typeof connectDatabase>, "reviews" | "planning">,
  requireActor: (request: FastifyRequest) => Promise<string>,
) {
  api.get(proposals, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const { cursor, status } = parse(listQuery, request.query);
    const page = await db.directory(
      [actor, workspaceId],
      cursor ?? null,
      status === "pending",
    );
    if (!page) throw unavailable();
    return proposalPageSchema.parse(page);
  });

  api.get(proposal, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, id } = parse(proposalParams, request.params);
    const { revision } = parse(proposalQuery, request.query);
    const details = await db.detail([actor, workspaceId], id, revision ?? null);
    if (!details) throw unavailable();
    return proposalDetailSchema.parse(details);
  });

  api.post(
    workspace + "/projects/:projectId/proposals",
    async (request, reply) => {
      const actor = await requireActor(request);
      const { workspaceId, projectId } = parse(projectParams, request.params);
      const input = parse(createProposalSchema, request.body);
      const scope: [string, string] = [actor, workspaceId];
      const result = await db.mutate(
        scope,
        { projectId },
        { action: "create", input },
      );
      const current =
        result.result === "target_changed"
          ? workItemSchema.safeParse(
              await planning.work(scope, projectId, input.workId),
            ).data
          : undefined;
      return reply.code(201).send(saved(result, current));
    },
  );

  api.post(
    workspace + "/projects/:projectId/plan-proposals",
    async (request, reply) => {
      const actor = await requireActor(request);
      const { workspaceId, projectId } = parse(projectParams, request.params);
      const input = parse(saveBriefPlanSchema, request.body);
      const result = await db.mutate(
        [actor, workspaceId],
        { projectId },
        { action: "create", input },
      );
      return reply.code(201).send(saved(result));
    },
  );

  api.patch(proposal, async (request) => {
    const actor = await requireActor(request);
    const { workspaceId, id } = parse(proposalParams, request.params);
    const scope: [string, string] = [actor, workspaceId];
    const result = await db.mutate(
      scope,
      { proposalId: id },
      {
        action: "revise",
        input: parse(proposalPatchSchema, request.body),
      },
    );
    if (result.result === "target_changed") {
      const { data } = proposalDetailSchema.safeParse(
        await db.detail(scope, id, null),
      );
      const current =
        data &&
        data.kind !== "plan" &&
        data.kind !== "meeting" &&
        workItemSchema.safeParse(
          await planning.work(scope, data.projectId, data.workId),
        ).data;
      return saved(result, current);
    }
    return saved(result);
  });

  for (const action of [
    "submit",
    "approve",
    "request_edit",
    "reject",
  ] as const) {
    api.post(
      proposal + "/" + action.replace("_", "-"),
      async (request, reply) => {
        const actor = await requireActor(request);
        const { workspaceId, id } = parse(proposalParams, request.params);
        const response = saved(
          await db.mutate(
            [actor, workspaceId],
            { proposalId: id },
            action === "submit" || action === "approve"
              ? { action, input: parse(reviewVersionSchema, request.body) }
              : { action, input: parse(reviewReasonSchema, request.body) },
          ),
        );
        return action === "approve"
          ? reply
              .code(202)
              .header(
                "Location",
                `/api/workspaces/${workspaceId}/proposals/${id}?revision=${response.revision}`,
              )
              .send(response)
          : response;
      },
    );
  }

  api.get(workspace + "/audit", async (request) => {
    const actor = await requireActor(request);
    const { workspaceId } = parse(workspaceParams, request.params);
    const page = await db.audit(
      [actor, workspaceId],
      parse(auditFilterSchema, request.query),
    );
    if (!page) throw unavailable();
    return auditPageSchema.parse(page);
  });
}
