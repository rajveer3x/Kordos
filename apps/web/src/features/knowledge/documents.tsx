import {
  documentDetailSchema,
  documentDirectorySchema,
  documentCommandSchema,
  attachmentMaxBytes,
  projectCommandResponseSchema,
  type DocumentDetail,
  type DocumentRevision,
  type Citation,
  type PassageAnchor,
} from "@kordos/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AsyncState, Button, StatusLabel } from "../../components/ui";
import { DiscussionPanel } from "../collaboration/discussion-panel";
import { denied, errorMessage, read, request } from "../identity/api";
import {
  planningRefresh,
  retainEdits,
  usePlanningCommand,
} from "../planning/planning-client";
import { anchorBetween, FormattedText, RichEditor } from "./formatted-text";
import { citationPath, useKnowledge } from "./knowledge-client";
import "./knowledge.css";

export function KnowledgeState({
  name,
  unavailable,
  loading,
  retry,
}: {
  name: string;
  unavailable: boolean;
  loading: boolean;
  retry: () => void;
}) {
  if (unavailable)
    return <AsyncState kind="error" message={name + " unavailable."} />;
  if (loading)
    return (
      <AsyncState
        kind="loading"
        message={"Loading " + name.toLowerCase() + "…"}
      />
    );
  return (
    <AsyncState
      kind="error"
      message={"Could not load " + name.toLowerCase() + "."}
      retry={retry}
    />
  );
}

export function KnowledgeHeading({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="knowledge-heading">
      <title>{title + " · Kordos"}</title>
      <h2>{title}</h2>
      <div className="knowledge-actions">{children}</div>
    </div>
  );
}

