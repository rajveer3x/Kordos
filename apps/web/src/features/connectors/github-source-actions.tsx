import { workPageSchema, type ConnectorSource } from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "../../components/ui";
import { errorMessage, read } from "../identity/api";
import { useKnowledge } from "../knowledge/knowledge-client";
import {
  planningRefresh,
  usePlanningCommand,
} from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";

export function GitHubSourceActions({ source }: { source: ConnectorSource }) {
  const { api, workspaceId, details } = useKnowledge();
  const navigate = useNavigate();
  const [body, setBody] = useState("");
  const command = usePlanningCommand();
  const link = usePlanningCommand();
  const base = workspacePath(projectPath(details.id), workspaceId);
  const linkWork = (workId: string, linked: boolean, done: () => void) => {
    void link.save(
      `${api}/connector-sources/${source.id}/work-links`,
      "POST",
      { workId, linked },
      done,
      linked ? "Work link confirmed." : "Work link removed.",
    );
  };
  return (
    <>
      <section className="review-section">
        <h2>Linked work</h2>
        {source.linkedWork?.length ? (
          <ul className="connector-rows">
            {source.linkedWork.map(({ id, title, confirmed }) => (
              <li key={id} className="connector-row">
                <div className="planning-item-copy">
                  <Link to={`${base}/work/${id}`}>{title}</Link>
                  <span>
                    {confirmed ? "Confirmed link" : "Work ID in GitHub"}
                  </span>
                </div>
                {confirmed && source.canLinkWork && (
                  <Button
                    variant="quiet"
                    disabled={link.busy}
                    onClick={() => linkWork(id, false, () => undefined)}
                  >
                    Remove link
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="planning-help">No work is linked.</p>
        )}
        {source.canLinkWork && (
          <WorkMatch
            busy={link.busy}
            confirm={(id, done) => linkWork(id, true, done)}
          />
        )}
        {link.error && <p role="alert">{link.error.message}</p>}
        {link.notice && <p role="status">{link.notice}</p>}
      </section>
      {source.canDraftComment && (
        <details>
          <summary>Draft GitHub comment</summary>
          <form
            className="planning-form"
            onSubmit={(event) => {
              event.preventDefault();
              void command.save(
                api + "/github-comment-proposals",
                "POST",
                { githubSourceId: source.id, body },
                (id) => navigate(workspacePath(`/reviews/${id}`, workspaceId)),
              );
            }}
          >
            <label>
              Comment body
              <textarea
                required
                maxLength={12000}
                rows={5}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
            <div className="planning-actions">
              <Button type="submit" disabled={command.busy || !body.trim()}>
                Save comment proposal
              </Button>
            </div>
            {command.error && <p role="alert">{command.error.message}</p>}
          </form>
        </details>
      )}
    </>
  );
}

function WorkMatch({
  busy,
  confirm,
}: {
  busy: boolean;
  confirm: (id: string, done: () => void) => void;
}) {
  const { api, key } = useKnowledge();
  const [search, setSearch] = useState("");
  const [work, setWork] = useState("");
  const [cursor, setCursor] = useState("");
  const query = useQuery({
    queryKey: [...key, "github-link-work", search.trim(), cursor],
    queryFn: ({ signal }) =>
      read(
        api +
          "/work?" +
          new URLSearchParams({
            q: search.trim(),
            ...(cursor ? { cursor } : {}),
          }),
        workPageSchema,
        signal,
      ),
    enabled: search.trim().length > 0,
    ...planningRefresh,
  });
  return (
    <form
      className="planning-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (work) confirm(work, () => setWork(""));
      }}
    >
      <label>
        Find work to link
        <input
          type="search"
          value={search}
          maxLength={180}
          onChange={(event) => {
            setSearch(event.target.value);
            setWork("");
            setCursor("");
          }}
        />
      </label>
      {search.trim() &&
        (query.isPending ? (
          <p role="status">Finding work…</p>
        ) : query.isError ? (
          <p role="alert">{errorMessage(query.error)}</p>
        ) : query.data.items.length ? (
          <>
            <label>
              Work item
              <select
                value={work}
                required
                onChange={(event) => setWork(event.target.value)}
              >
                <option value="" disabled>
                  Choose a work item
                </option>
                {query.data.items.map(({ id, title }) => (
                  <option key={id} value={id}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <div className="planning-actions">
              <Button type="submit" disabled={busy || !work}>
                Confirm link
              </Button>
              {cursor && (
                <Button
                  variant="quiet"
                  onClick={() => {
                    setCursor("");
                    setWork("");
                  }}
                >
                  First results
                </Button>
              )}
              {query.data.nextCursor && (
                <Button
                  variant="quiet"
                  onClick={() => {
                    setCursor(query.data.nextCursor ?? "");
                    setWork("");
                  }}
                >
                  More results
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className="planning-help">No work matches this search.</p>
        ))}
    </form>
  );
}
