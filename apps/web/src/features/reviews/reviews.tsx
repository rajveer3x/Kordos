import { PlanEditor, PlanPreview, TaskEvidence } from "../briefs/plan";
import {
  projectPeopleSchema,
  proposalDetailSchema,
  briefPlanSchema,
  proposalPageSchema,
  workItemSchema,
  type ProposalDetail,
  type ProposalStatus,
  type WorkFields,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  AsyncState,
  Button,
  PageHeading,
  StatusLabel,
} from "../../components/ui";
import { denied, read } from "../identity/api";
import { EvidencePassage } from "../knowledge/evidence-passage";
import { citationPath } from "../knowledge/knowledge-client";
import {
  planningRefresh,
  retainEdits,
  usePlanning,
  usePlanningCommand,
} from "../planning/planning-client";
import { WorkEditor } from "../planning/work-editor";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import { ReviewDiff } from "./review-diff";
import "./reviews.css";

const statusLabel: Record<ProposalStatus, string> = {
  draft: "Draft",
  pending: "Awaiting review",
  approved: "Approved",
  applying: "Applying",
  applied: "Applied",
  stale: "Stale",
  rejected: "Rejected",
  expired: "Expired",
  failed: "Failed",
  reconciliation_required: "Reconciliation required",
};

const issueMessage: Record<
  NonNullable<NonNullable<ProposalDetail["receipt"]>["issue"]>,
  string
> = {
  superseded:
    "A newer revision replaced this approval. Open the latest revision to continue.",
  target_changed:
    "The work item changed after review. Revise the proposal against the latest work version and submit it again.",
  access_changed:
    "The requester’s or reviewer’s access changed. An eligible member can revise the proposal and submit it for a new approval.",
  evidence_changed:
    "The evidence changed or is unavailable to the requester or reviewer. Verify the sources and revise the proposal.",
  expired:
    "The approval expired before it could be applied. Revise the proposal to set a new expiry.",
  target_unavailable:
    "The review target or project was archived. Restore it before revising the proposal.",
  invalid_change:
    "Check the proposed values and current owner eligibility before submitting a new revision.",
  ambiguous_effect:
    "An event already exists for this execution. Verify the work item and its audit history before attempting another change.",
  risk_stale:
    "The delay report or schedule changed before execution. Refresh the associated risk to submit a new replan.",
  destination_unavailable:
    "The GitHub destination is no longer available for this approval.",
  provider_refused: "GitHub refused to publish this comment.",
  worker_failed:
    "The system could not apply this change. Review the latest work version before submitting a new revision.",
};

function ReviewStatus({
  status,
  announce,
}: {
  status: ProposalStatus;
  announce?: boolean;
}) {
  return (
    <StatusLabel
      announce={announce}
      tone={
        status === "applied"
          ? "confirmed"
          : status === "failed" || status === "reconciliation_required"
            ? "critical"
            : status === "stale" || status === "expired"
              ? "risk"
              : "neutral"
      }
    >
      {statusLabel[status]}
    </StatusLabel>
  );
}

