import type { WorkspaceSummary } from "@kordos/contracts";
import {
  ArrowDownUp,
  FolderClosed,
  House,
  Inbox,
  ListChecks,
  Menu,
  Search,
  Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router";
import { Brand } from "../../components/brand";
import { Sheet } from "../../components/sheet";
import { Button } from "../../components/ui";
import {
  workspaceDestinations,
  workspacePath,
  type Workspace,
} from "./workspace-model";

const destinationIcons = {
  home: House,
  projects: FolderClosed,
  search: Search,
  inbox: Inbox,
  reviews: ListChecks,
  settings: Settings,
};

function WorkspaceNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const { workspaceId } = useParams();
  return (
    <nav aria-label="Workspace">
      <ul className="workspace-links">
        {workspaceDestinations.map(({ id, label, path }) => {
          const Icon = destinationIcons[id];
          return (
            <li key={id}>
              <NavLink
                to={workspacePath(path, workspaceId)}
                end={id !== "projects"}
                title={label}
                onClick={onNavigate}
              >
                <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
                <span className="nav-label">{label}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function workViewPath(path: string) {
  return path.replace(/(\/projects\/[^/]+\/work)\/[^/]+$/, "$1");
}

export function WorkspaceShell({
  workspace,
  workspaces,
}: {
  workspace: Workspace;
  workspaces?: WorkspaceSummary[];
}) {
  const { workspaceId } = useParams();
  const [drawer, setDrawer] = useState<{
    kind: "navigation" | "workspace";
    opener: HTMLElement;
  }>();
  const { pathname } = useLocation();
  const lastPath = useRef(pathname);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = lastPath.current;
    lastPath.current = pathname;
    if (workViewPath(previous) === workViewPath(pathname)) return;
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="workspace-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <aside
        className="workspace-rail glass-panel glass-panel--blur"
        aria-label="Workspace rail"
      >
        <div className="rail-top">
          <Brand />
          <Button
            variant="secondary"
            className="workspace-switcher"
            aria-label={`Switch workspace, current workspace ${workspace.name}`}
            aria-haspopup="dialog"
            title={workspace.name}
            onClick={(event) =>
              setDrawer({ kind: "workspace", opener: event.currentTarget })
            }
          >
            <span className="workspace-emblem" aria-hidden="true">
              {workspace.name.slice(0, 1)}
            </span>
            <span className="switcher-name">{workspace.name}</span>
            <ArrowDownUp
              className="switcher-icon"
              size={14}
              aria-hidden="true"
            />
          </Button>
          <WorkspaceNavigation />
        </div>
        <div className="workspace-member" title={workspace.member.name}>
          <span className="member-avatar" aria-hidden="true">
            {workspace.member.initials}
          </span>
          <span className="member-name">{workspace.member.name}</span>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="mobile-bar glass-panel glass-panel--blur">
          <Button
            variant="icon"
            aria-label="Open workspace navigation"
            aria-haspopup="dialog"
            onClick={(event) =>
              setDrawer({ kind: "navigation", opener: event.currentTarget })
            }
          >
            <Menu size={21} aria-hidden="true" />
          </Button>
          <Brand />
          <Button
            variant="quiet"
            className="mobile-workspace"
            aria-label={`Switch workspace, current workspace ${workspace.name}`}
            aria-haspopup="dialog"
            onClick={(event) =>
              setDrawer({ kind: "workspace", opener: event.currentTarget })
            }
          >
            <span>{workspace.name}</span>
            <ArrowDownUp size={14} aria-hidden="true" />
          </Button>
        </header>
        <main
          id="main-content"
          className="workspace-main"
          ref={mainRef}
          tabIndex={-1}
        >
          <Outlet />
        </main>
      </div>
      {drawer && (
        <Sheet
          title={
            drawer.kind === "navigation" ? workspace.name : "Switch workspace"
          }
          opener={drawer.opener}
          onDismiss={() => setDrawer(undefined)}
          placement={drawer.kind === "navigation" ? "navigation" : "detail"}
        >
          {(dismiss) =>
            drawer.kind === "navigation" ? (
              <WorkspaceNavigation onNavigate={dismiss} />
            ) : (
              <div className="workspace-picker">
                <p className="current-workspace">
                  <span className="workspace-emblem" aria-hidden="true">
                    {workspace.name.slice(0, 1)}
                  </span>
                  <strong>{workspace.name}</strong>
                  <span>Current workspace</span>
                </p>
                {workspaces && (
                  <>
                    <ul className="destination-list">
                      {workspaces
                        .filter(({ id }) => id !== workspaceId)
                        .map(({ id, name, role }) => (
                          <li key={id}>
                            <Link
                              to={workspacePath("/workspace", id)}
                              onClick={dismiss}
                            >
                              {name} <span>{role}</span>
                            </Link>
                          </li>
                        ))}
                    </ul>
                    <Link to="/workspace#create-workspace" onClick={dismiss}>
                      Create workspace
                    </Link>
                  </>
                )}
              </div>
            )
          }
        </Sheet>
      )}
    </div>
  );
}
