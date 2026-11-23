import { workBriefOriginSchema, type WorkItem } from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { read } from "../identity/api";
import { EvidencePassage } from "../knowledge/evidence-passage";
import { planningRefresh, usePlanning } from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";

export default function WorkBriefOrigin({
  path,
  item,
}: {
  path: string;
  item: WorkItem;
}) {
  const { key, workspace } = usePlanning();
  const result = useQuery({
    queryKey: [
      ...key,
      "project",
      item.projectId,
      "work-item",
      item.id,
      "brief-origin",
    ],
    queryFn: ({ signal }) =>
      read(`${path}/brief-origin`, workBriefOriginSchema, signal),
    ...planningRefresh,
  });
  const origin = result.isError ? undefined : result.data?.origin;
  if (!origin) return null;
  return (
    <section className="planning-panel glass-panel" aria-label="Source brief">
      <h3>Source brief</h3>
      <div className="planning-actions">
        <Link
          to={workspacePath(
            `${projectPath(item.projectId)}/briefs/${origin.briefId}`,
            workspace.id,
          )}
        >
          {origin.title}
        </Link>
        <Link
          to={workspacePath(
            `/reviews/${origin.proposalId}?revision=${origin.revision}`,
            workspace.id,
          )}
        >
          Approved plan
        </Link>
      </div>
      {origin.evidence.map((entry, index) => (
        <EvidencePassage entry={entry} key={index} />
      ))}
    </section>
  );
}
