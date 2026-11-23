import {
  commentSnapshotSchema,
  projectCommandResponseSchema,
  type CollaborationScope,
  type Comment,
  type CommentCommand,
  type CommentSnapshot,
  type PassageAnchor,
} from "@kordos/contracts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router";
import { AsyncState, Button } from "../../components/ui";
import { ApiError, denied, errorMessage, read, request } from "../identity/api";
import { citationPath } from "../knowledge/knowledge-client";
import { planningRefresh, usePlanning } from "../planning/planning-client";
import { useDiscussionLive } from "./discussion-live";
import "./discussion.css";

type Draft = { body: string; mentionIds: string[] };
type Post = Extract<CommentCommand, { action: "post" }>;
type Command = CommentCommand extends infer Variant
  ? Variant extends CommentCommand
    ? Omit<Variant, "mutationId">
    : never
  : never;
type Save = (command: Command, mutationId: string) => Promise<void>;

export function DiscussionPanel({
  projectId,
  subject,
  anchor,
  onAnchoredPost,
}: Pick<CollaborationScope, "projectId" | "subject"> & {
  anchor?: PassageAnchor;
  onAnchoredPost?: () => void;
}) {
  const { actorId, workspace, api } = usePlanning();
  return (
    <Discussion
      key={`${actorId}:${workspace.id}:${workspace.role}:${projectId}:${subject.kind}:${subject.id}`}
      scope={{ workspaceId: workspace.id, projectId, subject }}
      anchor={anchor}
      onAnchoredPost={onAnchoredPost}
      path={`${api}/projects/${projectId}/discussions/${subject.kind}/${subject.id}`}
    />
  );
}

function Discussion({
  scope,
  path,
  anchor,
  onAnchoredPost,
}: {
  scope: CollaborationScope;
  path: string;
  anchor?: PassageAnchor;
  onAnchoredPost?: () => void;
}) {
  const { actorId, workspace } = usePlanning();
  const {
    workspaceId,
    projectId,
    subject: { kind, id },
  } = scope;
  const client = useQueryClient();
  const heading = useId();
  const key = useMemo(
    () =>
      [
        "planning",
        actorId,
        workspaceId,
        workspace.role,
        "discussion",
        projectId,
        kind,
        id,
      ] as const,
    [actorId, workspaceId, workspace.role, projectId, kind, id],
  );
  const snapshot = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read(
        pageParam ? `${path}?before=${pageParam}` : path,
        commentSnapshotSchema,
        signal,
      ),
    getNextPageParam: (last) => last.older,
    ...planningRefresh,
  });
  const refresh = useCallback(
    (accessChanged?: boolean) => {
      void client.invalidateQueries({ queryKey: key });
      if (accessChanged) {
        void client.invalidateQueries({
          queryKey: [...key.slice(0, 4), "project", projectId],
        });
        void client.invalidateQueries({
          queryKey: ["identity", "workspace", actorId, workspaceId],
        });
      }
    },
    [client, key, projectId, actorId, workspaceId],
  );
  const latest = snapshot.data?.pages[0];
  return (
    <section
      className="discussion planning-panel glass-panel"
      aria-labelledby={heading}
    >
      <h2 id={heading}>Discussion</h2>
      {denied(snapshot.error) ? (
        <AsyncState kind="error" message="This discussion is unavailable." />
      ) : latest && snapshot.data ? (
        <DiscussionContent
          actorId={actorId}
          scope={scope}
          path={path}
          anchor={anchor}
          onAnchoredPost={onAnchoredPost}
          refresh={refresh}
          latest={latest}
          items={snapshot.data.pages.flatMap((page) => page.items)}
          older={
            snapshot.hasNextPage
              ? () => void snapshot.fetchNextPage({ cancelRefetch: false })
              : undefined
          }
          fetchingOlder={snapshot.isFetchingNextPage}
          refreshError={snapshot.isError}
        />
      ) : snapshot.isPending ? (
        <AsyncState kind="loading" message="Loading discussion…" />
      ) : (
        <AsyncState
          kind="error"
          message="Could not load the discussion."
          retry={() => void snapshot.refetch()}
        />
      )}
    </section>
  );
}

