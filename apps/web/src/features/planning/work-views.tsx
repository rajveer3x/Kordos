import {
  workKindSchema,
  workPageSchema,
  workStatusSchema,
  type WorkItem,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useRef, type RefObject } from "react";
import { Link, Outlet, useLocation, useSearchParams } from "react-router";
import {
  AsyncState,
  Button,
  PageHeading,
  StatusLabel,
} from "../../components/ui";
import { denied, read } from "../identity/api";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import {
  planningRefresh,
  useLiveProject,
  usePlanning,
  type LiveProjectContext,
} from "./planning-client";
import { workLabels } from "./work-editor";

export type WorkOutlet = LiveProjectContext & {
  workUrl: string;
  opener: RefObject<HTMLElement | undefined>;
};

function TaskLink({
  item,
  path,
  showProject = false,
  onOpen,
}: {
  item: WorkItem;
  path: string;
  showProject?: boolean;
  onOpen?: (opener: HTMLElement) => void;
}) {
  return (
    <li className="planning-task">
      <Link to={path} onClick={(event) => onOpen?.(event.currentTarget)}>
        <span className="planning-item-copy">
          <strong>{item.title}</strong>
          <span>
            {showProject && `${item.projectName} · `}
            {item.kind === "milestone" ? "Milestone" : "Task"}
            {item.owner && ` · ${item.owner.name}`}
          </span>
          {(item.commitment || item.deadline) && (
            <span>
              {item.commitment ? "Committed " : "Due "}
              <time dateTime={item.commitment ?? item.deadline ?? ""}>
                {item.commitment ?? item.deadline}
              </time>
            </span>
          )}
        </span>
        <span className="planning-statuses">
          <StatusLabel tone={item.status === "done" ? "confirmed" : "neutral"}>
            {workLabels[item.status]}
          </StatusLabel>
          {item.blockerReason && !item.blockerResolution && (
            <StatusLabel tone="risk">Blocked</StatusLabel>
          )}
        </span>
        <ArrowRight size={17} aria-hidden="true" />
      </Link>
    </li>
  );
}

function PageButtons({
  cursor,
  nextCursor,
  onPage,
}: {
  cursor: string | null;
  nextCursor: string | null;
  onPage: (cursor: string) => void;
}) {
  return (
    <div className="planning-actions">
      {cursor && (
        <Button variant="secondary" onClick={() => onPage("")}>
          First page
        </Button>
      )}
      {nextCursor && (
        <Button variant="secondary" onClick={() => onPage(nextCursor)}>
          Next page
        </Button>
      )}
    </div>
  );
}

export function AssignedWork() {
  const { key, api, workspace } = usePlanning();
  const [params, setParams] = useSearchParams();
  const cursor = params.get("cursor");
  const query = useQuery({
    queryKey: [...key, "assigned", cursor],
    queryFn: ({ signal }) =>
      read(
        cursor
          ? `${api}/assigned-work?cursor=${encodeURIComponent(cursor)}`
          : `${api}/assigned-work`,
        workPageSchema,
        signal,
      ),
    ...planningRefresh,
  });

  return (
    <div className="standard-page">
      <title>Home · Kordos</title>
      <PageHeading title="Home" />
      <section
        className="planning-panel glass-panel"
        aria-labelledby="assigned-title"
      >
        <h2 id="assigned-title">Assigned to you</h2>
        {query.isPending ? (
          <AsyncState kind="loading" message="Loading assigned work…" />
        ) : query.isError ? (
          <AsyncState
            kind="error"
            message="Could not load assigned work."
            retry={() => void query.refetch()}
          />
        ) : (
          <>
            {query.data.items.length ? (
              <ul className="planning-tasks">
                {query.data.items.map((item) => (
                  <TaskLink
                    key={item.id}
                    item={item}
                    showProject
                    path={workspacePath(
                      `${projectPath(item.projectId, "work")}/${item.id}`,
                      workspace.id,
                    )}
                  />
                ))}
              </ul>
            ) : (
              <p className="planning-help">
                You have no open work assigned to you.
              </p>
            )}
            <PageButtons
              cursor={cursor}
              nextCursor={query.data.nextCursor}
              onPage={(value) => setParams(value ? { cursor: value } : {})}
            />
          </>
        )}
      </section>
    </div>
  );
}

