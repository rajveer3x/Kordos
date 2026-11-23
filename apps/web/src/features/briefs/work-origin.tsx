import {
  meetingWorkOriginSchema,
  workBriefOriginSchema,
  type WorkItem,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { read } from "../identity/api";
import { citationPath } from "../knowledge/knowledge-client";
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
  const meeting = useQuery({
    queryKey: [
      ...key,
      "project",
      item.projectId,
      "work-item",
      item.id,
      "meeting-origin",
    ],
    queryFn: ({ signal }) =>
      read(`${path}/meeting-origin`, meetingWorkOriginSchema, signal),
    enabled: result.isSuccess && !origin,
    ...planningRefresh,
  });
  const meetingOrigin = meeting.isError ? undefined : meeting.data?.origin;
  if (!origin)
    return !meetingOrigin ? null : (
      <section
        className="planning-panel glass-panel"
        aria-label="Source meeting"
      >
        <h3>Source meeting</h3>
        <div className="planning-actions">
          <Link
            to={workspacePath(
              `${projectPath(item.projectId)}/meetings/${meetingOrigin.meetingId}`,
              workspace.id,
            )}
          >
            {meetingOrigin.title}
          </Link>
          <Link
            to={citationPath(workspace.id, {
              kind: "meeting",
              projectId: item.projectId,
              id: meetingOrigin.meetingId,
              anchor: meetingOrigin.anchor,
            })}
          >
            Open supporting segment
          </Link>
          <Link
            to={workspacePath(
              `/reviews/${meetingOrigin.proposalId}`,
              workspace.id,
            )}
          >
            Approval receipt
          </Link>
        </div>
      </section>
    );
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
