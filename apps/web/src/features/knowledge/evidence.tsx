import { resolvedCitationSchema, type Citation } from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import { denied, read } from "../identity/api";
import { planningRefresh } from "../planning/planning-client";
import { EvidencePassage } from "./evidence-passage";
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

export { EvidencePassage } from "./evidence-passage";