function DiscussionContent({
  actorId,
  scope,
  path,
  anchor,
  onAnchoredPost,
  refresh,
  latest,
  items,
  older,
  fetchingOlder,
  refreshError,
}: {
  actorId: string;
  scope: CollaborationScope;
  path: string;
  anchor?: PassageAnchor;
  onAnchoredPost?: () => void;
  refresh: (accessChanged?: boolean) => void;
  latest: CommentSnapshot;
  items: Comment[];
  older?: () => void;
  fetchingOlder: boolean;
  refreshError: boolean;
}) {
  const live = useDiscussionLive(scope, path, latest.cursor, actorId, refresh);
  const [pending, setPending] = useState<Post[]>([]);
  const shown = [...new Map(items.map((item) => [item.id, item])).values()];
  const confirmed = new Set(
    shown
      .filter(({ author }) => author.id === actorId)
      .map(({ mutationId }) => mutationId),
  );
  const inFlight = pending.filter(
    ({ mutationId }) => !confirmed.has(mutationId),
  );
  const replies = new Map<string, Comment[]>();
  for (const item of shown) {
    if (!item.parentId) continue;
    const list = replies.get(item.parentId) ?? [];
    list.push(item);
    replies.set(item.parentId, list);
  }
  const roots = shown
    .filter(({ parentId }) => !parentId)
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

  const save: Save = async (command, mutationId) => {
    if (command.action === "post")
      setPending((list) => [...list, { ...command, mutationId }]);
    try {
      await request(path, {
        method: "POST",
        body: { ...command, mutationId },
        schema: projectCommandResponseSchema,
      });
    } catch (error) {
      refresh(denied(error));
      throw error;
    } finally {
      // Wait for the canonical snapshot before removing the optimistic entry.
      await refreshSnapshot();
      if (command.action === "post")
        setPending((list) =>
          list.filter((entry) => entry.mutationId !== mutationId),
        );
    }
  };
  const client = useQueryClient();
  function refreshSnapshot() {
    return client.invalidateQueries({
      queryKey: ["planning", actorId, scope.workspaceId],
      predicate: ({ queryKey }) =>
        queryKey[4] === "discussion" && queryKey[5] === scope.projectId,
    });
  }

  if (live.connection === "revoked")
    return (
      <AsyncState kind="error" message="This discussion is unavailable." />
    );
  return (
    <>
      <div className="discussion-presence">
        <span>
          {live.presence.length
            ? `Here now: ${live.presence.map(({ name }) => name).join(", ")}`
            : "No active participants"}
        </span>
        {live.connection !== "live" && (
          <span role="status">
            {live.connection === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        )}
      </div>
      <div className="sr-only" role="status">
        {live.received > 0 &&
          `${live.received} new ${live.received === 1 ? "comment" : "comments"} received.`}
      </div>
      {refreshError && (
        <AsyncState
          kind="error"
          message="Could not refresh the discussion."
          retry={() => refresh()}
        />
      )}
      {older && (
        <Button variant="quiet" disabled={fetchingOlder} onClick={older}>
          {fetchingOlder ? "Loading…" : "Older threads"}
        </Button>
      )}
      {!roots.length && !inFlight.length && (
        <p className="planning-help">No comments yet.</p>
      )}
      <ul className="discussion-list">
        {roots.map((root) => (
          <Thread
            key={root.mutationId + root.author.id}
            root={root}
            scope={scope}
            replies={replies.get(root.id) ?? []}
            pending={inFlight.filter(({ parentId }) => parentId === root.id)}
            actorId={actorId}
            latest={latest}
            save={save}
          />
        ))}
        {inFlight
          .filter(({ parentId }) => parentId === null)
          .map((entry) => (
            <li key={entry.mutationId + actorId}>
              <PendingComment post={entry} />
            </li>
          ))}
      </ul>
      {latest.canPost && (
        <Composer
          label={anchor ? "Comment on selected passage" : "New comment"}
          submitLabel="Post comment"
          people={latest.people}
          intent={anchor ? JSON.stringify(anchor) : ""}
          onSubmit={async (draft, mutationId) => {
            await save(
              { ...draft, action: "post", parentId: null, anchor },
              mutationId,
            );
            if (anchor) onAnchoredPost?.();
          }}
        />
      )}
    </>
  );
}

function Thread({
  root,
  scope,
  replies,
  pending,
  actorId,
  latest,
  save,
}: {
  root: Comment;
  scope: CollaborationScope;
  replies: Comment[];
  pending: Post[];
  actorId: string;
  latest: CommentSnapshot;
  save: Save;
}) {
  const [replying, setReplying] = useState(false);
  const [resolutionError, setResolutionError] = useState("");
  const [busy, setBusy] = useState(false);
  const retry = useRef<{ version: number; mutationId: string }>(null);
  async function resolve() {
    setBusy(true);
    setResolutionError("");
    if (retry.current?.version !== root.version)
      retry.current = {
        version: root.version,
        mutationId: crypto.randomUUID(),
      };
    try {
      await save(
        {
          action: root.resolvedAt ? "reopen" : "resolve",
          commentId: root.id,
          expectedVersion: root.version,
        },
        retry.current.mutationId,
      );
    } catch (error) {
      setResolutionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="discussion-thread">
      <CommentEntry
        comment={root}
        scope={scope}
        edit={latest.canPost && root.author.id === actorId}
        people={latest.people}
        save={save}
      />
      {root.resolvedBy && (
        <p className="planning-help">Resolved by {root.resolvedBy.name}</p>
      )}
      {(replies.length > 0 || pending.length > 0) && (
        <ul className="discussion-list discussion-replies" aria-label="Replies">
          {replies.map((reply) => (
            <li key={reply.mutationId + reply.author.id}>
              <CommentEntry
                comment={reply}
                scope={scope}
                edit={latest.canPost && reply.author.id === actorId}
                people={latest.people}
                save={save}
              />
            </li>
          ))}
          {pending.map((entry) => (
            <li key={entry.mutationId + actorId}>
              <PendingComment post={entry} />
            </li>
          ))}
        </ul>
      )}
      <div className="discussion-actions">
        {latest.canPost && !root.resolvedAt && !replying && (
          <Button variant="quiet" onClick={() => setReplying(true)}>
            Reply
          </Button>
        )}
        {latest.canPost &&
          (latest.canModerate || root.author.id === actorId) && (
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => void resolve()}
            >
              {root.resolvedAt ? "Reopen thread" : "Resolve thread"}
            </Button>
          )}
      </div>
      {resolutionError && (
        <p className="planning-error" role="alert">
          {resolutionError}
        </p>
      )}
      {replying && latest.canPost && !root.resolvedAt && (
        <Composer
          label="Reply to thread"
          submitLabel="Post reply"
          people={latest.people}
          onCancel={() => setReplying(false)}
          onSubmit={async (draft, mutationId) => {
            await save(
              { ...draft, action: "post", parentId: root.id },
              mutationId,
            );
            setReplying(false);
          }}
        />
      )}
    </li>
  );
}

function PendingComment({ post }: { post: Post }) {
  return (
    <div className="discussion-entry">
      <p>{post.body}</p>
      <p className="planning-help" role="status">
        Sending…
      </p>
    </div>
  );
}

function CommentEntry({
  comment,
  scope,
  edit,
  people,
  save,
}: {
  comment: Comment;
  scope: CollaborationScope;
  edit: boolean;
  people: Comment["mentions"];
  save: Save;
}) {
  const [editing, setEditing] = useState<number>();
  return (
    <article className="discussion-entry">
      <header>
        <strong>{comment.author.name}</strong>
        <span className="planning-help">
          <time dateTime={comment.createdAt}>
            {new Date(comment.createdAt).toLocaleString()}
          </time>
          {comment.editedAt && " · Edited"}
        </span>
      </header>
      {comment.anchor && scope.subject.kind === "document" && (
        <Link
          to={citationPath(scope.workspaceId, {
            kind: "document",
            projectId: scope.projectId,
            id: scope.subject.id,
            anchor: comment.anchor,
          })}
        >
          Passage from revision {comment.anchor.revision}
        </Link>
      )}
      <p className="discussion-body">{comment.body}</p>
      <Link
        to={citationPath(scope.workspaceId, {
          kind: "comment",
          projectId: scope.projectId,
          id: comment.id,
        })}
      >
        Comment citation
      </Link>
      {comment.mentions.length > 0 && (
        <p className="discussion-mentions">
          Mentions {comment.mentions.map(({ name }) => `@${name}`).join(", ")}
        </p>
      )}
      {edit &&
        (editing === undefined ? (
          <Button variant="quiet" onClick={() => setEditing(comment.version)}>
            Edit comment
          </Button>
        ) : (
          <>
            {editing !== comment.version && (
              <div className="discussion-actions">
                <p className="planning-help">A newer version is shown above.</p>
                <Button
                  variant="secondary"
                  onClick={() => setEditing(comment.version)}
                >
                  Use latest version
                </Button>
              </div>
            )}
            <Composer
              label="Edit comment"
              submitLabel="Save comment"
              people={people}
              initial={{
                body: comment.body,
                mentionIds: comment.mentions.map(({ id }) => id),
              }}
              disabled={editing !== comment.version}
              onCancel={() => setEditing(undefined)}
              onSubmit={async (draft, mutationId) => {
                await save(
                  {
                    ...draft,
                    action: "edit",
                    commentId: comment.id,
                    expectedVersion: editing,
                  },
                  mutationId,
                );
                setEditing(undefined);
              }}
            />
          </>
        ))}
    </article>
  );
}

function Composer({
  label,
  submitLabel,
  people,
  onSubmit,
  onCancel,
  initial,
  disabled,
  intent,
}: {
  label: string;
  submitLabel: string;
  people: Comment["mentions"];
  onSubmit: (draft: Draft, mutationId: string) => Promise<void>;
  onCancel?: () => void;
  initial?: Draft;
  disabled?: boolean;
  intent?: string;
}) {
  const [draft, setDraft] = useState<Draft>(
    initial ?? { body: "", mentionIds: [] },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const retry = useRef<{ signature: string; mutationId: string }>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.body.trim() || busy || disabled) return;
    setBusy(true);
    setError("");
    setNotice("");
    const signature = JSON.stringify([draft, intent]);
    if (retry.current?.signature !== signature)
      retry.current = { signature, mutationId: crypto.randomUUID() };
    try {
      await onSubmit(draft, retry.current.mutationId);
      retry.current = null;
      setDraft({ body: "", mentionIds: [] });
      setNotice(
        submitLabel === "Save comment" ? "Comment saved." : "Comment posted.",
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409)
        retry.current = null;
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="discussion-composer planning-form"
      onSubmit={(event) => void submit(event)}
    >
      <label>
        {label}
        <textarea
          rows={3}
          maxLength={4000}
          value={draft.body}
          readOnly={busy}
          required
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
        />
      </label>
      {people.length > 0 && (
        <label className="discussion-mention-picker">
          Mention a teammate
          <select
            value=""
            disabled={busy || draft.mentionIds.length >= 20}
            onChange={(event) =>
              setDraft({
                ...draft,
                mentionIds: [...draft.mentionIds, event.target.value],
              })
            }
          >
            <option value="" disabled>
              Choose a person
            </option>
            {people
              .filter(({ id }) => !draft.mentionIds.includes(id))
              .map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </select>
        </label>
      )}
      {draft.mentionIds.length > 0 && (
        <div className="discussion-actions">
          {draft.mentionIds.map((id) => {
            const name =
              people.find((person) => person.id === id)?.name ??
              "Unavailable teammate";
            return (
              <Button
                key={id}
                aria-label={`Remove mention of ${name}`}
                variant="quiet"
                disabled={busy}
                onClick={() =>
                  setDraft({
                    ...draft,
                    mentionIds: draft.mentionIds.filter(
                      (entry) => entry !== id,
                    ),
                  })
                }
              >
                @{name} ×
              </Button>
            );
          })}
        </div>
      )}
      <div className="discussion-actions">
        <Button type="submit" disabled={disabled || busy || !draft.body.trim()}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <p className="planning-error" role="alert">
          {error}
        </p>
      )}
      <div className="sr-only" role="status">
        {notice}
      </div>
    </form>
  );
}
