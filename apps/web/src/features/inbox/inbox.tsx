import {
  inboxEntrySchema,
  inboxFilterSchema,
  inboxHomeSchema,
  inboxPageSchema,
  inboxReasonSchema,
  type InboxEntry,
  type InboxReason,
} from "@kordos/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import {
  AsyncState,
  Button,
  PageHeading,
  StatusLabel,
} from "../../components/ui";
import { denied, errorMessage, read, request } from "../identity/api";
import { citationPath } from "../knowledge/knowledge-client";
import { planningRefresh, usePlanning } from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import "./inbox.css";

export const notificationLabels: Record<InboxReason, string> = {
  assignment: "Assignment",
  mention: "Mention",
  review: "Review request",
  risk: "Schedule risk",
  due: "Due soon",
  overdue: "Overdue",
  escalation: "Overdue escalation",
};

type Target = Pick<
  InboxEntry,
  "projectId" | "subjectId" | "title" | "projectName" | "deadline"
>;

function destination(
  workspace: string,
  entry: Target,
  reason: InboxReason,
  revision?: number,
) {
  const project = projectPath(entry.projectId);
  switch (reason) {
    case "mention":
      return citationPath(workspace, {
        kind: "comment",
        projectId: entry.projectId,
        id: entry.subjectId,
      });
    case "review":
      return workspacePath(
        `/reviews/${entry.subjectId}${revision ? `?revision=${revision}` : ""}`,
        workspace,
      );
    case "risk":
      return workspacePath(`${project}/risks/${entry.subjectId}`, workspace);
    default:
      return workspacePath(`${project}/work/${entry.subjectId}`, workspace);
  }
}

function Notification({ entry }: { entry: InboxEntry }) {
  const { workspace, key, api } = usePlanning();
  const client = useQueryClient();
  const update = useMutation({
    mutationFn: (read: boolean) =>
      request(`${api}/inbox/${entry.id}`, {
        method: "PATCH",
        body: { read },
        schema: inboxEntrySchema,
      }),
    onSuccess: async (entry) => {
      if (entry)
        client.setQueryData([...key, "inbox", "entry", entry.id], entry);
      await client.invalidateQueries({ queryKey: [...key, "inbox"] });
    },
  });
  return (
    <div className="inbox-entry">
      <div className="planning-item-copy">
        <span className="inbox-meta">
          {notificationLabels[entry.reason]} ·{" "}
          <time dateTime={entry.receivedAt}>
            {new Date(entry.receivedAt).toLocaleString()}
          </time>
        </span>
        <Link
          to={destination(workspace.id, entry, entry.reason, entry.revision)}
        >
          {entry.title}
        </Link>
        <span>
          {entry.projectName}
          {entry.deadline && (
            <>
              {" "}
              · Due <time dateTime={entry.deadline}>{entry.deadline}</time>
            </>
          )}
        </span>
        {update.isError && (
          <span role="alert">{errorMessage(update.error)}</span>
        )}
      </div>
      <div className="planning-actions">
        {entry.resolved && <StatusLabel tone="neutral">Resolved</StatusLabel>}
        {!entry.resolved && !entry.readAt && (
          <StatusLabel tone="neutral">Unread</StatusLabel>
        )}
        <Button
          variant="quiet"
          disabled={update.isPending}
          onClick={() => update.mutate(!entry.readAt)}
          aria-label={`${entry.readAt ? "Mark unread" : "Mark read"} ${notificationLabels[entry.reason]} · ${entry.title}`}
        >
          {entry.readAt ? "Mark unread" : "Mark read"}
        </Button>
      </div>
    </div>
  );
}

function InboxError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <AsyncState
      kind="error"
      message={
        denied(error)
          ? "This inbox item is unavailable."
          : "Could not load notifications."
      }
      retry={denied(error) ? undefined : retry}
    />
  );
}