function Time({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

export function ReviewsPage() {
  const { api, key, workspace } = usePlanning();
  const [search, setSearch] = useSearchParams();
  const path = workspacePath("/reviews", workspace.id);
  const pending = search.get("status") === "pending";
  const query = search.toString();
  const directory = useQuery({
    queryKey: [...key, "reviews", query],
    queryFn: ({ signal }) =>
      read(api + "/proposals?" + query, proposalPageSchema, signal),
    ...planningRefresh,
  });
  return (
    <div className="standard-page">
      <title>Reviews · Kordos</title>
      <PageHeading title="Reviews" />
      <section className="glass-panel planning-panel">
        <div className="planning-heading">
          <div className="planning-actions">
            <Button
              variant={pending ? "quiet" : "secondary"}
              aria-pressed={!pending}
              onClick={() => setSearch({})}
            >
              All proposals
            </Button>
            <Button
              variant={pending ? "secondary" : "quiet"}
              aria-pressed={pending}
              onClick={() => setSearch({ status: "pending" })}
            >
              Awaiting review
              {directory.data ? ` (${directory.data.pendingCount})` : ""}
            </Button>
          </div>
          <Link to={workspacePath("/audit", workspace.id)}>Audit history</Link>
        </div>
        {directory.isPending ? (
          <AsyncState kind="loading" message="Loading reviews…" />
        ) : directory.isError ? (
          <AsyncState
            kind="error"
            message={
              denied(directory.error)
                ? "Reviews are unavailable."
                : "Could not load reviews."
            }
            retry={
              denied(directory.error)
                ? undefined
                : () => void directory.refetch()
            }
          />
        ) : (
          <>
            {directory.data.items.length ? (
              <ul className="review-list">
                {directory.data.items.map((item) => (
                  <li key={item.id}>
                    <div className="planning-item-copy">
                      <Link to={`${path}/${item.id}`}>
                        {item.kind === "plan"
                          ? "Create project plan"
                          : item.kind === "meeting"
                            ? "Meeting follow-up"
                            : item.kind === "github"
                              ? "Publish GitHub comment"
                              : `Edit ${item.kind}`}{" "}
                        · {item.title}
                      </Link>
                      <span>
                        {item.projectName} · {item.requester.name} ·{" "}
                        <Time value={item.requestedAt} />
                      </span>
                    </div>
                    <ReviewStatus status={item.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="planning-help">
                {pending
                  ? "No proposals are awaiting review."
                  : "No proposals yet."}
              </p>
            )}
            <div className="planning-actions">
              {search.has("cursor") && (
                <Button
                  variant="quiet"
                  onClick={() =>
                    setSearch(pending ? { status: "pending" } : {})
                  }
                >
                  Back to latest
                </Button>
              )}
              {directory.data.nextCursor && (
                <Button
                  variant="quiet"
                  onClick={() =>
                    setSearch({
                      ...(pending ? { status: "pending" } : {}),
                      cursor: directory.data.nextCursor!,
                    })
                  }
                >
                  Older proposals
                </Button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export function ReviewPage() {
  const { proposalId } = useParams();
  const [search] = useSearchParams();
  const { api, key, workspace } = usePlanning();
  const path = `${api}/proposals/${proposalId}`;
  const head = workspacePath(`/reviews/${proposalId}`, workspace.id);
  const query = search.toString();
  const result = useQuery({
    queryKey: [...key, "review", proposalId, query],
    queryFn: ({ signal }) =>
      read(path + "?" + query, proposalDetailSchema, signal),
    ...planningRefresh,
    refetchInterval: (query) =>
      query.state.data?.status === "approved" ||
      query.state.data?.status === "applying"
        ? 1000
        : 5000,
  });
  return (
    <div className="standard-page review-detail">
      <title>Review change · Kordos</title>
      <Link to={workspacePath("/reviews", workspace.id)}>All reviews</Link>
      {result.isPending ? (
        <AsyncState kind="loading" message="Loading proposal…" />
      ) : result.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(result.error)
              ? "This proposal is unavailable."
              : "Could not load this proposal."
          }
          retry={denied(result.error) ? undefined : () => void result.refetch()}
        />
      ) : (
        <ReviewDetails
          key={`${proposalId}/${result.data.revision}`}
          proposal={result.data}
          path={path}
          head={head}
        />
      )}
    </div>
  );
}

function ReviewDetails({
  proposal,
  path,
  head,
}: {
  proposal: ProposalDetail;
  path: string;
  head: string;
}) {
  const { workspace } = usePlanning();
  const command = usePlanningCommand();
  const status = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<ProposalDetail>();
  const [decision, setDecision] = useState<"request-edit" | "reject">();
  const [reason, setReason] = useState("");
  const current = proposal.revision === proposal.revisionHead;
  const precondition = {
    revision: proposal.revision,
    expectedVersion: proposal.version,
  };
  const projectBase = workspacePath(
    projectPath(proposal.projectId),
    workspace.id,
  );
  const target =
    proposal.kind === "plan"
      ? `${projectBase}/briefs/${proposal.briefId}`
      : proposal.kind === "meeting"
        ? `${projectBase}/meetings/${proposal.meetingId}`
        : proposal.kind === "github"
          ? proposal.githubSourceId &&
            `${projectBase}/documents/sources/${proposal.githubSourceId}?revision=${proposal.targetVersion}`
          : `${projectBase}/work/${proposal.workId}`;
  const receipt = proposal.receipt;
  const targetChanged =
    current &&
    proposal.kind !== "github" &&
    proposal.currentTargetVersion !== proposal.targetVersion &&
    ["draft", "pending"].includes(proposal.status);

  function review(action: "submit" | "approve" | "request-edit" | "reject") {
    void command.save(
      path + "/" + action,
      "POST",
      {
        ...precondition,
        ...(action === "request-edit" || action === "reject" ? { reason } : {}),
      },
      () => {
        setDecision(undefined);
        setReason("");
        status.current?.focus();
      },
      {
        submit: "Proposal submitted for review.",
        approve: "Approval recorded. The change is queued.",
        "request-edit": "Edits requested.",
        reject: "Proposal rejected.",
      }[action],
    );
  }

  return (
    <>
      <PageHeading
        title={
          proposal.kind === "plan"
            ? `Plan from ${proposal.title}`
            : proposal.kind === "meeting"
              ? `Review ${proposal.meetingItem?.kind ?? "follow-up"} · ${proposal.title}`
              : proposal.kind === "github"
                ? "Publish GitHub comment"
                : `Edit ${proposal.kind} · ${proposal.before?.title ?? proposal.title}`
        }
      />
      <section className="glass-panel planning-panel">
        <div className="planning-heading">
          <div ref={status} tabIndex={-1}>
            <ReviewStatus status={proposal.status} announce />
          </div>
          <nav aria-label="Proposal revisions" className="planning-actions">
            {proposal.revision > 1 && (
              <Link to={`${head}?revision=${proposal.revision - 1}`}>
                Previous revision
              </Link>
            )}
            {!current && <Link to={head}>Latest revision</Link>}
          </nav>
        </div>
        <dl className="planning-facts">
          <div>
            <dt>
              {proposal.kind === "plan"
                ? "Source brief"
                : proposal.kind === "meeting"
                  ? "Source meeting"
                  : proposal.kind === "github"
                    ? "GitHub source"
                    : `Affected ${proposal.kind}`}
            </dt>
            <dd>
              {target ? (
                <Link to={target}>{proposal.title}</Link>
              ) : (
                "Unavailable"
              )}
            </dd>
          </div>
          <div>
            <dt>Requested by</dt>
            <dd>
              {proposal.requester.name} · <Time value={proposal.requestedAt} />
            </dd>
          </div>
          <div>
            <dt>Proposal revision</dt>
            <dd>
              {proposal.revision} · {proposal.author.name}
            </dd>
          </div>
          {proposal.kind !== "plan" &&
            proposal.kind !== "meeting" &&
            proposal.kind !== "github" && (
              <div>
                <dt>Work version under review</dt>
                <dd>{proposal.targetVersion}</dd>
              </div>
            )}
          <div>
            <dt>Expires</dt>
            <dd>
              <Time value={proposal.expiresAt} />
            </dd>
          </div>
          {proposal.reviewer && proposal.reviewedAt && (
            <div>
              <dt>Reviewed by</dt>
              <dd>
                {proposal.reviewer.name} · <Time value={proposal.reviewedAt} />
              </dd>
            </div>
          )}
        </dl>
        {proposal.riskContext && (
          <div className="planning-actions">
            {proposal.riskContext.stale && (
              <p className="planning-conflict">
                The delay report or schedule changed. Refresh the risk before
                requesting a new approval.
              </p>
            )}
            <Link to={`${projectBase}/risks/${proposal.riskContext.id}`}>
              {proposal.riskContext.stale
                ? "Review latest risk"
                : "Open schedule risk"}
            </Link>
          </div>
        )}
        {proposal.kind === "meeting" && proposal.status === "stale" && (
          <p className="planning-conflict">
            Review the current transcript and reprocess its suggestions before
            submitting this follow-up again.
          </p>
        )}
        {proposal.reason && <p className="review-reason">{proposal.reason}</p>}
        {targetChanged && (
          <p className="planning-conflict">
            The work item is now at version {proposal.currentTargetVersion}.
            Review the latest work version and revise this proposal.
          </p>
        )}
        {current && proposal.status === "expired" && !receipt && (
          <p className="planning-conflict">
            This proposal expired. Revise it and submit it for a new review.
          </p>
        )}
        {proposal.status === "reconciliation_required" && (
          <p className="planning-conflict">
            Verify the recorded outcome before attempting another change.
          </p>
        )}
        {receipt?.issue && (
          <p className="planning-conflict">
            {receipt.issue === "ambiguous_effect" && proposal.kind === "github"
              ? "GitHub may have accepted this comment. Check the destination and audit history for the delivery reference."
              : issueMessage[receipt.issue]}
          </p>
        )}
        <section className="review-section">
          <h2>
            {proposal.kind === "plan"
              ? "Proposed tasks and dependencies"
              : proposal.kind === "meeting"
                ? "Proposed follow-up"
                : proposal.kind === "github"
                  ? "GitHub destination and comment"
                  : "Work item changes"}
          </h2>
          {proposal.kind === "github" && proposal.githubComment ? (
            <>
              <dl className="planning-facts">
                <div>
                  <dt>Repository</dt>
                  <dd>{proposal.githubComment.destination.repository}</dd>
                </div>
                <div>
                  <dt>Destination</dt>
                  <dd>
                    <a
                      href={`https://github.com/${proposal.githubComment.destination.repository}/${proposal.githubComment.destination.kind === "pull" ? "pull" : "issues"}/${proposal.githubComment.destination.number}`}
                      rel="noreferrer"
                    >
                      {proposal.githubComment.destination.kind === "pull"
                        ? "Pull request"
                        : "Issue"}{" "}
                      #{proposal.githubComment.destination.number}
                    </a>
                  </dd>
                </div>
              </dl>
              <h3>Exact outgoing Markdown</h3>
              <pre className="review-comment-body">
                {proposal.githubComment.body}
              </pre>
              <p className="planning-help">
                Kordos uses this delivery reference to verify publication.
              </p>
            </>
          ) : proposal.kind === "plan" && proposal.plan ? (
            <PlanPreview
              plan={proposal.plan}
              owners={proposal.owners}
              evidence={(task) => (
                <TaskEvidence task={task} evidence={proposal.evidence} />
              )}
              workLinks={Object.fromEntries(
                Object.entries(proposal.createdWork ?? {}).map(
                  ([candidate, id]) => [candidate, `${projectBase}/work/${id}`],
                ),
              )}
            />
          ) : proposal.kind === "meeting" && proposal.meetingItem ? (
            <>
              <dl className="planning-facts">
                <div>
                  <dt>Type</dt>
                  <dd>
                    {proposal.meetingItem.kind === "question"
                      ? "Open question"
                      : proposal.meetingItem.kind}
                  </dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>
                    {proposal.owners.find(
                      ({ id }) => id === proposal.meetingItem?.ownerId,
                    )?.name ?? "Unassigned"}
                  </dd>
                </div>
                <div>
                  <dt>
                    {proposal.meetingItem.kind === "decision"
                      ? "Effective date"
                      : "Due date"}
                  </dt>
                  <dd>
                    {proposal.meetingItem.date ??
                      (proposal.meetingItem.kind === "decision"
                        ? "Meeting date"
                        : "No date")}
                  </dd>
                </div>
              </dl>
              {proposal.meetingItem.detail && (
                <p>{proposal.meetingItem.detail}</p>
              )}
              {(proposal.meetingWorkId || proposal.meetingDecisionId) && (
                <div className="planning-actions">
                  {proposal.meetingWorkId && (
                    <Link to={`${projectBase}/work/${proposal.meetingWorkId}`}>
                      Open resulting task
                    </Link>
                  )}
                  {proposal.meetingDecisionId && (
                    <Link
                      to={`${projectBase}/documents/decisions/${proposal.meetingDecisionId}`}
                    >
                      Open confirmed decision
                    </Link>
                  )}
                </div>
              )}
            </>
          ) : proposal.kind !== "plan" &&
            proposal.kind !== "meeting" &&
            proposal.kind !== "github" &&
            proposal.before &&
            proposal.after ? (
            <ReviewDiff
              before={proposal.before}
              after={proposal.after}
              owners={proposal.owners}
            />
          ) : (
            <p className="planning-help">
              Access to the complete evidence is required to view the proposed
              values.
            </p>
          )}
        </section>
        {proposal.kind !== "github" && (
          <section className="review-section">
            <h2>Evidence</h2>
            {(proposal.kind === "plan"
              ? proposal.evidence.slice(0, 1)
              : proposal.evidence
            ).map((entry, index) => (
              <EvidencePassage
                key={citationPath(workspace.id, entry.source) + index}
                entry={entry}
              />
            ))}
            {proposal.evidenceRestricted ? (
              <p className="planning-help">
                Some evidence changed or is unavailable.
              </p>
            ) : (
              !proposal.evidence.length && (
                <p className="planning-help">No evidence was attached.</p>
              )
            )}
          </section>
        )}
        {receipt && (
          <section className="review-section">
            <h2>Approval receipt</h2>
            <p className="review-receipt-id">{receipt.id}</p>
            <p>
              {receipt.reviewer.name} approved the change on{" "}
              <Time value={receipt.approvedAt} />.
            </p>
            {receipt.finishedAt && (
              <p>
                Outcome recorded on <Time value={receipt.finishedAt} />.
              </p>
            )}
            <div className="planning-actions">
              {receipt.remote && (
                <a href={receipt.remote.url} rel="noreferrer">
                  Open published comment
                </a>
              )}
              <Link
                to={workspacePath(
                  `/audit?eventId=${receipt.auditId}`,
                  workspace.id,
                )}
              >
                Open receipt in audit history
              </Link>
              {receipt.effectEventId && (
                <Link
                  to={workspacePath(
                    `/audit?eventId=${receipt.effectEventId}`,
                    workspace.id,
                  )}
                >
                  {proposal.kind === "plan"
                    ? "Open applied plan in audit history"
                    : proposal.kind === "meeting"
                      ? "Open approved follow-up in audit history"
                      : proposal.kind === "github"
                        ? "Open publication in audit history"
                        : "Open applied work edit"}
                </Link>
              )}
            </div>
          </section>
        )}
        {editor &&
          editor.kind !== "meeting" &&
          proposal.canEdit &&
          (editor.kind === "plan" ? (
            <PlanRevisionEditor
              proposal={editor}
              head={head}
              path={path}
              onClose={() => setEditor(undefined)}
            />
          ) : editor.kind === "github" && editor.githubComment ? (
            <GitHubCommentEditor
              body={editor.githubComment.message}
              precondition={precondition}
              path={path}
              onClose={() => setEditor(undefined)}
              head={head}
            />
          ) : editor.kind !== "github" ? (
            <ProposalEditor
              proposal={editor}
              head={head}
              path={path}
              onClose={() => setEditor(undefined)}
            />
          ) : null)}
        {decision && proposal.canReview && (
          <form
            className="planning-form"
            onSubmit={(event) => {
              event.preventDefault();
              review(decision);
            }}
          >
            <label>
              {decision === "reject"
                ? "Reason for rejection"
                : "Changes requested"}
              <textarea
                required
                maxLength={1500}
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="planning-actions">
              <Button type="submit" disabled={command.busy || !reason.trim()}>
                {decision === "reject"
                  ? "Confirm rejection"
                  : "Send edit request"}
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  setDecision(undefined);
                  setReason("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {!decision &&
          !editor &&
          (proposal.canSubmit || proposal.canReview || proposal.canEdit) && (
            <div
              className="review-actions planning-actions"
              aria-label="Review actions"
            >
              {proposal.canSubmit && (
                <Button
                  disabled={command.busy}
                  onClick={() => review("submit")}
                >
                  Submit for review
                </Button>
              )}
              {proposal.canReview && !targetChanged && (
                <Button
                  disabled={command.busy}
                  onClick={() => review("approve")}
                >
                  {proposal.kind === "plan"
                    ? "Approve plan"
                    : proposal.kind === "github"
                      ? "Approve comment"
                      : "Approve change"}
                </Button>
              )}
              {proposal.canEdit && (
                <Button
                  variant="secondary"
                  disabled={command.busy}
                  onClick={() => {
                    command.clearError();
                    setEditor(proposal);
                  }}
                >
                  {targetChanged ||
                  proposal.status === "stale" ||
                  proposal.status === "expired"
                    ? "Review latest changes"
                    : "Edit proposal"}
                </Button>
              )}
              {proposal.canReview && (
                <>
                  <Button
                    variant="quiet"
                    disabled={command.busy}
                    onClick={() => {
                      command.clearError();
                      setDecision("request-edit");
                    }}
                  >
                    Request edit
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={command.busy}
                    onClick={() => {
                      command.clearError();
                      setDecision("reject");
                    }}
                  >
                    Reject
                  </Button>
                </>
              )}
            </div>
          )}
        {command.error && (
          <p className="planning-error" role="alert">
            {command.error.message}
          </p>
        )}
        <p className="planning-notice" role="status">
          {command.notice}
        </p>
      </section>
    </>
  );
}

function PlanRevisionEditor({
  proposal,
  path,
  head,
  onClose,
}: {
  proposal: Extract<ProposalDetail, { kind: "plan" }>;
  path: string;
  head: string;
  onClose: () => void;
}) {
  const { api, key } = usePlanning();
  const navigate = useNavigate();
  const command = usePlanningCommand();
  const people = useQuery({
    queryKey: [...key, "project", proposal.projectId, "people"],
    queryFn: ({ signal }) =>
      read(
        `${api}/projects/${proposal.projectId}/people`,
        projectPeopleSchema,
        signal,
      ),
    ...planningRefresh,
  });
  if (people.isPending)
    return <AsyncState kind="loading" message="Loading eligible owners…" />;
  if (people.isError)
    return (
      <AsyncState
        kind="error"
        message="Could not load eligible owners."
        retry={() => void people.refetch()}
      />
    );
  return (
    <section className="review-section">
      <h2>Revise plan</h2>
      <PlanEditor
        initial={proposal.plan}
        owners={people.data.owners}
        busy={command.busy}
        evidence={(task) => (
          <TaskEvidence task={task} evidence={proposal.evidence} />
        )}
        onCancel={onClose}
        onSave={(plan) => {
          const validated = briefPlanSchema.safeParse(plan);
          if (!validated.success) {
            command.invalid("Check the task titles, dates and estimates.");
            return;
          }
          void command.save(
            path,
            "PATCH",
            {
              revision: proposal.revision,
              expectedVersion: proposal.version,
              plan: validated.data,
            },
            () => {
              onClose();
              navigate(head, { replace: true });
            },
          );
        }}
      />
      {command.error && (
        <p className="planning-error" role="alert">
          {command.error.message}
        </p>
      )}
    </section>
  );
}

function ProposalEditor({
  proposal,
  head,
  path,
  onClose,
}: {
  proposal: Exclude<ProposalDetail, { kind: "plan" | "meeting" | "github" }>;
  head: string;
  path: string;
  onClose: () => void;
}) {
  const { api, key, workspace } = usePlanning();
  const navigate = useNavigate();
  const project = `${api}/projects/${proposal.projectId}`;
  const item = useQuery({
    queryKey: [
      ...key,
      "review-editor",
      proposal.id,
      proposal.revision,
      "target",
    ],
    queryFn: ({ signal }) =>
      read(`${project}/work/${proposal.workId}`, workItemSchema, signal),
    gcTime: 0,
    staleTime: 0,
  });
  const people = useQuery({
    queryKey: [...key, "project", proposal.projectId, "people"],
    queryFn: ({ signal }) =>
      read(project + "/people", projectPeopleSchema, signal),
    ...planningRefresh,
  });
  const [initial, setInitial] = useState<WorkFields>();

  if (item.isPending || people.isPending)
    return <AsyncState kind="loading" message="Loading current work values…" />;
  if (item.isError || people.isError)
    return (
      <AsyncState
        kind="error"
        message="Could not load current work values."
        retry={() => {
          void item.refetch();
          void people.refetch();
        }}
      />
    );

  const values = item.data;
  return (
    <section className="review-section">
      <h2>Revise proposal</h2>
      <p className="planning-help">
        Editing creates a new revision and requires a new approval.
      </p>
      {proposal.evidenceRestricted && (
        <p className="planning-conflict">
          Verify and reattach any unavailable evidence before submitting the new
          proposal.
        </p>
      )}
      {proposal.targetVersion !== values.version &&
      proposal.before &&
      proposal.after &&
      !initial ? (
        <>
          <p>
            Work version {values.version} is now current. Review the intervening
            changes before carrying forward your proposal.
          </p>
          <ReviewDiff
            before={proposal.before}
            after={values}
            owners={people.data.owners}
            applied
          />
          <div className="planning-actions">
            <Button
              onClick={() =>
                setInitial(
                  retainEdits(proposal.after!, proposal.before!, values),
                )
              }
            >
              Keep proposed edits on latest version
            </Button>
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <WorkEditor
          path={path}
          item={values}
          owners={people.data.owners}
          lead
          canSave={!values.archived}
          proposal={{
            initial: initial ?? proposal.after ?? undefined,
            evidenceLinks: proposal.evidence.map(({ source }) =>
              citationPath(workspace.id, source),
            ),
            revision: {
              revision: proposal.revision,
              expectedVersion: proposal.version,
            },
          }}
          onSaved={() => {
            onClose();
            navigate(head, { replace: true });
          }}
          onCancel={onClose}
        />
      )}
    </section>
  );
}

function GitHubCommentEditor({
  body,
  precondition,
  path,
  head,
  onClose,
}: {
  body: string;
  precondition: { revision: number; expectedVersion: number };
  path: string;
  head: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(body);
  const command = usePlanningCommand();
  const navigate = useNavigate();
  return (
    <form
      className="planning-form"
      onSubmit={(event) => {
        event.preventDefault();
        void command.save(
          path,
          "PATCH",
          { ...precondition, body: draft },
          () => {
            navigate(head, { replace: true });
            onClose();
          },
        );
      }}
    >
      <label>
        Comment body
        <textarea
          required
          rows={5}
          maxLength={12000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="planning-actions">
        <Button type="submit" disabled={command.busy || !draft.trim()}>
          Save revision
        </Button>
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {command.error && <p role="alert">{command.error.message}</p>}
    </form>
  );
}
