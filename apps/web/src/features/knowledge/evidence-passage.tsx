import type { ResolvedCitation } from "@kordos/contracts";
import { Link } from "react-router";
import { usePlanning } from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import { citationPath } from "./knowledge-client";
import "./knowledge.css";

export function EvidencePassage({
  entry,
  standalone,
}: {
  entry: ResolvedCitation;
  standalone?: boolean;
}) {
  const { workspace } = usePlanning();
  const workspaceId = workspace.id;
  const { source, author, capturedAt } = entry;
  const project = workspacePath(projectPath(source.projectId), workspaceId);
  const subject = entry.subject;
  const original =
    source.kind === "document"
      ? project +
        "/documents/" +
        source.id +
        "/revisions/" +
        source.anchor.revision
      : subject?.kind === "task"
        ? project + "/work/" + subject.id
        : subject?.kind === "document"
          ? project + "/documents/" + subject.id
          : subject?.kind === "project"
            ? project
            : undefined;
  return (
    <figure className="knowledge-evidence">
      <figcaption>
        <strong>{entry.title}</strong>
        <span className="planning-help">
          {source.kind === "document" &&
            "Revision " + source.anchor.revision + " · "}
          {author.name} ·{" "}
          <time dateTime={capturedAt}>
            {new Date(capturedAt).toLocaleString()}
          </time>
          {entry.newer && " · Newer revision available"}
        </span>
      </figcaption>
      <blockquote>{entry.excerpt}</blockquote>
      {standalone ? (
        original && (
          <Link to={original}>
            {source.kind === "document"
              ? "Open full revision"
              : "Open discussion"}
          </Link>
        )
      ) : (
        <Link to={citationPath(workspaceId, source)}>Open evidence</Link>
      )}
    </figure>
  );
}
