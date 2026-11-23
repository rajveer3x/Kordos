import {
  auditFilterSchema,
  auditPageSchema,
  type AuditEntry,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AsyncState, Button, PageHeading } from "../../components/ui";
import { GitHubActivity } from "../connectors/github-activity";
import { denied, read } from "../identity/api";
import {
  planningRefresh,
  useLiveProject,
  usePlanning,
} from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import { ReviewDiff } from "./review-diff";
import "./reviews.css";

const actions: Record<string, string> = {
  "github.comment_published": "GitHub comment published",
  "github.work_link_changed": "GitHub work link changed",
  "work.created": "Work item created",
  "work.edited": "Work item edited",
  "work.completed": "Work item completed",
  "work.reopened": "Work item reopened",
  "work.archived": "Work item archived",
  "work.restored": "Work item restored",
  "proposal.drafted": "Proposal drafted",
  "proposal.revised": "Proposal revised",
  "proposal.submitted": "Proposal submitted",
  "proposal.approved": "Proposal approved",
  "proposal.applying": "Approval claimed",
  "proposal.applied": "Approved change applied",
  "proposal.plan_created": "Approved project plan created",
  "meeting.created": "Meeting created",
  "meeting.edited": "Meeting details edited",
  "meeting.audio_queued": "Recording queued",
  "meeting.audio_removed": "Recording removed",
  "meeting.transcript_corrected": "Transcript corrected",
  "meeting.item_submitted": "Meeting follow-up submitted",
  "meeting.item_rejected": "Meeting follow-up rejected",
  "proposal.meeting_accepted": "Meeting follow-up approved",
  "risk.assessed": "Delay report assessed",
  "risk.severity_changed": "Risk severity changed",
  "risk.acknowledged": "Schedule risk acknowledged",
  "risk.resolved": "Schedule risk resolved",
  "risk.replan_submitted": "Replan submitted for approval",
  "risk.clarified": "Delayed task confirmed",
  "risk.refreshed": "Risk forecast refreshed",
  "brief.reused": "Saved brief opened",
  "brief.queued": "Brief extraction queued",
  "brief.running": "Brief extraction started",
  "brief.ready": "Brief candidates prepared",
  "brief.failed": "Brief extraction failed",
  "proposal.stale": "Approval became stale",
  "proposal.rejected": "Proposal rejected",
  "proposal.expired": "Approval expired",
  "proposal.failed": "Approval failed",
  "proposal.edits_requested": "Proposal edits requested",
  "proposal.reconciliation_required": "Reconciliation required",
};

function title(event: AuditEntry) {
  if (event.action === "work.edited")
    return event.receiptId
      ? "Agent work item edited"
      : "Manual work item edited";
  return (
    actions[event.action] ??
    event.action
      .replaceAll(/[._]/g, " ")
      .replace(/^./, (first) => first.toUpperCase())
  );
}

export function ProjectAudit() {
  const { details } = useLiveProject();
  return (
    <div className="project-activity">
      <GitHubActivity projectId={details.id} />
      <AuditPage projectId={details.id} />
    </div>
  );
}

