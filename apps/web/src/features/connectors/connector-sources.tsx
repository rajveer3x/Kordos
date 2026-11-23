import {
  connectorSavedSchema,
  connectorSourcesSchema,
  connectorSourceSchema,
  idSchema,
  type ConnectorSource,
} from "@kordos/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AsyncState, Button, StatusLabel } from "../../components/ui";
import { denied, errorMessage, read, request } from "../identity/api";
import { KnowledgeHeading } from "../knowledge/documents";
import { useKnowledge } from "../knowledge/knowledge-client";
import { planningRefresh } from "../planning/planning-client";
import "./connectors.css";

export function ConnectorSources() {
  const { api, base, key } = useKnowledge();
  const [search, setSearch] = useSearchParams();
  const parsed = idSchema.safeParse(search.get("cursor"));
  const cursor = parsed.success ? parsed.data : null;
  const query = useQuery({
    queryKey: [...key, "external-sources", cursor],
    queryFn: ({ signal }) =>
      read(
        api + "/connector-sources" + (cursor ? "?cursor=" + cursor : ""),
        connectorSourcesSchema,
        signal,
      ),
    ...planningRefresh,
  });
  return (
    <section className="planning-panel glass-panel knowledge-panel">
      <Link to={base}>All documents</Link>
      <KnowledgeHeading title="External sources" />
      {query.isPending ? (
        <AsyncState kind="loading" message="Loading external sources…" />
      ) : query.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(query.error)
              ? "External sources are unavailable."
              : "Could not load external sources."
          }
          retry={denied(query.error) ? undefined : () => void query.refetch()}
        />
      ) : query.data.items.length ? (
        <ul className="connector-rows">
          {query.data.items.map((item) => (
            <li className="planning-item-copy" key={item.id}>
              <Link to={base + "/sources/" + item.id}>{item.title}</Link>
              <span>
                {item.kind === "share" ? "Shared excerpt" : "Mirror"} ·{" "}
                <time dateTime={item.observedAt}>
                  {new Date(item.observedAt).toLocaleString()}
                </time>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="planning-help">
          No external sources are available to you.
        </p>
      )}
      <div className="planning-actions">
        {cursor && (
          <Button variant="secondary" onClick={() => setSearch({})}>
            First page
          </Button>
        )}
        {query.data?.nextCursor && (
          <Button
            variant="secondary"
            onClick={() => setSearch({ cursor: query.data.nextCursor! })}
          >
            Next page
          </Button>
        )}
      </div>
    </section>
  );
}

function SourceActions({ source }: { source: ConnectorSource }) {
  const { api, base, key, details, writable } = useKnowledge();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [excerpt, setExcerpt] = useState("");
  const [preview, setPreview] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const mutationId = useRef(crypto.randomUUID());
  const save = useMutation({
    mutationFn: () =>
      request(
        api +
          "/connector-sources/" +
          source.id +
          (source.canRevoke ? "/revoke" : "/shares"),
        {
          method: "POST",
          schema: connectorSavedSchema,
          body: source.canRevoke
            ? { mutationId: mutationId.current }
            : {
                mutationId: mutationId.current,
                revision: source.revision,
                excerpt,
              },
        },
      ),
    async onSuccess(saved) {
      await client.invalidateQueries({ queryKey: key });
      navigate(
        base + "/sources" + (saved && !source.canRevoke ? "/" + saved.id : ""),
      );
    },
  });
  return (
    <>
      {source.canShare && writable && (
        <form
          className="planning-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (preview) save.mutate();
            else setPreview(true);
          }}
        >
          <label>
            Exact excerpt to share
            <textarea
              value={excerpt}
              rows={3}
              maxLength={4000}
              required
              onChange={(event) => {
                setExcerpt(event.target.value);
                setPreview(false);
                mutationId.current = crypto.randomUUID();
              }}
            />
          </label>
          {preview && (
            <>
              <p>Members with access to {details.name} can read this copy.</p>
              <strong>{source.title}</strong>
              <blockquote className="connector-passage">{excerpt}</blockquote>
              {source.url && (
                <p className="planning-help">
                  The share includes the provider link.
                </p>
              )}
            </>
          )}
          <div className="planning-actions">
            <Button
              type="submit"
              disabled={
                save.isPending ||
                !excerpt.trim() ||
                !source.body.includes(excerpt)
              }
            >
              {preview ? "Share excerpt" : "Preview share"}
            </Button>
          </div>
        </form>
      )}
      {source.canRevoke && (
        <div className="planning-actions">
          {revoke ? (
            <>
              <Button variant="secondary" onClick={() => setRevoke(false)}>
                Cancel
              </Button>
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                Confirm revoke
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setRevoke(true)}>
              Revoke share
            </Button>
          )}
        </div>
      )}
      {save.isError && <p role="alert">{errorMessage(save.error)}</p>}
    </>
  );
}

export function ConnectorSourcePage() {
  const { sourceId } = useParams();
  const { api, key, base } = useKnowledge();
  const [search] = useSearchParams();
  const revision = search.get("revision");
  const query = useQuery({
    queryKey: [...key, "external-source", sourceId, revision],
    queryFn: ({ signal }) =>
      read(
        api +
          "/connector-sources/" +
          sourceId +
          (revision ? "?" + new URLSearchParams({ revision }) : ""),
        connectorSourceSchema,
        signal,
      ),
    ...planningRefresh,
  });
  return (
    <section className="planning-panel glass-panel knowledge-panel">
      <Link to={base + "/sources"}>All external sources</Link>
      {query.isPending ? (
        <AsyncState kind="loading" message="Loading external source…" />
      ) : query.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(query.error)
              ? "This external source is unavailable."
              : "Could not load this source."
          }
          retry={denied(query.error) ? undefined : () => void query.refetch()}
        />
      ) : (
        <>
          <KnowledgeHeading title={query.data.title}>
            <StatusLabel>
              {query.data.kind === "share" ? "Shared excerpt" : "Mirror"}
            </StatusLabel>
          </KnowledgeHeading>
          <p className="planning-help">
            {query.data.sharedBy && <>Shared by {query.data.sharedBy} · </>}
            Revision {query.data.revision} ·{" "}
            <time dateTime={query.data.observedAt}>
              {new Date(query.data.observedAt).toLocaleString()}
            </time>
          </p>
          <blockquote className="connector-passage">
            {query.data.body}
          </blockquote>
          {query.data.url && (
            <a href={query.data.url} rel="noreferrer">
              Open at provider
            </a>
          )}
          <SourceActions
            key={query.data.id + "/" + query.data.revision}
            source={query.data}
          />
        </>
      )}
    </section>
  );
}
