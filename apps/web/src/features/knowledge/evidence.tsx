import {
  resolvedCitationSchema,
  type Citation,
  type ResolvedCitation,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import { denied, read } from "../identity/api";
import { planningRefresh, usePlanning } from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import { KnowledgeHeading, KnowledgeState } from "./documents";
import {
  citationFromRoute,
  citationPath,
  useKnowledge,
} from "./knowledge-client";

export function useCitation(source?: Citation) {
  const { workspaceId, key } = useKnowledge();
  const link = source ? citationPath(workspaceId, source) : "";
  const endpoint = link.replace(
    /^\/w\/([^/]+)(\/projects\/[^/]+)\/documents\/evidence\//,
    "/workspaces/$1$2/evidence/",
  );
  return useQuery({
    queryKey: [...key, "evidence", link],
    queryFn: ({ signal }) => read(endpoint, resolvedCitationSchema, signal),
    enabled: !!source,
    ...planningRefresh,
  });
}

export function EvidencePage() {
  const { kind, sourceId } = useParams();
  const [search] = useSearchParams();
  const { details, base, workspaceId, writable } = useKnowledge();
  const source = citationFromRoute(details.id, kind, sourceId, search);
  const result = useCitation(source);
  return (
    <section className="planning-panel glass-panel knowledge-panel">
      <Link to={base}>All documents</Link>
      <KnowledgeHeading title="Evidence" />
      {!source || !result.data || result.isError ? (
        <KnowledgeState
          name="Evidence"
          unavailable={!source || denied(result.error)}
          loading={result.isPending}
          retry={() => void result.refetch()}
        />
      ) : (
        <>
          <EvidencePassage entry={result.data} standalone />
          {writable && (
            <Link
              to={
                base +
                "/decisions/new?" +
                new URLSearchParams({
                  source: citationPath(workspaceId, source),
                })
              }
            >
              Draft decision with evidence
            </Link>
          )}
        </>
      )}
    </section>
  );
}

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
