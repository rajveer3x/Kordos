import { weeklyReportsSchema } from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { AsyncState, StatusLabel, type StatusTone } from "../../components/ui";
import { denied, read } from "../identity/api";
import {
  planningRefresh,
  useLiveProject,
  usePlanning,
} from "../planning/planning-client";
import { workLabels } from "../planning/work-editor";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import "./project-health.css";

const healthLabels = {
  on_track: ["On track", "confirmed"],
  at_risk: ["At risk", "risk"],
  uncertain: ["Uncertain", "neutral"],
  uncommitted: ["No commitment", "neutral"],
} satisfies Record<string, [string, StatusTone]>;

const workChanges = {
  "work.created": "Created",
  "work.edited": "Edited",
  "work.completed": "Completed",
  "work.reopened": "Reopened",
  "work.archived": "Archived",
  "work.restored": "Restored",
};

function countLabel(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function lastDate(endExclusive: string) {
  const date = new Date(endExclusive);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export default function WeeklyHealth() {
  const { project } = useLiveProject();
  const { api, key, workspace } = usePlanning();
  const [params, setParams] = useSearchParams();
  const period = params.get("period");
  const { data, error, isPending, refetch } = useQuery({
    queryKey: [...key, "weekly-health", project.id, period],
    queryFn: ({ signal }) =>
      read(
        `${api}/projects/${project.id}/weekly-health${period ? `?period=${encodeURIComponent(period)}` : ""}`,
        weeklyReportsSchema,
        signal,
      ),
    ...planningRefresh,
  });
  const base = workspacePath(projectPath(project.id), workspace.id);
  const report = error ? undefined : data?.report;
  const active = new Map(report?.active.map((item) => [item.id, item]));
  const completed =
    report?.changes.filter(({ action }) => action === "work.completed") ?? [];
  const completedMilestones = completed.filter(
    ({ kind }) => kind === "milestone",
  );
  const workLink = (id: string) => `${base}/work/${id}`;
  const auditLink = (eventId: string) =>
    workspacePath(`/audit?eventId=${eventId}`, workspace.id);

  return (
    <section className="planning-panel glass-panel project-health-panel">
      <title>{`Weekly health · ${project.name} · Kordos`}</title>
      <div className="planning-heading">
        <h2 className="page-title">Weekly health</h2>
        {!!data?.periods.length && !denied(error) && (
          <label className="project-health-period">
            Week starting
            <select
              value={period ?? ""}
              onChange={(event) =>
                setParams(
                  event.target.value ? { period: event.target.value } : {},
                )
              }
            >
              <option value="">Latest report</option>
              {period && !data.periods.includes(period) && (
                <option value={period}>{period}</option>
              )}
              {data.periods.map((week) => (
                <option key={week} value={week}>
                  {week}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {isPending ? (
        <AsyncState kind="loading" message="Loading weekly health…" />
      ) : denied(error) ? (
        <p>This report is unavailable.</p>
      ) : error ? (
        <AsyncState
          kind="error"
          message="Could not load weekly health."
          retry={() => void refetch()}
        />
      ) : !report ? (
        <p className="planning-help">
          {period
            ? "No report was saved for this week."
            : "The first weekly report is being prepared."}
        </p>
      ) : (
        <>
          <p>
            {report.period} through {lastDate(report.endExclusive)} ·{" "}
            {report.timeZone}
          </p>
          <p className="planning-help" role="status">
            {report.stale ? "Inputs changed or a refresh is due. " : ""}
            Captured{" "}
            <time dateTime={report.generatedAt}>
              {new Intl.DateTimeFormat(undefined, {
                timeZone: report.timeZone,
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(report.generatedAt))}
            </time>
            {" · "}
            <Link to={`${base}/graph`}>
              Graph revision {report.graphVersion}
            </Link>
          </p>

          <div className="project-health-group">
            <h3>Milestone outlook</h3>
            {report.milestones.length ? (
              <ul className="project-health-list">
                {report.milestones.map((item) => {
                  const [label, tone] = healthLabels[item.health];
                  return (
                    <li key={item.id}>
                      <div className="planning-heading">
                        <Link to={workLink(item.id)}>{item.title}</Link>
                        <StatusLabel tone={tone}>{label}</StatusLabel>
                      </div>
                      <dl className="planning-facts">
                        <div>
                          <dt>Committed</dt>
                          <dd>{item.commitment ?? "Unscheduled"}</dd>
                        </div>
                        <div>
                          <dt>Forecast</dt>
                          <dd>
                            {item.finish ?? "Unavailable"}
                            {item.provisional ? " (provisional)" : ""}
                          </dd>
                        </div>
                        <div>
                          <dt>Commitment slack</dt>
                          <dd>
                            {item.slackDays === null
                              ? "Unknown"
                              : `${item.slackDays} working days`}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="planning-help">
                No open milestones in this snapshot.
              </p>
            )}
          </div>

          <div className="project-health-group">
            <h3>Work and decisions</h3>
            <details>
              <summary>
                {countLabel(report.active.length, "active work item")}
              </summary>
              <ul>
                {report.active.map((item) => (
                  <li key={item.id}>
                    <Link to={workLink(item.id)}>{item.title}</Link> ·{" "}
                    {workLabels[item.status]}
                  </li>
                ))}
              </ul>
            </details>
            <details open={report.blockers.length > 0}>
              <summary>
                {countLabel(report.blockers.length, "open blocker")}
              </summary>
              <ul>
                {report.blockers.map(({ id }) => (
                  <li key={id}>
                    <Link to={workLink(id)}>
                      {active.get(id)?.title ?? "Open work item"}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
            <details open={report.missingEstimates.length > 0}>
              <summary>
                {countLabel(report.missingEstimates.length, "missing estimate")}
              </summary>
              <ul>
                {report.missingEstimates.map(({ id }) => (
                  <li key={id}>
                    <Link to={workLink(id)}>
                      {active.get(id)?.title ?? "Open work item"}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
            <details open={report.decisions.length > 0}>
              <summary>
                {countLabel(report.decisions.length, "decision")} requested
              </summary>
              <ul>
                {report.decisions.map(({ id, title, version }) => (
                  <li key={id}>
                    <Link
                      to={workspacePath(
                        `/reviews/${id}?revision=${version}`,
                        workspace.id,
                      )}
                    >
                      {title}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
            <details open={completed.length > 0}>
              <summary>
                {countLabel(completed.length, "completion")} ·{" "}
                {countLabel(completedMilestones.length, "milestone")}
              </summary>
              <ul>
                {completed.map((change) => (
                  <li key={change.eventId}>
                    <Link to={auditLink(change.eventId)}>{change.title}</Link> ·{" "}
                    {change.kind === "milestone" ? "Milestone" : "Task"}
                  </li>
                ))}
              </ul>
            </details>
            <details>
              <summary>
                {countLabel(report.changes.length, "work change")} this week
              </summary>
              <ul>
                {report.changes.map((change) => (
                  <li key={change.eventId}>
                    <Link to={auditLink(change.eventId)}>{change.title}</Link> ·{" "}
                    {workChanges[change.action]}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </>
      )}
    </section>
  );
}