export function Documents() {
  const { api, base, key, writable } = useKnowledge();
  const [search] = useSearchParams();
  const archived = search.get("archived") === "true";
  const files = useQuery({
    queryKey: [...key, "documents", archived],
    queryFn: ({ signal }) =>
      read(
        api + "/documents?archived=" + archived,
        documentDirectorySchema,
        signal,
      ),
    ...planningRefresh,
  });
  return (
    <section className="planning-panel glass-panel knowledge-panel">
      <KnowledgeHeading title="Documents">
        <Link to={base + "/decisions"}>Decision register</Link>
        {writable && (
          <Link className="button button--primary" to={base + "/new"}>
            Create document
          </Link>
        )}
      </KnowledgeHeading>
      <Link to={archived ? base : base + "?archived=true"}>
        {archived ? "Show active documents" : "Show archived documents"}
      </Link>
      {denied(files.error) || !files.data ? (
        <KnowledgeState
          name="Documents"
          unavailable={denied(files.error)}
          loading={files.isPending}
          retry={() => void files.refetch()}
        />
      ) : files.data.length ? (
        <ul className="knowledge-list">
          {files.data.map((file) => (
            <li key={file.id}>
              <Link to={base + "/" + file.id}>{file.title}</Link>
              <span className="planning-help">Revision {file.revision}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-message">
          {archived ? "No archived documents yet." : "No documents yet."}
        </p>
      )}
    </section>
  );
}

export function DocumentPage() {
  const { documentId, revision } = useParams();
  const { api, base, key } = useKnowledge();
  const path = api + "/documents/" + documentId;
  const file = useQuery({
    queryKey: [...key, "document", documentId, revision],
    queryFn: ({ signal }) =>
      read(
        path + (revision ? "?revision=" + encodeURIComponent(revision) : ""),
        documentDetailSchema,
        signal,
      ),
    ...planningRefresh,
  });
  if (denied(file.error) || !file.data) {
    return (
      <KnowledgeState
        name="Document"
        unavailable={denied(file.error)}
        loading={file.isPending}
        retry={() => void file.refetch()}
      />
    );
  }
  return (
    <DocumentReader
      key={file.data.id + ":" + (revision ?? "current")}
      file={file.data}
      path={path}
      documentPath={base + "/" + documentId}
      historical={!!revision}
    />
  );
}

function DocumentReader({
  file,
  path,
  documentPath,
  historical,
}: {
  file: DocumentDetail;
  path: string;
  documentPath: string;
  historical: boolean;
}) {
  const { base, workspaceId, writable, details } = useKnowledge();
  const navigate = useNavigate();
  const command = usePlanningCommand();
  const [editing, setEditing] = useState(false);
  const [archive, setArchive] = useState(false);
  const [selected, setSelected] = useState<{
    anchor: PassageAnchor;
    excerpt: string;
  }>();
  const [copied, setCopied] = useState("");
  const { entry } = file;
  const anchor = selected?.anchor;
  const source: Citation | undefined = anchor && {
    kind: "document",
    projectId: details.id,
    id: file.id,
    anchor,
  };
  const link = source && citationPath(workspaceId, source);
  const editable = writable && !file.archivedAt;
  const projectBase = base.slice(0, -"/documents".length);
  function select(passage?: PassageAnchor) {
    setSelected(
      passage && {
        anchor: passage,
        excerpt: Array.from(entry.content)
          .slice(passage.start, passage.end)
          .join(""),
      },
    );
    setCopied("");
  }
  async function copyEvidence() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(
        new URL(link, window.location.origin).href,
      );
      setCopied("Evidence link copied.");
    } catch {
      setCopied("Open the evidence link to copy its address.");
    }
  }
  return (
    <div className="knowledge-stack">
      <section className="planning-panel glass-panel knowledge-panel">
        <Link to={base}>All documents</Link>
        <KnowledgeHeading title={entry.title}>
          {file.archivedAt && <StatusLabel>Archived</StatusLabel>}
          {!editing && editable && !historical && (
            <Button onClick={() => setEditing(true)}>Edit document</Button>
          )}
          {historical && <Link to={documentPath}>Current revision</Link>}
        </KnowledgeHeading>
        <p className="planning-help">
          Revision {entry.revision} · {entry.author.name} ·{" "}
          <time dateTime={entry.createdAt}>
            {new Date(entry.createdAt).toLocaleString()}
          </time>
        </p>
        {editing ? (
          <DocumentEditor file={file} close={() => setEditing(false)} />
        ) : (
          <>
            {entry.content ? (
              <FormattedText
                content={entry.content}
                projectBase={projectBase}
                revision={entry.revision}
                onSelection={select}
              />
            ) : (
              <p className="planning-help">This document has no text yet.</p>
            )}
            {entry.content && (
              <details className="knowledge-select planning-form">
                <summary>Select a passage with the keyboard</summary>
                <label>
                  Saved document text
                  <textarea
                    rows={5}
                    value={entry.content}
                    readOnly
                    onSelect={(event) => {
                      const { selectionStart, selectionEnd } =
                        event.currentTarget;
                      select(
                        anchorBetween(
                          entry.content,
                          entry.revision,
                          selectionStart,
                          selectionEnd,
                        ),
                      );
                    }}
                  />
                </label>
              </details>
            )}
            {selected && link && (
              <div className="knowledge-selection">
                <p className="planning-help">
                  Selected passage from revision {selected.anchor.revision}
                </p>
                <blockquote>{selected.excerpt}</blockquote>
                <div className="knowledge-actions">
                  <Link to={link}>Open selected passage</Link>
                  <Button
                    variant="secondary"
                    onClick={() => void copyEvidence()}
                  >
                    Copy evidence link
                  </Button>
                  {writable && (
                    <Link
                      to={
                        base +
                        "/decisions/new?" +
                        new URLSearchParams({ source: link })
                      }
                    >
                      Draft decision with passage
                    </Link>
                  )}
                  <Button variant="quiet" onClick={() => select()}>
                    Clear selection
                  </Button>
                </div>
                <span role="status">{copied}</span>
              </div>
            )}
          </>
        )}
      </section>
      <section className="planning-panel glass-panel knowledge-panel">
        <h2>Revision history</h2>
        <ul className="knowledge-list">
          {file.history.map((item) => (
            <li key={item.revision}>
              <Link
                to={documentPath + "/revisions/" + item.revision}
                aria-current={
                  entry.revision === item.revision ? "page" : undefined
                }
              >
                Revision {item.revision}
              </Link>
              <span className="planning-help">
                {item.author.name} ·{" "}
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString()}
                </time>
                {item.baseRevision &&
                  " · Based on revision " + item.baseRevision}
                {item.restoredFrom &&
                  " · Restored from revision " + item.restoredFrom}
              </span>
            </li>
          ))}
        </ul>
        {editable && historical && entry.revision < file.revision && (
          <Button
            variant="secondary"
            disabled={command.busy}
            onClick={() =>
              void command.save(
                path,
                "PATCH",
                {
                  action: "restore",
                  expectedVersion: file.version,
                  revision: entry.revision,
                },
                () => navigate(documentPath),
              )
            }
          >
            Restore as new revision
          </Button>
        )}
        {editable &&
          !historical &&
          !editing &&
          (archive ? (
            <div className="knowledge-actions">
              <p>Archive this document and make it read-only?</p>
              <Button
                variant="secondary"
                disabled={command.busy}
                onClick={() =>
                  void command.save(
                    path,
                    "PATCH",
                    { action: "archive", expectedVersion: file.version },
                    () => setArchive(false),
                    "Document archived.",
                  )
                }
              >
                Confirm archive
              </Button>
              <Button
                variant="quiet"
                disabled={command.busy}
                onClick={() => setArchive(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="quiet" onClick={() => setArchive(true)}>
              Archive document
            </Button>
          ))}
        {command.error && (
          <p role="alert" className="planning-error">
            {command.error.message}
          </p>
        )}
        <span role="status">{command.notice}</span>
      </section>
      <Attachments file={file} path={path} upload={editable && !historical} />
      <DiscussionPanel
        projectId={details.id}
        subject={{ kind: "document", id: file.id }}
        anchor={anchor}
        onAnchoredPost={() => select()}
      />
    </div>
  );
}

export function DocumentEditor({
  file,
  close,
}: {
  file?: DocumentDetail;
  close?: () => void;
}) {
  const { api, base, writable } = useKnowledge();
  const navigate = useNavigate();
  const command = usePlanningCommand();
  const original = file
    ? { title: file.entry.title, content: file.entry.content }
    : { title: "", content: "" };
  const [baseline, setBaseline] = useState(() => ({
    fields: original,
    version: file?.version ?? 0,
  }));
  const [draft, setDraft] = useState(original);
  const conflict = documentDetailSchema.safeParse(command.error?.current);
  const current = conflict.success ? conflict.data : undefined;
  const newest =
    current && (!file || current.version >= file.version) ? current : file;
  const latest =
    newest && newest.version > baseline.version ? newest : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (latest) return;
    const fields = file
      ? { action: "save", expectedVersion: baseline.version, ...draft }
      : { action: "create", ...draft };
    const input = documentCommandSchema.safeParse({
      ...fields,
      mutationId: crypto.randomUUID(),
    });
    if (!input.success) {
      command.invalid(
        "Enter a title and use up to 80,000 characters for the document text.",
      );
      return;
    }
    void command.save(
      api + "/documents" + (file ? "/" + file.id : ""),
      file ? "PATCH" : "POST",
      fields,
      (id) => (close ? close() : navigate(base + "/" + id)),
      "Document saved.",
    );
  }

  if (!writable)
    return (
      <AsyncState kind="error" message="Document editing is unavailable." />
    );
  return (
    <section
      className={
        file ? undefined : "planning-panel glass-panel knowledge-panel"
      }
    >
      {!file && (
        <>
          <Link to={base}>All documents</Link>
          <KnowledgeHeading title="Create document" />
        </>
      )}
      <form className="planning-form" onSubmit={submit}>
        <label>
          Document title
          <input
            value={draft.title}
            maxLength={160}
            required
            readOnly={command.busy}
            onChange={(event) =>
              setDraft({ ...draft, title: event.currentTarget.value })
            }
          />
        </label>
        <RichEditor
          value={draft.content}
          disabled={command.busy}
          onChange={(content) => setDraft({ ...draft, content })}
        />
        {latest && (
          <RevisionComparison
            draft={draft}
            entry={latest.entry}
            onUseLatest={() => {
              const fields = {
                title: latest.entry.title,
                content: latest.entry.content,
              };
              setDraft(retainEdits(draft, baseline.fields, fields));
              setBaseline({ fields, version: latest.version });
              command.clearError();
            }}
          />
        )}
        {command.error && (
          <p role="alert" className="planning-error">
            {command.error.message}
          </p>
        )}
        <div className="knowledge-actions">
          <Button
            type="submit"
            disabled={command.busy || !!latest || !!file?.archivedAt}
          >
            {command.busy
              ? "Saving…"
              : file
                ? "Save revision"
                : "Create document"}
          </Button>
          {close && (
            <Button variant="quiet" onClick={close} disabled={command.busy}>
              Cancel editing
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function RevisionComparison({
  draft,
  entry,
  onUseLatest,
}: {
  draft: { title: string; content: string };
  entry: DocumentRevision;
  onUseLatest: () => void;
}) {
  return (
    <section className="knowledge-conflict" aria-label="Compare revisions">
      <h3>Compare revisions</h3>
      <p>
        Review the latest changes and merge them into your draft before saving
        again.
      </p>
      <div className="knowledge-compare">
        <div>
          <h4>Latest revision ({entry.revision})</h4>
          <strong>{entry.title}</strong>
          <pre>{entry.content}</pre>
        </div>
        <div>
          <h4>Your draft</h4>
          <strong>{draft.title}</strong>
          <pre>{draft.content}</pre>
        </div>
      </div>
      <Button variant="secondary" onClick={onUseLatest}>
        Continue editing on latest revision
      </Button>
    </section>
  );
}

function Attachments({
  file,
  path,
  upload,
}: {
  file: DocumentDetail;
  path: string;
  upload: boolean;
}) {
  const { key } = useKnowledge();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mutation = useRef(crypto.randomUUID());
  async function attach(event: FormEvent) {
    event.preventDefault();
    const selected = input.current?.files?.[0];
    if (!selected || pending.current) return;
    setMessage("");
    if (!selected.size || selected.size > attachmentMaxBytes) {
      setError("Choose a file between 1 byte and 10 MB.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({
        name: selected.name,
        mutationId: mutation.current,
      });
      await request(path + "/attachments?" + query, {
        method: "POST",
        binary: selected,
        schema: projectCommandResponseSchema,
      });
      await client.invalidateQueries({ queryKey: key });
      if (input.current) input.current.value = "";
      mutation.current = crypto.randomUUID();
      setMessage("Attachment uploaded.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="planning-panel glass-panel knowledge-panel">
      <h2>Attachments</h2>
      {file.attachments.length ? (
        <ul className="knowledge-list">
          {file.attachments.map((item) => (
            <li key={item.id}>
              <a href={"/api" + path + "/attachments/" + item.id} download>
                {item.name}
              </a>
              <span className="planning-help">
                {item.size.toLocaleString()} bytes
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="planning-help">No attachments yet.</p>
      )}
      {upload && (
        <form
          className="planning-form"
          onSubmit={(event) => void attach(event)}
        >
          <label>
            Choose attachment
            <input
              type="file"
              ref={input}
              required
              disabled={busy}
              onChange={() => {
                mutation.current = crypto.randomUUID();
                setMessage("");
                setError("");
              }}
            />
          </label>
          <p className="planning-help">Maximum file size 10 MB.</p>
          <Button type="submit" disabled={busy}>
            {busy ? "Uploading…" : "Upload attachment"}
          </Button>
          {error && (
            <p role="alert" className="planning-error">
              {error}
            </p>
          )}
          <span role="status">{message}</span>
        </form>
      )}
    </section>
  );
}
