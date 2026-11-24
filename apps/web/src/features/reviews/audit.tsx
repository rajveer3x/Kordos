import {
  activitySourceSchema,
  activityTypeSchema,
  auditFilterSchema,
  auditPageSchema,
  idSchema,
  type AuditEntry,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { AsyncState, Button, PageHeading } from "../../components/ui";
import { GitHubActivity } from "../connectors/github-activity";
import { denied, read } from "../identity/api";
import { citationPath } from "../knowledge/knowledge-client";
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
  "duplicate.dismiss": "Duplicate suggestion dismissed",
  "duplicate.proposal_reused": "Existing consolidation proposal opened",
  "duplicate.relate": "Tasks linked as related",
  "duplicate.consolidated": "Tasks consolidated",
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

const activityTypes: Record<AuditEntry["type"], string> = {
  work: "Work",
  dependency: "Dependencies",
  discussion: "Discussion",
  document: "Documents",
  decision: "Decisions",
  meeting: "Meetings",
  risk: "Risks",
  review: "Reviews",
  brief: "Briefs",
  project: "Project changes",
  connector: "Connector activity",
  other: "Other",
};

const activitySources: Record<AuditEntry["source"], string> = {
  workspace: "Workspace",
  github: "GitHub",
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
  const [search] = useSearchParams();
  const showGitHub =
    search.get("source") !== "workspace" &&
    ![
      "actorId",
      "type",
      "targetId",
      "from",
      "to",
      "eventId",
      "selected",
      "cursor",
    ].some((key) => search.has(key));
  return (
    <div className="project-activity">
      {showGitHub && <GitHubActivity projectId={details.id} />}
      <AuditPage projectId={details.id} />
    </div>
  );
}

export function AuditPage({ projectId }: { projectId?: string }) {
  const { api, key } = usePlanning();
  const [search, setSearch] = useSearchParams();
  const selectedId = projectId
    ? idSchema.safeParse(search.get("selected")).data
    : undefined;
  const params = new URLSearchParams(search);
  params.delete("selected");
  if (projectId) params.set("projectId", projectId);
  const query = params.toString();
  const result = useQuery({
    queryKey: [...key, "audit", query],
    queryFn: ({ signal }) =>
      read(api + "/audit?" + query, auditPageSchema, signal),
    ...planningRefresh,
  });

  const selected = useQuery({
    queryKey: [...key, "audit", "event", projectId, selectedId],
    queryFn: ({ signal }) =>
      read(
        `${api}/audit?${new URLSearchParams({
          projectId: projectId!,
          eventId: selectedId!,
        })}`,
        auditPageSchema,
        signal,
      ),
    enabled: !!selectedId,
    ...planningRefresh,
  });

  function clearCursor() {
    const next = new URLSearchParams(search);
    next.delete("cursor");
    next.delete("selected");
    setSearch(next);
  }

  return (
    <div className={projectId ? undefined : "standard-page"}>
      <title>{projectId ? "Project activity" : "Audit history"} · Kordos</title>
      {!projectId && <PageHeading title="Audit history" />}
      <section className="glass-panel planning-panel">
        {projectId && <h2>Activity history</h2>}
        {selectedId && (
          <SelectedActivity key={selectedId} search={search}>
            {selected.isPending ? (
              <AsyncState kind="loading" message="Loading activity event…" />
            ) : selected.isError ? (
              <AsyncState
                kind="error"
                message="Could not load this activity event."
                retry={() => void selected.refetch()}
              />
            ) : selected.data?.items[0] ? (
              <ol className="review-list audit-list">
                <AuditRow
                  entry={selected.data.items[0]}
                  projectId={projectId}
                  search={search}
                  selected
                />
              </ol>
            ) : (
              <p className="planning-help">
                This activity event is unavailable.
              </p>
            )}
          </SelectedActivity>
        )}
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
                    next.delete("selected");
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

function SelectedActivity({
  search,
  children,
}: {
  search: URLSearchParams;
  children: React.ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const close = new URLSearchParams(search);
  close.delete("selected");
  return (
    <section className="selected-activity">
      <div className="planning-heading">
        <h3 ref={heading} tabIndex={-1}>
          Selected event
        </h3>
        <Link to={`?${close}`}>Close event</Link>
      </div>
      {children}
    </section>
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
  const sourceLabel = useId();
  const typeLabel = useId();
  const extraFilters = (
    <>
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
    </>
  );
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
          setError("Check the activity filters, IDs, and date range.");
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
        <span id={sourceLabel}>Source</span>
        <select
          name="source"
          aria-labelledby={sourceLabel}
          defaultValue={search.get("source") ?? ""}
        >
          <option value="">All sources</option>
          {activitySourceSchema.options.map((value) => (
            <option key={value} value={value}>
              {activitySources[value]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span id={typeLabel}>Type</span>
        <select
          name="type"
          aria-labelledby={typeLabel}
          defaultValue={search.get("type") ?? ""}
        >
          <option value="">All types</option>
          {activityTypeSchema.options.map((value) => (
            <option key={value} value={value}>
              {activityTypes[value]}
            </option>
          ))}
        </select>
      </label>
      {projectId ? (
        <details
          className="activity-filter-options"
          open={
            ["targetId", "githubCommentUrl", "from", "to"].some((key) =>
              search.has(key),
            ) || undefined
          }
        >
          <summary>More filters</summary>
          <div className="planning-filters">{extraFilters}</div>
        </details>
      ) : (
        extraFilters
      )}
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
  selected = false,
}: {
  entry: AuditEntry;
  search: URLSearchParams;
  projectId?: string;
  selected?: boolean;
}) {
  const { workspace } = usePlanning();
  const location = useLocation();
  const activityReturn = projectId
    ? { activityReturn: location.pathname + location.search }
    : undefined;
  const selection = new URLSearchParams(search);
  selection.set("selected", entry.id);
  const source = entry.projectId
    ? entityLink(workspace.id, entry.projectId, entry.entity)
    : undefined;
  function filter(field: "actorId" | "projectId" | "targetId", value: string) {
    const next = new URLSearchParams(search);
    next.delete("eventId");
    next.delete("selected");
    next.delete("cursor");
    next.set(field, value);
    return "?" + next.toString();
  }
  return (
    <li>
      <div className="planning-item-copy">
        <strong>{title(entry)}</strong>
        <span>
          {entry.actorType === "service" && "Worker · attributed to "}
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
          {projectId &&
            ` · ${activitySources[entry.source]} · ${activityTypes[entry.type]}`}
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
        {projectId && !selected && (
          <Link to={`?${selection}`} aria-label={`Open event: ${title(entry)}`}>
            Open event
          </Link>
        )}
        {entry.projectId && entry.workId && (
          <Link
            to={workspacePath(
              `${projectPath(entry.projectId, "work")}/${entry.workId}`,
              workspace.id,
            )}
            state={activityReturn}
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
            state={activityReturn}
          >
            Review revision {entry.revision}
          </Link>
        )}
        {source && (
          <Link to={source.path} state={activityReturn}>
            {source.label}
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

function entityLink(
  workspace: string,
  projectId: string,
  entity: AuditEntry["entity"],
) {
  if (!entity || entity.kind === "work" || entity.kind === "review") return;
  const project = projectPath(projectId);
  const { id, revision } = entity;
  const version = revision ? `?revision=${revision}` : "";
  if (entity.kind === "comment") {
    return {
      path: citationPath(workspace, { kind: "comment", projectId, id }),
      label: "Open comment",
    };
  }
  const [path, label] = {
    document: [`/documents/${id}${version}`, "Open document"],
    decision: [`/documents/decisions/${id}`, "Open decision"],
    meeting: [`/meetings/${id}`, "Open meeting"],
    risk: [`/risks/${id}`, "Open risk"],
    brief: [`/briefs/${id}`, "Open brief"],
    github: [`/documents/sources/${id}`, "Open GitHub source"],
  }[entity.kind];
  return { path: workspacePath(project + path, workspace), label };
}
