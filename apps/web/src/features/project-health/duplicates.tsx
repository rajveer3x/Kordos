import { duplicateReviewSchema } from "@kordos/contracts";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { AsyncState, Button } from "../../components/ui";
import { denied, read } from "../identity/api";
import {
  planningRefresh,
  useLiveProject,
  usePlanning,
  usePlanningCommand,
} from "../planning/planning-client";
import { workLabels } from "../planning/work-editor";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import "./project-health.css";

type Task = z.infer<typeof duplicateReviewSchema>["task"];
type Candidate = z.infer<typeof duplicateReviewSchema>["candidates"][number];

function TaskDetails({
  task,
  other,
  workUrl,
}: {
  task: Task;
  other: Task;
  workUrl: string;
}) {
  const dependencies = (key: "predecessors" | "successors") => {
    const sharedIds = new Set(other[key].map(({ id }) => id));
    return task[key].length ? (
      <ul>
        {task[key].map(({ id, title }) => (
          <li key={id}>
            <Link to={`${workUrl}/${id}`}>{title}</Link>
            {sharedIds.has(id) ? " (shared)" : ""}
          </li>
        ))}
      </ul>
    ) : (
      "None"
    );
  };
  return (
    <div>
      <h4>
        <Link to={`${workUrl}/${task.id}`}>{task.title}</Link>
      </h4>
      <p className="planning-description">
        {task.description ?? "No deliverable description"}
      </p>
      <dl className="project-health-task-facts">
        <div>
          <dt>Owner</dt>
          <dd>{task.owner?.name ?? "Unassigned"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{workLabels[task.status]}</dd>
        </div>
        <div>
          <dt>Predecessors</dt>
          <dd>{dependencies("predecessors")}</dd>
        </div>
        <div>
          <dt>Successors</dt>
          <dd>{dependencies("successors")}</dd>
        </div>
      </dl>
    </div>
  );
}

function Comparison({
  task,
  candidate,
  workUrl,
  endpoint,
  onReviewed,
  canAct,
  graphVersion,
}: {
  task: Task;
  candidate: Candidate;
  workUrl: string;
  endpoint: string;
  onReviewed: (message: string) => void;
  canAct: boolean;
  graphVersion: number;
}) {
  const { workspace } = usePlanning();
  const command = usePlanningCommand();
  const navigate = useNavigate();

  function act(
    action: "dismiss" | "relate" | "consolidate",
    keep: Task = task,
    other: Task = candidate,
  ) {
    void command.save(
      `${endpoint}/${keep.id}/duplicates`,
      "POST",
      {
        action,
        taskVersion: keep.version,
        other: { id: other.id, version: other.version },
        graphVersion,
      },
      (id) => {
        if (action === "consolidate")
          navigate(workspacePath(`/reviews/${id}`, workspace.id));
        else
          onReviewed(
            action === "relate"
              ? "Tasks linked as related."
              : "Suggestion dismissed.",
          );
      },
    );
  }

  return (
    <li className="project-health-comparison">
      <h3>{candidate.title}</h3>
      <p className="planning-help">
        {candidate.sharedTerms.length ? (
          <>Shared deliverable terms · {candidate.sharedTerms.join(", ")}</>
        ) : (
          "Similar wording in the titles or descriptions"
        )}
        {task.owner?.id === candidate.owner?.id && task.owner
          ? " · Same owner"
          : ""}
      </p>
      <div className="project-health-task-columns">
        <TaskDetails task={task} other={candidate} workUrl={workUrl} />
        <TaskDetails task={candidate} other={task} workUrl={workUrl} />
      </div>
      {canAct && (
        <>
          <div className="planning-actions">
            <Button
              variant="quiet"
              disabled={command.busy}
              onClick={() => act("dismiss")}
            >
              Dismiss
            </Button>
            <Button
              variant="secondary"
              disabled={command.busy}
              onClick={() => act("relate")}
            >
              Link as related
            </Button>
            <details className="project-health-consolidate">
              <summary>Propose consolidation</summary>
              <p>
                Choose the task to keep. The proposal will show the task to
                archive and the dependencies to carry forward.
              </p>
              <div className="planning-actions">
                <Button
                  variant="secondary"
                  disabled={command.busy}
                  onClick={() => act("consolidate")}
                >
                  Keep {task.title}
                </Button>
                <Button
                  variant="secondary"
                  disabled={command.busy}
                  onClick={() => act("consolidate", candidate, task)}
                >
                  Keep {candidate.title}
                </Button>
              </div>
            </details>
          </div>
          {command.error && (
            <p className="planning-error" role="alert">
              {command.error.message}
            </p>
          )}
        </>
      )}
    </li>
  );
}

export default function Duplicates() {
  const { workId } = useParams();
  const { project } = useLiveProject();
  const { api, key, workspace } = usePlanning();
  const endpoint = `${api}/projects/${project.id}/work`;
  const path = `${endpoint}/${workId}/duplicates`;
  const heading = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState("");
  const workUrl = workspacePath(projectPath(project.id, "work"), workspace.id);
  const query = useQuery({
    queryKey: [...key, "duplicates", project.id, workId],
    queryFn: ({ signal }) => read(path, duplicateReviewSchema, signal),
    ...planningRefresh,
  });
  const result = query.error ? undefined : query.data;
  return (
    <section className="planning-panel glass-panel project-health-panel">
      <title>{`Duplicate review · ${project.name} · Kordos`}</title>
      <h2 className="page-title" ref={heading} tabIndex={-1}>
        Duplicate review
      </h2>
      <p role="status" className="planning-notice">
        {notice}
      </p>
      <p>
        <Link to={`${workUrl}/${workId}`}>
          {result?.task.title ?? "Back to task"}
        </Link>
      </p>
      {query.isPending ? (
        <AsyncState kind="loading" message="Finding similar tasks…" />
      ) : denied(query.error) ? (
        <p>This task is unavailable.</p>
      ) : !result ? (
        <AsyncState
          kind="error"
          message="Could not load duplicate suggestions."
          retry={() => void query.refetch()}
        />
      ) : (
        <>
          {!!result.links.length && (
            <div className="project-health-group">
              <h3>Related work</h3>
              <ul>
                {result.links.map(({ id, title, relation }) => (
                  <li key={id}>
                    {relation === "consolidated_into"
                      ? "Consolidated into "
                      : relation === "consolidated_from"
                        ? "Consolidated from "
                        : ""}
                    <Link to={`${workUrl}/${id}`}>{title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.candidates.length ? (
            <ul className="project-health-list">
              {result.candidates.map((candidate) => (
                <Comparison
                  key={`${result.task.version}:${candidate.id}:${candidate.version}`}
                  task={result.task}
                  candidate={candidate}
                  workUrl={workUrl}
                  endpoint={endpoint}
                  onReviewed={(message) => {
                    setNotice(message);
                    heading.current?.focus();
                  }}
                  canAct={result.canAct}
                  graphVersion={result.graphVersion}
                />
              ))}
            </ul>
          ) : (
            <p className="planning-help" role="status">
              No similar open tasks to review.
            </p>
          )}
        </>
      )}
    </section>
  );
}
