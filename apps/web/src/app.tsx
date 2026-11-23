import type { WorkspaceSummary } from "@kordos/contracts";
import { ArrowRight } from "lucide-react";
import { lazy, Suspense, useContext, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useParams } from "react-router";
import { AsyncState, PageHeading } from "./components/ui";
import { PlanningScope } from "./features/planning/planning-client";
import {
  PlanningOverview,
  PlanningProject,
  ProjectDirectory,
} from "./features/planning/project-pages";
import { ProjectSettings } from "./features/planning/project-settings";
import { WorkInspector } from "./features/planning/work-inspector";
import { AssignedWork, WorkViews } from "./features/planning/work-views";
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

const ProjectGraph = lazy(() => import("./features/planning/project-graph"));
const ProjectKnowledge = lazy(() => import("./features/knowledge/routes"));
const RiskHistory = lazy(() =>
  import("./features/risks/risks").then(({ RiskHistory }) => ({
    default: RiskHistory,
  })),
);
const RiskPage = lazy(() =>
  import("./features/risks/risks").then(({ RiskPage }) => ({
    default: RiskPage,
  })),
);
const BriefsPage = lazy(() =>
  import("./features/briefs/briefs").then(({ BriefsPage }) => ({
    default: BriefsPage,
  })),
);
const BriefJobPage = lazy(() =>
  import("./features/briefs/briefs").then(({ BriefJobPage }) => ({
    default: BriefJobPage,
  })),
);
const ReviewsPage = lazy(() =>
  import("./features/reviews/reviews").then(({ ReviewsPage }) => ({
    default: ReviewsPage,
  })),
);
const ReviewPage = lazy(() =>
  import("./features/reviews/reviews").then(({ ReviewPage }) => ({
    default: ReviewPage,
  })),
);
const AuditPage = lazy(() =>
  import("./features/reviews/audit").then(({ AuditPage }) => ({
    default: AuditPage,
  })),
);
const ProjectAudit = lazy(() =>
  import("./features/reviews/audit").then(({ ProjectAudit }) => ({
    default: ProjectAudit,
  })),
);

function LazyPage({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AsyncState kind="loading" message="Loading page…" />}>
      {children}
    </Suspense>
  );
}

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
  const live = useContext(PlanningScope) !== null;
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
              ) : live && destination.id === "home" ? (
                <AssignedWork />
              ) : live && destination.id === "projects" ? (
                <ProjectDirectory projects={workspace.projects} />
              ) : live && destination.id === "reviews" ? (
                <LazyPage>
                  <ReviewsPage />
                </LazyPage>
              ) : live && destination.id === "audit" ? (
                <LazyPage>
                  <AuditPage />
                </LazyPage>
              ) : (
                <WorkspacePage
                  destination={destination}
                  workspace={workspace}
                />
              )
            }
          />
        ))}
        {live && (
          <Route
            path="reviews/:proposalId"
            element={
              <LazyPage>
                <ReviewPage />
              </LazyPage>
            }
          />
        )}
        <Route
          path="projects/:projectId"
          element={
            live ? (
              <PlanningProject key={workspaceId} />
            ) : (
              <ProjectView workspace={workspace} />
            )
          }
        >
          <Route
            index
            element={live ? <PlanningOverview /> : <ProjectOverview />}
          />
          {live && (
            <>
              <Route
                path="graph"
                element={
                  <Suspense
                    fallback={
                      <AsyncState
                        kind="loading"
                        message="Loading dependency graph…"
                      />
                    }
                  >
                    <ProjectGraph />
                  </Suspense>
                }
              />
              <Route
                path="briefs"
                element={
                  <LazyPage>
                    <BriefsPage />
                  </LazyPage>
                }
              />
              <Route
                path="briefs/:briefId"
                element={
                  <LazyPage>
                    <BriefJobPage />
                  </LazyPage>
                }
              />
              <Route
                path="risks"
                element={
                  <LazyPage>
                    <RiskHistory />
                  </LazyPage>
                }
              />
              <Route
                path="risks/:riskId"
                element={
                  <LazyPage>
                    <RiskPage />
                  </LazyPage>
                }
              />
              <Route path="settings" element={<ProjectSettings />} />
              <Route
                path="activity"
                element={
                  <LazyPage>
                    <ProjectAudit />
                  </LazyPage>
                }
              />
              <Route
                path="documents/*"
                element={
                  <Suspense
                    fallback={
                      <AsyncState
                        kind="loading"
                        message="Loading project knowledge…"
                      />
                    }
                  >
                    <ProjectKnowledge />
                  </Suspense>
                }
              />
              <Route path="work" element={<WorkViews />}>
                <Route path="new" element={<WorkInspector create />} />
                <Route path=":workId" element={<WorkInspector />} />
              </Route>
            </>
          )}
          {projectDestinations
            .filter(
              ({ id }) =>
                id !== "overview" &&
                (!live ||
                  (id !== "work" &&
                    id !== "graph" &&
                    id !== "documents" &&
                    id !== "activity")),
            )
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
