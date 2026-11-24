import { projectSchema } from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { Sheet } from "../../components/sheet";
import {
  AsyncState,
  Button,
  PageHeading,
  StatusLabel,
} from "../../components/ui";
import { DiscussionPanel } from "../collaboration/discussion-panel";
import { denied, read } from "../identity/api";
import { HomePriorities } from "../inbox/inbox";
import { useActivityReturn } from "../workspace/activity-return";
import {
  Breadcrumbs,
  DateComparison,
  ProjectHeader,
} from "../workspace/project-view";
import {
  projectPath,
  workspacePath,
  type Project,
} from "../workspace/workspace-model";
import {
  planningRefresh,
  useLiveProject,
  usePlanning,
  type LiveProjectContext,
} from "./planning-client";
import { useForecast } from "./forecast-client";
import { ProjectEditor } from "./project-settings";
import "./planning.css";

const RiskOverview = lazy(() =>
  import("../risks/risks").then(({ RiskOverview }) => ({
    default: RiskOverview,
  })),
);

export function ProjectDirectory({
  projects,
}: {
  projects: readonly Project[];
}) {
  const { workspace } = usePlanning();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const opener = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false);
  const isArchive = params.get("archived") === "true";
  const search = params.get("q") ?? "";
  const matches = projects.filter(
    ({ name, description, archived }) =>
      !!archived === isArchive &&
      `${name} ${description ?? ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <div className="standard-page">
      <title>Projects · Kordos</title>
      <div className="planning-heading">
        <PageHeading title="Projects" />
        {workspace.role !== "viewer" && (
          <Button
            ref={opener}
            aria-haspopup="dialog"
            onClick={() => setCreating(true)}
          >
            <Plus size={16} aria-hidden="true" /> Create project
          </Button>
        )}
      </div>
      <div className="planning-filters">
        <label>
          Find a project
          <input
            type="search"
            maxLength={100}
            value={search}
            onChange={(event) => setFilter("q", event.target.value)}
          />
        </label>
        <label>
          Project state
          <select
            value={isArchive ? "true" : ""}
            onChange={(event) => setFilter("archived", event.target.value)}
          >
            <option value="">Active</option>
            <option value="true">Archived</option>
          </select>
        </label>
      </div>
      {matches.length ? (
        <ul className="destination-list planning-directory">
          {matches.map((project) => (
            <li key={project.id}>
              <Link to={workspacePath(projectPath(project.id), workspace.id)}>
                <span className="planning-item-copy">
                  <strong>{project.name}</strong>
                  {project.description && <span>{project.description}</span>}
                </span>
                <span className="planning-directory-visibility">
                  {project.visibility === "restricted"
                    ? "Restricted"
                    : "Workspace-visible"}
                </span>
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-message">
          {search
            ? "No projects match this search."
            : isArchive
              ? "There are no archived projects you can access."
              : "There are no active projects you can access."}
        </p>
      )}
      {creating && (
        <Sheet
          opener={opener.current ?? undefined}
          title="Create project"
          onDismiss={() => setCreating(false)}
        >
          {() => (
            <ProjectEditor
              onSaved={(id) =>
                navigate(workspacePath(projectPath(id), workspace.id))
              }
            />
          )}
        </Sheet>
      )}
    </div>
  );
}

export function PlanningProject() {
  const { key, api, workspace } = usePlanning();
  const { projectId } = useParams();
  const activityReturn = useActivityReturn(workspace.id);
  const location = useLocation();
  const query = useQuery({
    queryKey: [...key, "project", projectId],
    queryFn: ({ signal }) =>
      read(`${api}/projects/${projectId}`, projectSchema, signal),
    ...planningRefresh,
  });
  if (query.isPending)
    return <AsyncState kind="loading" message="Loading project…" />;
  if (denied(query.error)) {
    return (
      <div className="standard-page">
        <title>Project unavailable · Kordos</title>
        <Breadcrumbs current="Project unavailable" />
        <PageHeading
          title="Project unavailable"
          description="Check the link or choose a project you can access."
        />
        <Link
          className="button button--secondary"
          to={workspacePath("/projects", workspace.id)}
        >
          Go to projects
        </Link>
      </div>
    );
  }
  const details = query.data;
  if (!details)
    return (
      <AsyncState
        kind="error"
        message="Could not load this project."
        retry={() => void query.refetch()}
      />
    );
  const project: Project = {
    id: details.id,
    name: details.name,
    description: details.description ?? undefined,
    commitment: details.commitment ?? undefined,
    lead: details.lead?.name,
    signals: [],
  };
  return (
    <div className="project-page">
      <ProjectHeader
        project={project}
        compact
        action={
          details.archived ? (
            <StatusLabel>Archived project</StatusLabel>
          ) : details.role === "viewer" ? undefined : (
            <Link
              className="button button--primary"
              aria-haspopup="dialog"
              to={workspacePath(
                `${projectPath(details.id, "work")}/new${location.pathname.includes(`${projectPath(details.id)}/work`) ? location.search : ""}`,
                workspace.id,
              )}
            >
              <Plus size={16} aria-hidden="true" /> Create task
            </Link>
          )
        }
      />
      {activityReturn &&
        !location.pathname.includes(`${projectPath(details.id)}/work/`) && (
          <Link className="activity-return" to={activityReturn}>
            Back to activity
          </Link>
        )}
      <Outlet context={{ project, details } satisfies LiveProjectContext} />
    </div>
  );
}

export function PlanningOverview() {
  const { workspace } = usePlanning();
  const { project, details } = useLiveProject();
  const base = workspacePath(projectPath(project.id), workspace.id);
  const { query } = useForecast(project.id, !!project.commitment);
  const graph = denied(query.error) ? undefined : query.data;
  const milestone = graph?.items.find(
    ({ kind, status, commitment }) =>
      kind === "milestone" &&
      status !== "done" &&
      commitment === project.commitment,
  );
  const forecast = graph?.forecast.find(({ id }) => id === milestone?.id);
  return (
    <>
      <title>{`${project.name} · Kordos`}</title>
      <DateComparison
        project={{ ...project, forecast: forecast?.finish ?? undefined }}
      />
      {forecast?.provisional && (
        <p>
          Forecast uncertain. See{" "}
          <Link to={`${base}/graph`}>dependencies and forecast</Link>.
        </p>
      )}
      <section
        className="planning-panel glass-panel"
        aria-labelledby="project-work-summary"
      >
        <div className="planning-heading">
          <h2 id="project-work-summary">Work summary</h2>
          {details.role === "lead" && (
            <Link className="button button--secondary" to={`${base}/settings`}>
              Project settings
            </Link>
          )}
        </div>
        <p>
          {details.activeCount} active work{" "}
          {details.activeCount === 1 ? "item" : "items"}
        </p>
        <p>
          {details.visibility === "restricted"
            ? "Restricted to project members"
            : "Visible to this workspace"}{" "}
          · {details.timeZone}
        </p>
        <div className="planning-actions">
          <Link to={`${base}/work`}>View project work</Link>
          <Link to={`${base}/weekly-health`}>Weekly health</Link>
          <Link className="button button--secondary" to={`${base}/briefs`}>
            {details.archived || details.role === "viewer"
              ? "View briefs"
              : "Add a brief"}
          </Link>
        </div>
      </section>
      <Suspense
        fallback={
          <AsyncState kind="loading" message="Loading schedule risks…" />
        }
      >
        <RiskOverview />
      </Suspense>
      {!details.archived && (
        <HomePriorities
          projectId={project.id}
          showReviews={details.role === "lead"}
        />
      )}
      <DiscussionPanel
        projectId={project.id}
        subject={{ kind: "project", id: project.id }}
      />
    </>
  );
}
