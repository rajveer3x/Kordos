import {
  idSchema,
  riskDetailSchema,
  riskPageSchema,
  type RiskDetail,
  type RiskSummary,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  AsyncState,
  Button,
  PageHeading,
  StatusLabel,
} from "../../components/ui";
import { denied, read } from "../identity/api";
import { EvidencePassage } from "../knowledge/evidence-passage";
import {
  planningRefresh,
  useLiveProject,
  usePlanning,
  usePlanningCommand,
} from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import "./risks.css";

const severityLabel = {
  at_risk: "At risk",
  watch: "Forecast moved",
  clarify: "Needs clarification",
  unchanged: "No milestone delay",
};

function useRiskPaths() {
  const { details } = useLiveProject();
  const { api, key, workspace } = usePlanning();
  const path = projectPath(details.id);
  return {
    api: api + path + "/risks",
    base: workspacePath(path, workspace.id),
    key: [...key, "risks", details.id],
    projectId: details.id,
    workspaceId: workspace.id,
  };
}

function RiskStatus({ finding }: { finding: RiskSummary }) {
  if (finding.superseded) return <StatusLabel>Superseded</StatusLabel>;
  if (finding.status === "resolved")
    return <StatusLabel tone="confirmed">Resolved</StatusLabel>;
  return (
    <StatusLabel tone={finding.severity === "at_risk" ? "risk" : "neutral"}>
      {severityLabel[finding.severity]}
    </StatusLabel>
  );
}

function RiskRows({ items, base }: { items: RiskSummary[]; base: string }) {
  return (
    <ul className="risk-list">
      {items.map((finding) => (
        <li key={finding.id}>
          <div className="planning-item-copy">
            <Link to={`${base}/risks/${finding.id}`}>{finding.title}</Link>
            <span>
              {finding.author.name} ·{" "}
              <time dateTime={finding.capturedAt}>
                {new Date(finding.capturedAt).toLocaleDateString()}
              </time>
            </span>
          </div>
          <RiskStatus finding={finding} />
        </li>
      ))}
    </ul>
  );
}

