import { githubActivitySchema, idSchema } from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Link } from "react-router";
import { AsyncState, Button, StatusLabel } from "../../components/ui";
import { denied, read } from "../identity/api";
import { planningRefresh, usePlanning } from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import "./connectors.css";

export const githubStateLabels = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
};

export function GitHubActivity({
  projectId,
  workId,
}: {
  projectId: string;
  workId?: string;
}) {
  const { api, key, workspace } = usePlanning();
  const [params, setParams] = useSearchParams();
  const cursor = idSchema.safeParse(params.get("githubCursor")).data;
  const filters = new URLSearchParams({
    ...(workId ? { workId } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const project = projectPath(projectId);
  const base = workspacePath(project + "/documents/sources", workspace.id);
  const query = useQuery({
    queryKey: [...key, "github-activity", projectId, workId, cursor],
    queryFn: ({ signal }) =>
      read(
        `${api}${project}/github-activity?${filters}`,
        githubActivitySchema,
        signal,
      ),
    ...planningRefresh,
  });
  function go(next: string | null) {
    const search = new URLSearchParams(params);
    if (next) search.set("githubCursor", next);
    else search.delete("githubCursor");
    setParams(search, { replace: true });
  }
  if (
    workId &&
    !query.isError &&
    !query.isPending &&
    !query.data?.items.length &&
    !cursor
  )
    return null;
  const Heading = workId ? "h4" : "h2";
  return (
    <section
      className={workId ? "review-section" : "planning-panel glass-panel"}
    >
      <Heading>{workId ? "GitHub evidence" : "GitHub activity"}</Heading>
      {query.isPending ? (
        <AsyncState kind="loading" message="Loading GitHub activity…" />
      ) : query.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(query.error)
              ? "GitHub activity is unavailable."
              : "Could not load GitHub activity."
          }
          retry={denied(query.error) ? undefined : () => void query.refetch()}
        />
      ) : query.data.items.length ? (
        <ul className="connector-rows">
          {query.data.items.map(
            ({ id, title, github, revision, observedAt }) => (
              <li key={id} className="connector-row">
                <div className="planning-item-copy">
                  <Link to={`${base}/${id}?revision=${revision}`}>{title}</Link>
                  <span>
                    {github.repository} #{github.number} ·{" "}
                    {github.kind === "pull" ? "Pull request" : "Issue"} ·{" "}
                    <time dateTime={observedAt}>
                      {new Date(observedAt).toLocaleString()}
                    </time>
                  </span>
                </div>
                <StatusLabel
                  tone={github.state === "merged" ? "confirmed" : "neutral"}
                >
                  {githubStateLabels[github.state]}
                </StatusLabel>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="planning-help">No GitHub activity is available to you.</p>
      )}
      {(cursor || query.data?.nextCursor) && (
        <div className="planning-actions">
          {cursor && (
            <Button variant="quiet" onClick={() => go(null)}>
              Latest GitHub activity
            </Button>
          )}
          {query.data?.nextCursor && (
            <Button variant="quiet" onClick={() => go(query.data.nextCursor)}>
              Older GitHub activity
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
