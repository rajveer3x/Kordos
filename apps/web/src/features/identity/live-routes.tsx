import {
  idSchema,
  sessionResponseSchema,
  workspaceDetailSchema,
  workspacesResponseSchema,
  type SessionIdentity,
  type WorkspaceSummary,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router";
import { WorkspaceRoutes } from "../../app";
import { Brand } from "../../components/brand";
import { AsyncState, PageHeading } from "../../components/ui";
import { HealthPage } from "../health/health-page";
import { workspacePath } from "../workspace/workspace-model";
import { JoinWorkspace, SignInPage, WorkspaceChooser } from "./access-pages";
import { denied, read } from "./api";
import { WorkspaceSettings } from "./workspace-settings";
import "./identity.css";

const accessRefresh = 5_000;

export function LiveRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/workspace" replace />} />
      <Route path="/health" element={<HealthPage />} />
      <Route path="/sign-in" element={<SessionGate signIn />} />
      <Route path="/join" element={<SessionGate join />} />
      <Route path="/workspace" element={<SessionGate />} />
      <Route path="/w/:workspaceId/*" element={<SessionGate scoped />} />
      <Route path="*" element={<SessionGate legacy />} />
    </Routes>
  );
}

function PublicState({ children }: { children: ReactNode }) {
  return (
    <main className="public-page">
      <Brand />
      {children}
    </main>
  );
}

function SessionGate({
  signIn,
  join,
  scoped,
  legacy,
}: {
  signIn?: boolean;
  join?: boolean;
  scoped?: boolean;
  legacy?: boolean;
}) {
  const { pathname, search, hash } = useLocation();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => read("/session", sessionResponseSchema, signal),
    refetchInterval: accessRefresh,
    refetchOnMount: "always",
  });
  if (session.isPending) {
    return (
      <PublicState>
        <AsyncState kind="loading" message="Checking your session…" />
      </PublicState>
    );
  }
  if (session.isError) {
    return (
      <PublicState>
        <AsyncState
          kind="error"
          message="Could not check your session."
          retry={() => void session.refetch()}
        />
      </PublicState>
    );
  }
  const { identity, signInAvailable } = session.data;
  if (!identity) {
    return signIn ? (
      <SignInPage available={signInAvailable} />
    ) : (
      <Navigate
        to="/sign-in"
        replace
        state={{ returnTo: pathname + search + hash }}
      />
    );
  }
  if (signIn) return <Navigate to="/workspace" replace />;
  if (join) return <JoinWorkspace key={identity.id} identity={identity} />;
  return (
    <WorkspaceGate
      key={identity.id}
      identity={identity}
      scoped={scoped}
      legacy={legacy}
    />
  );
}

function WorkspaceGate({
  identity,
  scoped,
  legacy,
}: {
  identity: SessionIdentity;
  scoped?: boolean;
  legacy?: boolean;
}) {
  const { workspaceId } = useParams();
  const { pathname, search, hash } = useLocation();
  const workspaces = useQuery({
    queryKey: ["identity", "workspaces", identity.id],
    queryFn: ({ signal }) =>
      read("/workspaces", workspacesResponseSchema, signal),
    refetchInterval: accessRefresh,
    gcTime: 0,
  });
  if (workspaces.isPending) {
    return (
      <PublicState>
        <AsyncState kind="loading" message="Loading workspaces…" />
      </PublicState>
    );
  }
  if (workspaces.isError) {
    if (denied(workspaces.error)) return <Navigate to="/sign-in" replace />;
    return (
      <PublicState>
        <AsyncState
          kind="error"
          message="Could not load workspaces."
          retry={() => void workspaces.refetch()}
        />
      </PublicState>
    );
  }
  if (scoped) {
    if (
      !workspaceId ||
      !idSchema.safeParse(workspaceId).success ||
      !workspaces.data.some(({ id }) => id === workspaceId)
    ) {
      return <WorkspaceUnavailable />;
    }
    return (
      <WorkspaceScope
        key={workspaceId}
        id={workspaceId}
        identity={identity}
        workspaces={workspaces.data}
      />
    );
  }
  const [onlyWorkspace, otherWorkspace] = workspaces.data;
  if (legacy && onlyWorkspace && !otherWorkspace) {
    return (
      <Navigate
        to={workspacePath(pathname + search + hash, onlyWorkspace.id)}
        replace
      />
    );
  }
  return <WorkspaceChooser workspaces={workspaces.data} />;
}

function WorkspaceUnavailable() {
  return (
    <PublicState>
      <title>Workspace unavailable · Kordos</title>
      <div className="access-card glass-panel">
        <PageHeading
          title="Workspace unavailable"
          description="Choose a workspace you can access."
        />
        <Link to="/workspace">Your workspaces</Link>
      </div>
    </PublicState>
  );
}

function WorkspaceScope({
  id,
  identity,
  workspaces,
}: {
  id: string;
  identity: SessionIdentity;
  workspaces: WorkspaceSummary[];
}) {
  const scope = useQuery({
    queryKey: ["identity", "workspace", identity.id, id],
    queryFn: ({ signal }) =>
      read(`/workspaces/${id}`, workspaceDetailSchema, signal),
    refetchInterval: accessRefresh,
    gcTime: 0,
  });
  if (scope.isPending) {
    return (
      <PublicState>
        <AsyncState kind="loading" message="Loading workspace…" />
      </PublicState>
    );
  }
  if (scope.isError) {
    if (denied(scope.error)) return <WorkspaceUnavailable />;
    return (
      <PublicState>
        <AsyncState
          kind="error"
          message="Could not load this workspace."
          retry={() => void scope.refetch()}
        />
      </PublicState>
    );
  }
  const { workspace, projects } = scope.data;
  const initials = identity.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  return (
    <WorkspaceRoutes
      workspace={{
        name: workspace.name,
        member: { name: identity.name, initials },
        projects: projects.map((project) => ({
          ...project,
          description: project.description ?? undefined,
          signals: [],
        })),
      }}
      workspaces={workspaces}
      settings={
        <WorkspaceSettings workspace={workspace} actorId={identity.id} />
      }
    />
  );
}