export function WorkViews() {
  const { pathname } = useLocation();
  const scope = useLiveProject();
  const { details } = scope;
  const { key, api, workspace } = usePlanning();
  const [params, setParams] = useSearchParams();
  const opener = useRef<HTMLElement | undefined>(undefined);
  const workUrl = workspacePath(projectPath(details.id, "work"), workspace.id);
  const board = params.get("view") === "board";
  const q = (params.get("q") ?? "").slice(0, 180);
  const status = workStatusSchema.safeParse(params.get("status")).data;
  const kind = workKindSchema.safeParse(params.get("kind")).data;
  const archived = params.get("archived") === "true";
  const cursor = params.get("cursor");
  const search = params.toString();
  const filters = new URLSearchParams();
  if (q.trim()) filters.set("q", q.trim());
  if (status) filters.set("status", status);
  if (kind) filters.set("kind", kind);
  if (archived) filters.set("archived", "true");
  if (cursor) filters.set("cursor", cursor);

  const query = useQuery({
    queryKey: [...key, "project", details.id, "work", filters.toString()],
    queryFn: ({ signal }) =>
      read(
        `${api}/projects/${details.id}/work?${filters}`,
        workPageSchema,
        signal,
      ),
    ...planningRefresh,
  });
  function updateFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (name !== "cursor" && name !== "view") next.delete("cursor");
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: name === "q" });
  }

  function workItems(items: WorkItem[]) {
    return (
      <ul className="planning-tasks">
        {items.map((item) => (
          <TaskLink
            key={item.id}
            item={item}
            path={`${workUrl}/${item.id}${search ? `?${search}` : ""}`}
            onOpen={(link) => {
              opener.current = link;
            }}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className="planning-work" aria-labelledby="work-title">
      {pathname.replace(/\/$/, "") === workUrl && (
        <title>{`Work · ${details.name} · Kordos`}</title>
      )}
      <div className="planning-heading">
        <h2 id="work-title">Work</h2>
        <div className="planning-actions" role="group" aria-label="Work view">
          <Button
            variant="secondary"
            aria-pressed={!board}
            onClick={() => updateFilter("view", "")}
          >
            List
          </Button>
          <Button
            variant="secondary"
            aria-pressed={board}
            onClick={() => updateFilter("view", "board")}
          >
            Board
          </Button>
        </div>
      </div>
      <div className="planning-filters">
        <label>
          Find work
          <input
            type="search"
            maxLength={180}
            value={q}
            onChange={(event) => updateFilter("q", event.target.value)}
          />
        </label>
        <label>
          Status
          <select
            value={status ?? ""}
            onChange={(event) => updateFilter("status", event.target.value)}
          >
            <option value="">Any status</option>
            {Object.entries(workLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select
            value={kind ?? ""}
            onChange={(event) => updateFilter("kind", event.target.value)}
          >
            <option value="">Any type</option>
            <option value="task">Tasks</option>
            <option value="milestone">Milestones</option>
          </select>
        </label>
        <label>
          Archive state
          <select
            value={archived ? "true" : ""}
            onChange={(event) => updateFilter("archived", event.target.value)}
          >
            <option value="">Unarchived</option>
            <option value="true">Archived</option>
          </select>
        </label>
      </div>
      {query.isPending ? (
        <AsyncState kind="loading" message="Loading work…" />
      ) : query.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(query.error)
              ? "Project work is unavailable."
              : "Could not load project work."
          }
          retry={denied(query.error) ? undefined : () => void query.refetch()}
        />
      ) : (
        <>
          {!query.data.items.length && (
            <p className="empty-message" role="status">
              {q || status || kind
                ? "No work matches these filters."
                : archived
                  ? "No archived work items."
                  : "There are no work items yet."}
            </p>
          )}
          {board ? (
            <div
              className="planning-board"
              role="region"
              aria-label="Work board"
            >
              {workStatusSchema.options
                .filter((column) => !status || column === status)
                .map((column) => {
                  const items = query.data.items.filter(
                    (item) => item.status === column,
                  );
                  return (
                    <section
                      key={column}
                      className="planning-board-column glass-panel"
                      aria-label={workLabels[column]}
                    >
                      <h3>{workLabels[column]}</h3>
                      {items.length ? (
                        workItems(items)
                      ) : (
                        <p className="planning-help">No items</p>
                      )}
                    </section>
                  );
                })}
            </div>
          ) : (
            workItems(query.data.items)
          )}
          <PageButtons
            cursor={cursor}
            nextCursor={query.data.nextCursor}
            onPage={(value) => updateFilter("cursor", value)}
          />
        </>
      )}
      <Outlet context={{ ...scope, workUrl, opener } satisfies WorkOutlet} />
    </section>
  );
}
