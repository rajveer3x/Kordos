import type { ResolvedCitation } from "@kordos/contracts";
import { Link } from "react-router";
import { recordingTime } from "../meetings/recording";
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
      : source.kind === "meeting"
        ? project +
          "/meetings/" +
          source.id +
          "?revision=" +
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
          {source.kind !== "comment" &&
            "Revision " + source.anchor.revision + " · "}
          {entry.clip &&
            `${recordingTime(entry.clip.startMs)}–${recordingTime(entry.clip.endMs)} · ${entry.clip.speaker ?? "Unknown speaker"} · `}
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
              : source.kind === "meeting"
                ? "Open transcript revision"
                : "Open discussion"}
          </Link>
        )
      ) : (
        <Link to={citationPath(workspaceId, source)}>Open evidence</Link>
      )}
    </figure>
  );
}
