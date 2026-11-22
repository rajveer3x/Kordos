import type { WorkspaceSummary } from "@kordos/contracts";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, Route, Routes, useParams } from "react-router";
import { PageHeading } from "./components/ui";
import {
  ProjectOverview,
  ProjectSection,
  ProjectView,
} from "./features/workspace/project-view";
import {
  projectDestinations,
  projectPath,
  workspaceDestinations,
  workspacePath,
  type Workspace,
  type WorkspaceDestination,
} from "./features/workspace/workspace-model";
import { WorkspaceShell } from "./features/workspace/workspace-shell";
import "./styles.css";
import "./features/workspace/workspace.css";

function WorkspacePage({
  destination,
  workspace,
}: {
  destination: WorkspaceDestination;
  workspace: Workspace;
}) {
  const { workspaceId } = useParams();
  return (
    <div className="standard-page">
      <title>{`${destination.label} · Kordos`}</title>
      <PageHeading title={destination.label} />
      {destination.id === "projects" && workspace.projects.length ? (
        <ul className="destination-list">
          {workspace.projects.map((project) => (
            <li key={project.id}>
              <Link to={workspacePath(projectPath(project.id), workspaceId)}>
                {project.name} <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-message">{destination.empty}</p>
      )}
    </div>
  );
}

export function WorkspaceRoutes({
  workspace,
  workspaces,
  settings,
}: {
  workspace: Workspace;
  workspaces?: WorkspaceSummary[];
  settings?: ReactNode;
}) {
  const { workspaceId } = useParams();
  const home = workspacePath("/workspace", workspaceId);
  return (
    <Routes>
      <Route
        element={
          <WorkspaceShell workspace={workspace} workspaces={workspaces} />
        }
      >
        <Route index element={<Navigate to={home} replace />} />
        {workspaceDestinations.map((destination) => (
          <Route
            key={destination.id}
            path={destination.path.slice(1)}
            element={
              destination.id === "settings" && settings ? (
                settings
              ) : (
                <WorkspacePage
                  destination={destination}
                  workspace={workspace}
                />
              )
            }
          />
        ))}
        <Route
          path="projects/:projectId"
          element={<ProjectView workspace={workspace} />}
        >
          <Route index element={<ProjectOverview />} />
          {projectDestinations
            .filter(({ id }) => id !== "overview")
            .map((destination) => (
              <Route key={destination.id} path={destination.id}>
                <Route
                  index
                  element={<ProjectSection destination={destination} />}
                />
                {destination.id === "documents" && (
                  <Route
                    path=":sourceId"
                    element={<ProjectSection destination={destination} />}
                  />
                )}
              </Route>
            ))}
        </Route>
        <Route
          path="*"
          element={
            <div className="standard-page">
              <title>Page unavailable · Kordos</title>
              <PageHeading title="Page unavailable" />
              <Link to={home}>Go to workspace home</Link>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
