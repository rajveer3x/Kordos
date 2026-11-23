import type { StatusTone } from "../../components/ui";

export const workspaceDestinations = [
  {
    id: "home",
    label: "Home",
    path: "/workspace",
    empty: "Assigned work will appear here.",
  },
  {
    id: "projects",
    label: "Projects",
    path: "/projects",
    empty: "There are no projects in this workspace yet.",
  },
  {
    id: "search",
    label: "Search",
    path: "/search",
    empty: "Searchable workspace items will appear here.",
  },
  {
    id: "inbox",
    label: "Inbox",
    path: "/inbox",
    empty: "You have no notifications.",
  },
  {
    id: "reviews",
    label: "Reviews",
    path: "/reviews",
    empty: "There are no reviews to resolve.",
  },
  {
    id: "audit",
    label: "Audit",
    path: "/audit",
    empty: "There is no audit history yet.",
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    empty: "Workspace settings will appear here.",
  },
] as const;

export const projectDestinations = [
  { id: "overview", label: "Overview", empty: "" },
  { id: "work", label: "Work", empty: "There are no work items yet." },
  {
    id: "graph",
    label: "Graph",
    empty: "Dependencies will appear here when work items are linked.",
  },
  { id: "documents", label: "Documents", empty: "There are no documents yet." },
  { id: "meetings", label: "Meetings", empty: "There are no meetings yet." },
  {
    id: "activity",
    label: "Activity",
    empty: "There is no project activity yet.",
  },
] as const;

export type ProjectDestination = (typeof projectDestinations)[number];
export type WorkspaceDestination = (typeof workspaceDestinations)[number];

export type Evidence = {
  id: string;
  title: string;
  kind: string;
  author: string;
  excerpt: string;
  date: string;
};

export type ProjectSignal = {
  id: string;
  title: string;
  status: string;
  tone: StatusTone;
  description: string;
  evidence?: Evidence;
};

export type Project = {
  id: string;
  name: string;
  description?: string;
  visibility?: "restricted" | "workspace";
  archived?: boolean;
  commitment?: string;
  forecast?: string;
  lead?: string;
  signals: readonly ProjectSignal[];
};

export type Workspace = {
  name: string;
  member: { name: string; initials: string };
  projects: readonly Project[];
};

export function workspacePath(path: string, workspaceId?: string) {
  return workspaceId ? `/w/${encodeURIComponent(workspaceId)}${path}` : path;
}

export function projectPath(
  id: string,
  destination: ProjectDestination["id"] = "overview",
) {
  const root = `/projects/${encodeURIComponent(id)}`;
  return destination === "overview" ? root : `${root}/${destination}`;
}

export function evidencePath(projectId: string, sourceId: string) {
  return `${projectPath(projectId, "documents")}/${encodeURIComponent(sourceId)}`;
}