export function AuditPage({ projectId }: { projectId?: string }) {
  const { api, key } = usePlanning();
  const [search, setSearch] = useSearchParams();
  const params = new URLSearchParams(search);
  if (projectId) params.set("projectId", projectId);
  const query = params.toString();
  const result = useQuery({
    queryKey: [...key, "audit", query],
    queryFn: ({ signal }) =>
      read(api + "/audit?" + query, auditPageSchema, signal),
    ...planningRefresh,
  });

  function clearCursor() {
    const next = new URLSearchParams(search);
    next.delete("cursor");
    setSearch(next);
  }

  return (
    <div className={projectId ? undefined : "standard-page"}>
      <title>Audit history · Kordos</title>
      {!projectId && <PageHeading title="Audit history" />}
      <section className="glass-panel planning-panel">
        {projectId && <h2>Audit history</h2>}
        <AuditFilters
          key={query}
          search={search}
          projectId={projectId}
          onFilter={setSearch}
        />
        {result.isPending ? (
          <AsyncState kind="loading" message="Loading audit history…" />
        ) : result.isError ? (
          <AsyncState
            kind="error"
            message={
              denied(result.error)
                ? "Audit history is unavailable."
                : "Could not load audit history."
            }
            retry={
              denied(result.error) ? undefined : () => void result.refetch()
            }
          />
        ) : (
          <>
            {result.data.items.length ? (
              <ol className="review-list audit-list">
                {result.data.items.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    search={search}
                    projectId={projectId}
                  />
                ))}
              </ol>
            ) : (
              <p className="planning-help">
                {search.has("eventId")
                  ? "This audit event is unavailable."
                  : "No audit events match these filters."}
              </p>
            )}
            <div className="planning-actions">
              {search.has("cursor") && (
                <Button variant="quiet" onClick={clearCursor}>
                  Latest events
                </Button>
              )}
              {result.data.nextCursor && (
                <Button
                  variant="quiet"
                  onClick={() => {
                    const next = new URLSearchParams(search);
                    next.set("cursor", result.data.nextCursor!);
                    setSearch(next);
                  }}
                >
                  Older events
                </Button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function AuditFilters({
  search,
  projectId,
  onFilter,
}: {
  search: URLSearchParams;
  projectId?: string;
  onFilter: (params: URLSearchParams) => void;
}) {
  const [error, setError] = useState("");
  return (
    <form
      className="planning-filters"
      onSubmit={(event) => {
        event.preventDefault();
        const next = new URLSearchParams();
        for (const [field, value] of new FormData(event.currentTarget)) {
          if (typeof value === "string" && value.trim())
            next.set(field, value.trim());
        }
        const parsed = auditFilterSchema.safeParse(Object.fromEntries(next));
        if (!parsed.success) {
          setError("Check the IDs, GitHub comment URL and date range.");
          return;
        }
        setError("");
        onFilter(next);
      }}
    >
      {!projectId && (
        <label>
          Project ID
          <input
            name="projectId"
            defaultValue={search.get("projectId") ?? ""}
          />
        </label>
      )}
      <label>
        Actor ID
        <input name="actorId" defaultValue={search.get("actorId") ?? ""} />
      </label>
      <label>
        Target ID
        <input name="targetId" defaultValue={search.get("targetId") ?? ""} />
      </label>
      <label>
        GitHub comment URL
        <input
          type="url"
          name="githubCommentUrl"
          defaultValue={search.get("githubCommentUrl") ?? ""}
        />
      </label>
      <label>
        From date (UTC)
        <input
          name="from"
          type="date"
          defaultValue={search.get("from") ?? ""}
        />
      </label>
      <label>
        Through date (UTC)
        <input name="to" type="date" defaultValue={search.get("to") ?? ""} />
      </label>
      <div className="planning-actions">
        <Button type="submit">Filter</Button>
        {search.size > 0 && (
          <Button
            variant="quiet"
            onClick={() => {
              setError("");
              onFilter(new URLSearchParams());
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      {error && (
        <p className="planning-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function AuditRow({
  entry,
  search,
  projectId,
}: {
  entry: AuditEntry;
  search: URLSearchParams;
  projectId?: string;
}) {
  const { workspace } = usePlanning();
  function filter(field: "actorId" | "projectId" | "targetId", value: string) {
    const next = new URLSearchParams(search);
    next.delete("eventId");
    next.delete("cursor");
    next.set(field, value);
    return "?" + next.toString();
  }
  return (
    <li>
      <div className="planning-item-copy">
        <strong>{title(entry)}</strong>
        <span>
          {entry.actorType === "service" && "Approval worker · authorized by "}
          <Link
            aria-label={`Filter by actor ${entry.actor.name}`}
            to={filter("actorId", entry.actor.id)}
          >
            {entry.actor.name}
          </Link>
          {" · "}
          <time dateTime={entry.occurredAt}>
            {new Date(entry.occurredAt).toLocaleString()}
          </time>
          {!projectId && entry.projectId && (
            <>
              {" · "}
              <Link
                aria-label={`Filter by project ${entry.projectName}`}
                to={filter("projectId", entry.projectId)}
              >
                {entry.projectName}
              </Link>
            </>
          )}
        </span>
      </div>
      {entry.after && (
        <p>
          {entry.after.title} · Work version {entry.after.version}
        </p>
      )}
      <div className="planning-actions">
        {entry.projectId && entry.workId && (
          <Link
            to={workspacePath(
              `${projectPath(entry.projectId, "work")}/${entry.workId}`,
              workspace.id,
            )}
          >
            Open work item
          </Link>
        )}
        {entry.proposalId && entry.revision && (
          <Link
            to={workspacePath(
              `/reviews/${entry.proposalId}?revision=${entry.revision}`,
              workspace.id,
            )}
          >
            Review revision {entry.revision}
          </Link>
        )}
        {entry.receiptId && (
          <span className="planning-help review-receipt-id">
            Receipt {entry.receiptId}
          </span>
        )}
        {search.get("targetId") !== entry.targetId && (
          <Link to={filter("targetId", entry.targetId)}>Target history</Link>
        )}
      </div>
      {entry.before && entry.after && (
        <details>
          <summary>Field changes</summary>
          <ReviewDiff before={entry.before} after={entry.after} applied />
        </details>
      )}
    </li>
  );
}