export function InboxPage() {
  const { api, key, workspace } = usePlanning();
  const [search, setSearch] = useSearchParams();
  const result = inboxFilterSchema.safeParse(Object.fromEntries(search));
  const filter = result.success ? result.data : {};
  const queryString = new URLSearchParams(filter).toString();
  const inbox = useQuery({
    queryKey: [...key, "inbox", "list", queryString],
    queryFn: ({ signal }) =>
      read(`${api}/inbox?${queryString}`, inboxPageSchema, signal),
    ...planningRefresh,
    refetchInterval: 2000,
  });
  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(filter);
    next.delete("cursor");
    if (value) next.set(name, value);
    else next.delete(name);
    setSearch(next);
  }

  return (
    <div className="standard-page">
      <title>Inbox · Kordos</title>
      <PageHeading
        title={filter.digest ? "Daily digest" : "Inbox"}
        description={
          filter.digest ??
          (inbox.data
            ? `${inbox.data.unreadCount} unread across inbox`
            : undefined)
        }
      />
      <section
        className="planning-panel glass-panel"
        aria-label="Notifications"
      >
        <div className="inbox-filters">
          <label>
            Notification type
            <select
              value={filter.reason ?? ""}
              onChange={(event) => setFilter("reason", event.target.value)}
            >
              <option value="">All types</option>
              {inboxReasonSchema.options.map((reason) => (
                <option key={reason} value={reason}>
                  {notificationLabels[reason]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Read state
            <select
              value={filter.state ?? ""}
              onChange={(event) => setFilter("state", event.target.value)}
            >
              <option value="">All notifications</option>
              <option value="unread">Unread</option>
              <option value="read">Read</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
          <Link
            to={workspacePath(
              filter.digest ? "/inbox" : "/settings#notifications",
              workspace.id,
            )}
          >
            {filter.digest ? "All inbox items" : "Notification settings"}
          </Link>
        </div>
        {inbox.isPending ? (
          <AsyncState kind="loading" message="Loading notifications…" />
        ) : inbox.isError ? (
          <InboxError error={inbox.error} retry={() => void inbox.refetch()} />
        ) : inbox.data.items.length ? (
          <ul className="inbox-list">
            {inbox.data.items.map((entry) => (
              <li key={entry.id}>
                <Notification entry={entry} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="planning-help">No notifications match this view.</p>
        )}
        {(filter.cursor || inbox.data?.nextCursor) && (
          <div className="planning-actions">
            {filter.cursor && (
              <Button
                variant="secondary"
                onClick={() => setFilter("cursor", "")}
              >
                First page
              </Button>
            )}
            {inbox.data?.nextCursor && (
              <Button
                variant="secondary"
                onClick={() => setFilter("cursor", inbox.data.nextCursor ?? "")}
              >
                Next page
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export function InboxEntryPage() {
  const { entryId } = useParams();
  const { api, key, workspace } = usePlanning();
  const entry = useQuery({
    queryKey: [...key, "inbox", "entry", entryId],
    queryFn: ({ signal }) =>
      read(`${api}/inbox/${entryId}`, inboxEntrySchema, signal),
    ...planningRefresh,
    refetchInterval: 2000,
  });
  return (
    <div className="standard-page">
      <title>Notification · Kordos</title>
      <Link to={workspacePath("/inbox", workspace.id)}>All notifications</Link>
      <PageHeading title="Notification" />
      <section className="planning-panel glass-panel">
        {entry.isPending ? (
          <AsyncState kind="loading" message="Loading notification…" />
        ) : entry.isError ? (
          <InboxError error={entry.error} retry={() => void entry.refetch()} />
        ) : (
          <Notification entry={entry.data} />
        )}
      </section>
    </div>
  );
}

function HomeList({
  items,
  reason,
  empty,
  workspace,
}: {
  items: (Target & {
    milestone?: string | null;
    revision?: number;
    receivedAt?: string;
    severity?: "at_risk" | "watch";
  })[];
  reason: InboxReason;
  empty: string;
  workspace: string;
}) {
  if (!items.length) return <p className="planning-help">{empty}</p>;
  return (
    <ul className="inbox-list">
      {items.map((entry) => (
        <li key={entry.subjectId} className="planning-item-copy">
          <Link to={destination(workspace, entry, reason, entry.revision)}>
            {entry.title}
          </Link>
          {entry.severity && (
            <StatusLabel
              tone={entry.severity === "at_risk" ? "risk" : "neutral"}
            >
              {entry.severity === "at_risk" ? "At risk" : "Watch"}
            </StatusLabel>
          )}
          <span>
            {entry.projectName}
            {entry.receivedAt && (
              <>
                {" · "}
                <time dateTime={entry.receivedAt}>
                  {new Date(entry.receivedAt).toLocaleString()}
                </time>
              </>
            )}
            {entry.milestone &&
              entry.milestone !== entry.title &&
              ` · ${entry.milestone}`}
            {entry.deadline && (
              <>
                {" "}
                · <time dateTime={entry.deadline}>{entry.deadline}</time>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function HomePriorities({
  projectId,
  showReviews,
}: { projectId?: string; showReviews?: boolean } = {}) {
  const { api, key, workspace } = usePlanning();
  const [params, setParams] = useSearchParams();
  const sort = params.get("reviewSort") === "milestone" ? "milestone" : "age";
  const home = useQuery({
    queryKey: [...key, "home", projectId, sort],
    queryFn: ({ signal }) =>
      read(
        `${api}/home?${new URLSearchParams({ sort, ...(projectId ? { projectId } : {}) })}`,
        inboxHomeSchema,
        signal,
      ),
    ...planningRefresh,
  });
  if (home.isPending)
    return <AsyncState kind="loading" message="Loading priorities…" />;
  if (home.isError)
    return <InboxError error={home.error} retry={() => void home.refetch()} />;
  return (
    <div className="inbox-home">
      <section
        className="glass-panel planning-panel"
        aria-labelledby="home-decisions"
      >
        <h2 id="home-decisions">Decisions</h2>
        {home.data.decisions.length ? (
          <ul className="inbox-list">
            {home.data.decisions.map((decision) => (
              <li key={decision.id} className="planning-item-copy">
                <Link
                  to={workspacePath(
                    `${projectPath(decision.projectId)}/documents/decisions/${decision.id}`,
                    workspace.id,
                  )}
                >
                  {decision.question}
                </Link>
                <span>
                  {decision.confirmedAt ? "Confirmed" : "Needs confirmation"} ·{" "}
                  {decision.accountable.name}
                </span>
                <span>
                  {decision.projectName} · Effective{" "}
                  <time dateTime={decision.effectiveDate}>
                    {decision.effectiveDate}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="planning-help">No decisions need your attention.</p>
        )}
      </section>
      {(showReviews ?? workspace.role !== "viewer") && (
        <section
          className="glass-panel planning-panel"
          aria-labelledby="home-reviews"
        >
          <h2 id="home-reviews">Pending reviews ({home.data.pendingCount})</h2>
          {home.data.pendingCount > 1 && (
            <label className="inbox-review-sort">
              Sort pending reviews
              <select
                value={sort}
                onChange={(event) => {
                  const next = new URLSearchParams(params);
                  if (event.target.value === "milestone")
                    next.set("reviewSort", "milestone");
                  else next.delete("reviewSort");
                  setParams(next);
                }}
              >
                <option value="age">Oldest first</option>
                <option value="milestone">Affected milestone</option>
              </select>
            </label>
          )}
          <HomeList
            items={home.data.reviews}
            reason="review"
            workspace={workspace.id}
            empty="You have no reviews waiting for you."
          />
          {home.data.pendingCount > 5 && (
            <Link to={workspacePath("/reviews?status=pending", workspace.id)}>
              Open review queue
            </Link>
          )}
        </section>
      )}
      {!projectId && (
        <section
          className="glass-panel planning-panel"
          aria-labelledby="home-risks"
        >
          <h2 id="home-risks">Open risks</h2>
          <HomeList
            items={home.data.risks}
            reason="risk"
            workspace={workspace.id}
            empty="No open risks in your projects."
          />
        </section>
      )}
      <section
        className="glass-panel planning-panel"
        aria-labelledby="home-due"
      >
        <h2 id="home-due">Due work</h2>
        <HomeList
          items={home.data.due}
          reason="due"
          workspace={workspace.id}
          empty="You have no work due in the next seven days."
        />
      </section>
      <section
        className="glass-panel planning-panel"
        aria-labelledby="home-mentions"
      >
        <h2 id="home-mentions">Unread mentions</h2>
        <HomeList
          items={home.data.mentions}
          reason="mention"
          workspace={workspace.id}
          empty="You have no unread mentions."
        />
      </section>
    </div>
  );
}