function useRiskList(history = false, cursor?: string) {
  const paths = useRiskPaths();
  const search = new URLSearchParams({
    ...(history ? { history: "true" } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const query = search.size ? "?" + search : "";
  const result = useQuery({
    queryKey: [...paths.key, query],
    queryFn: ({ signal }) => read(paths.api + query, riskPageSchema, signal),
    ...planningRefresh,
  });
  return { ...paths, result };
}

export function RiskOverview() {
  const { base, result } = useRiskList();
  return (
    <section
      className="glass-panel planning-panel"
      aria-labelledby="risks-heading"
    >
      <div className="planning-heading">
        <h2 id="risks-heading">Schedule risks</h2>
        <Link to={`${base}/risks`}>Risk history</Link>
      </div>
      {result.isPending ? (
        <AsyncState kind="loading" message="Loading schedule risks…" />
      ) : result.isError ? (
        <AsyncState
          kind="error"
          message="Could not load schedule risks."
          retry={denied(result.error) ? undefined : () => void result.refetch()}
        />
      ) : result.data.items.length > 0 ? (
        <RiskRows items={result.data.items.slice(0, 5)} base={base} />
      ) : (
        <p className="planning-help">No active schedule risks.</p>
      )}
    </section>
  );
}

export function RiskHistory() {
  const [search, setSearch] = useSearchParams();
  const active = search.get("view") === "active";
  const cursor = idSchema.safeParse(search.get("cursor")).data;
  const { base, result } = useRiskList(!active, cursor);
  return (
    <section className="glass-panel planning-panel risk-detail">
      <title>Risk history · Kordos</title>
      <Link to={base}>Project overview</Link>
      <PageHeading title="Risk history" />
      <div className="planning-actions" role="group" aria-label="Risk view">
        <Button
          variant={active ? "quiet" : "secondary"}
          aria-pressed={!active}
          onClick={() => setSearch({})}
        >
          All findings
        </Button>
        <Button
          variant={active ? "secondary" : "quiet"}
          aria-pressed={active}
          onClick={() => setSearch({ view: "active" })}
        >
          Active risks
        </Button>
      </div>
      {result.isPending ? (
        <AsyncState kind="loading" message="Loading findings…" />
      ) : result.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(result.error)
              ? "Risk history is unavailable."
              : "Could not load risk history."
          }
          retry={denied(result.error) ? undefined : () => void result.refetch()}
        />
      ) : result.data.items.length > 0 ? (
        <RiskRows items={result.data.items} base={base} />
      ) : (
        <p className="planning-help">There are no findings in this view.</p>
      )}
      <div className="planning-actions">
        {cursor && (
          <Button
            variant="quiet"
            onClick={() => setSearch(active ? { view: "active" } : {})}
          >
            Back to latest
          </Button>
        )}
        {result.data?.nextCursor && (
          <Button
            variant="quiet"
            onClick={() =>
              setSearch({
                ...(active ? { view: "active" } : {}),
                cursor: result.data.nextCursor!,
              })
            }
          >
            Older findings
          </Button>
        )}
      </div>
    </section>
  );
}

export function RiskPage() {
  const paths = useRiskPaths();
  const { riskId } = useParams();
  const endpoint = `${paths.api}/${riskId}`;
  const result = useQuery({
    queryKey: [...paths.key, riskId],
    queryFn: ({ signal }) => read(endpoint, riskDetailSchema, signal),
    ...planningRefresh,
  });
  if (result.isPending)
    return <AsyncState kind="loading" message="Loading finding…" />;
  if (result.isError)
    return (
      <AsyncState
        kind="error"
        message={
          denied(result.error)
            ? "This finding is unavailable."
            : "Could not load the finding."
        }
        retry={denied(result.error) ? undefined : () => void result.refetch()}
      />
    );
  return (
    <RiskDetails
      key={result.data.id}
      finding={result.data}
      endpoint={endpoint}
      base={paths.base}
      projectId={paths.projectId}
      workspaceId={paths.workspaceId}
    />
  );
}

function RiskDetails({
  finding,
  endpoint,
  base,
  projectId,
  workspaceId,
}: {
  finding: RiskDetail;
  endpoint: string;
  base: string;
  projectId: string;
  workspaceId: string;
}) {
  const { assessment, calendar, source } = finding;
  const { actorId } = usePlanning();
  const missingDate = !assessment.handoff || assessment.handoff < finding.asOf;
  const command = usePlanningCommand();
  const navigate = useNavigate();
  const [selection, setSelection] = useState("");
  const [reason, setReason] = useState("");
  const [selectedMilestone, setSelectedMilestone] = useState(
    assessment.milestones[0]?.id ?? "",
  );
  const [commitment, setCommitment] = useState(
    assessment.milestones[0]?.forecast ?? "",
  );
  const milestone = assessment.milestones.find(
    ({ id }) => id === selectedMilestone,
  );
  const riskUrl = (id: string) => `${base}/risks/${id}`;
  const reviewUrl = (id: string) =>
    workspacePath(`/reviews/${id}`, workspaceId);
  const workUrl = (id: string) => `${base}/work/${id}`;
  function act(fields: { action: string } & Record<string, string>) {
    void command.save(
      endpoint,
      "POST",
      { ...fields, expectedVersion: finding.version },
      (id) => {
        if (fields.action === "replan") navigate(reviewUrl(id));
        else if (id !== finding.id) navigate(riskUrl(id));
        else setReason("");
      },
    );
  }

  return (
    <section className="glass-panel planning-panel risk-detail">
      <title>{finding.title} · Schedule risk · Kordos</title>
      <Link to={`${base}/risks`}>Risk history</Link>
      <PageHeading
        title={
          assessment.task
            ? `Delay report for ${assessment.task.title}`
            : "Unconfirmed delay report"
        }
      />
      <div className="planning-actions">
        <RiskStatus finding={finding} />
        {finding.status === "acknowledged" && (
          <StatusLabel>Acknowledged</StatusLabel>
        )}
        {finding.previousId && (
          <Link to={riskUrl(finding.previousId)}>Previous finding</Link>
        )}
        {finding.nextId && (
          <Link to={riskUrl(finding.nextId)}>Latest finding</Link>
        )}
        {finding.proposalId && (
          <Link to={reviewUrl(finding.proposalId)}>Open replan proposal</Link>
        )}
      </div>
      {finding.review && (
        <p className="planning-help">
          Reviewed by {finding.review.actor.name} ·{" "}
          <time dateTime={finding.review.occurredAt}>
            {new Date(finding.review.occurredAt).toLocaleString()}
          </time>
          {finding.review.reason && <> · {finding.review.reason}</>}
        </p>
      )}
      {finding.superseded && (
        <p className="planning-conflict">
          A newer source or assessment superseded this forecast.{" "}
          {finding.nextId
            ? "Open the latest finding to review it."
            : "Check the updated discussion and risk history."}
        </p>
      )}
      {finding.staleSchedule &&
        !finding.superseded &&
        finding.status !== "resolved" && (
          <p className="planning-conflict">
            The project schedule changed. Refresh the forecast before submitting
            a replan.
          </p>
        )}
      <section className="risk-section">
        <h2>Evidence</h2>
        <EvidencePassage
          entry={{
            source: { kind: "comment", projectId, id: source.id },
            title: `Delay report · Revision ${source.version}`,
            excerpt: assessment.excerpt,
            author: finding.author,
            capturedAt: finding.capturedAt,
            newer: finding.sourceChanged,
            subject: source.subject,
          }}
        />
        {assessment.severity === "clarify" &&
          !finding.superseded &&
          !finding.canClarify && (
            <p className="planning-help">
              {missingDate && actorId === finding.author.id
                ? "Edit your comment with a specific handoff date."
                : missingDate
                  ? `Ask ${finding.author.name} to add a specific handoff date.`
                  : `Ask ${finding.author.name} to confirm which task is delayed.`}
            </p>
          )}
        {finding.canClarify && (
          <form
            className="planning-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (selection) act({ action: "clarify", taskId: selection });
            }}
          >
            <ul className="risk-candidates">
              {assessment.candidates.map((task) => (
                <li key={task.id}>
                  <Link to={workUrl(task.id)}>{task.title}</Link> ·{" "}
                  {task.owner?.name ?? "Unassigned"} · {task.id.slice(-8)}
                </li>
              ))}
            </ul>
            <label>
              Which task is delayed?
              <select
                required
                value={selection}
                onChange={(event) => setSelection(event.target.value)}
              >
                <option value="">Choose task</option>
                {assessment.candidates.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title} · {task.owner?.name ?? "Unassigned"} ·{" "}
                    {task.id.slice(-8)}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={command.busy || !selection}>
              Confirm delayed task
            </Button>
          </form>
        )}
      </section>
      {assessment.task && (
        <section className="risk-section">
          <h2>Scenario comparison</h2>
          <dl className="planning-facts">
            <div>
              <dt>Reported handoff</dt>
              <dd>{assessment.handoff ?? "Needs a date"}</dd>
            </div>
            <div>
              <dt>Schedule as of</dt>
              <dd>{finding.asOf}</dd>
            </div>
            <div>
              <dt>Calendar</dt>
              <dd>{calendar.timeZone}</dd>
            </div>
          </dl>
          {assessment.milestones.map((item) => (
            <div key={item.id} className="risk-milestone">
              <h3>
                <Link to={workUrl(item.id)}>{item.title}</Link>
              </h3>
              <dl className="planning-facts">
                <div>
                  <dt>Committed</dt>
                  <dd>{item.commitment ?? "No commitment"}</dd>
                </div>
                <div>
                  <dt>Baseline forecast</dt>
                  <dd>{item.baseline ?? "Unknown"}</dd>
                </div>
                <div>
                  <dt>Forecast with delay</dt>
                  <dd>{item.forecast ?? "Unknown"}</dd>
                </div>
              </dl>
              {item.provisional && (
                <p className="planning-help">
                  The path includes a provisional duration.
                </p>
              )}
              <h4>Affected path</h4>
              <ol className="risk-path">
                {item.path.map((task) => (
                  <li key={task.id}>
                    <Link to={workUrl(task.id)}>{task.title}</Link>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {assessment.severity === "unchanged" && (
            <p>No milestone date moved in this scenario.</p>
          )}
          <Link to={`${base}/graph?view=list&focus=${assessment.task.id}`}>
            Compare another handoff in the graph
          </Link>
        </section>
      )}
      {finding.canReview && (
        <section className="risk-section">
          <h2>Review risk</h2>
          <div className="planning-actions">
            <Button
              variant={finding.staleSchedule ? "primary" : "quiet"}
              disabled={command.busy}
              onClick={() => act({ action: "refresh" })}
            >
              Refresh forecast
            </Button>
          </div>
          {!finding.staleSchedule && milestone && (
            <form
              className="planning-form"
              onSubmit={(event) => {
                event.preventDefault();
                act({
                  action: "replan",
                  milestoneId: milestone.id,
                  commitment,
                });
              }}
            >
              <div className="planning-form-grid">
                <label>
                  Milestone
                  <select
                    value={selectedMilestone}
                    onChange={(event) => {
                      setSelectedMilestone(event.target.value);
                      setCommitment(
                        assessment.milestones.find(
                          ({ id }) => id === event.target.value,
                        )?.forecast ?? "",
                      );
                    }}
                  >
                    {assessment.milestones.map(({ id, title }) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Proposed commitment
                  <input
                    type="date"
                    required
                    min="0001-01-01"
                    max="9999-12-31"
                    value={commitment}
                    onChange={(event) => setCommitment(event.target.value)}
                  />
                </label>
              </div>
              <div className="planning-actions">
                <Button
                  type="submit"
                  disabled={
                    command.busy ||
                    !commitment ||
                    commitment === milestone.commitment
                  }
                >
                  Submit replan for approval
                </Button>
              </div>
            </form>
          )}
          <div className="planning-form">
            <label>
              Review note (optional)
              <textarea
                rows={2}
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="planning-actions">
              {finding.status === "open" && (
                <Button
                  variant="secondary"
                  disabled={command.busy}
                  onClick={() =>
                    act({
                      action: "acknowledge",
                      ...(reason.trim() ? { reason } : {}),
                    })
                  }
                >
                  Acknowledge risk
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={command.busy}
                onClick={() =>
                  act({
                    action: "resolve",
                    ...(reason.trim() ? { reason } : {}),
                  })
                }
              >
                Resolve risk
              </Button>
            </div>
          </div>
        </section>
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
  );
}
