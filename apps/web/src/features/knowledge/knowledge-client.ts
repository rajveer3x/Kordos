import { citationSchema, type Citation } from "@kordos/contracts";
import { useLiveProject, usePlanning } from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";

export function useKnowledge() {
  const { details } = useLiveProject();
  const { api, key, actorId, workspace } = usePlanning();
  const project = projectPath(details.id);
  return {
    details,
    actorId,
    workspaceId: workspace.id,
    base: workspacePath(project + "/documents", workspace.id),
    api: api + project,
    key: [...key, "knowledge", details.id] as const,
    writable: details.role !== "viewer" && !details.archived,
  };
}

export function citationPath(workspaceId: string, source: Citation) {
  const query =
    source.kind === "document"
      ? "?" +
        new URLSearchParams({
          revision: String(source.anchor.revision),
          start: String(source.anchor.start),
          end: String(source.anchor.end),
        })
      : "";
  return (
    workspacePath(
      projectPath(source.projectId) +
        "/documents/evidence/" +
        source.kind +
        "/" +
        source.id,
      workspaceId,
    ) + query
  );
}

export function citationFromLink(input: string, workspaceId: string) {
  const url = URL.parse(input, window.location.origin);
  if (!url || url.origin !== window.location.origin) return;
  const match =
    /^\/w\/([^/]+)\/projects\/([^/]+)\/documents\/evidence\/([^/]+)\/([^/]+)$/.exec(
      url.pathname,
    );
  if (!match || match[1] !== workspaceId) return;
  const [, , projectId, kind, id] = match;
  return citationFromRoute(projectId, kind, id, url.searchParams);
}

export function citationFromRoute(
  projectId: string | undefined,
  kind: string | undefined,
  id: string | undefined,
  search: URLSearchParams,
) {
  const result = citationSchema.safeParse({
    kind,
    projectId,
    id,
    anchor: {
      revision: Number(search.get("revision") ?? NaN),
      start: Number(search.get("start") ?? NaN),
      end: Number(search.get("end") ?? NaN),
    },
  });
  return result.success ? result.data : undefined;
}
