import {
  projectPeopleSchema,
  workHistorySchema,
  workItemSchema,
  type ProjectPeople,
  type WorkItem,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import { Sheet } from "../../components/sheet";
import { AsyncState, Button, StatusLabel } from "../../components/ui";
import { denied, read } from "../identity/api";
import {
  planningRefresh,
  usePlanning,
  usePlanningCommand,
} from "./planning-client";
import { WorkEditor, workLabels } from "./work-editor";
import type { WorkOutlet } from "./work-views";

export function WorkInspector({ create = false }: { create?: boolean }) {
  const { workId } = useParams();
  const { details, workUrl, opener } = useOutletContext<WorkOutlet>();
  const { api, key } = usePlanning();
  const { search } = useLocation();
  const navigate = useNavigate();
  const path = `${api}/projects/${details.id}/work`;
  const canEdit = details.role !== "viewer" && !details.archived;
  const item = useQuery({
    queryKey: [...key, "project", details.id, "work-item", workId],
    queryFn: ({ signal }) => read(`${path}/${workId}`, workItemSchema, signal),
    enabled: !create && !!workId,
    ...planningRefresh,
  });
  const people = useQuery({
    queryKey: [...key, "project", details.id, "people"],
    queryFn: ({ signal }) =>
      read(`${api}/projects/${details.id}/people`, projectPeopleSchema, signal),
    enabled: canEdit,
    ...planningRefresh,
  });
  const close = () => navigate(workUrl + search, { replace: true });
  const itemTitle = denied(item.error) ? undefined : item.data?.title;
  const title = create ? "Create work item" : (itemTitle ?? "Work item");
  return (
    <>
      <title>{`${title} · Kordos`}</title>
      <Sheet
        opener={opener.current}
        title={create ? "Create work item" : "Work item details"}
        onDismiss={close}
      >
        {(dismiss) =>
          create ? (
            canEdit ? (
              people.isPending ? (
                <AsyncState kind="loading" message="Loading owners…" />
              ) : !people.data || denied(people.error) ? (
                <AsyncState
                  kind="error"
                  message="Could not load owners."
                  retry={() => void people.refetch()}
                />
              ) : (
                <WorkEditor
                  key={details.id}
                  path={path}
                  owners={people.data.owners}
                  lead={details.role === "lead"}
                  canSave
                  onSaved={(id) =>
                    navigate(`${workUrl}/${id}${search}`, { replace: true })
                  }
                  onCancel={dismiss}
                />
              )
            ) : (
              <p className="sheet-message">
                Work creation is unavailable for this project.
              </p>
            )
          ) : item.isPending ? (
            <AsyncState kind="loading" message="Loading work item…" />
          ) : !item.data || denied(item.error) ? (
            <AsyncState
              kind="error"
              message={
                denied(item.error)
                  ? "This work item is unavailable."
                  : "Could not load this work item."
              }
              retry={denied(item.error) ? undefined : () => void item.refetch()}
            />
          ) : (
            <WorkDetails
              key={item.data.id}
              item={item.data}
              canEdit={canEdit}
              lead={details.role === "lead"}
              path={`${path}/${item.data.id}`}
              owners={people.data?.owners ?? []}
            />
          )
        }
      </Sheet>
    </>
  );
}

function WorkDetails({
  item,
  path,
  canEdit,
  lead,
  owners,
}: {
  item: WorkItem;
  path: string;
  canEdit: boolean;
  lead: boolean;
  owners: ProjectPeople["owners"];
}) {
  const [editing, setEditing] = useState<WorkItem>();
  const [notice, setNotice] = useState("");
  const command = usePlanningCommand();

  function lifecycle(
    action: "archive" | "restore" | "reopen",
    message: string,
  ) {
    setNotice("");
    void command.save(
      path,
      "PATCH",
      { action, expectedVersion: item.version },
      () => undefined,
      message,
    );
  }

  return (
    <div className="planning-inspector">
      <header>
        <p className="planning-help">
          {item.kind === "milestone" ? "Milestone" : "Task"} · Version{" "}
          {item.version}
        </p>
        <h3>{item.title}</h3>
        <div className="planning-statuses">
          <StatusLabel tone={item.status === "done" ? "confirmed" : "neutral"}>
            {workLabels[item.status]}
          </StatusLabel>
          {item.archived && <StatusLabel>Archived</StatusLabel>}
          {item.blockerReason && (
            <StatusLabel tone={item.blockerResolution ? "confirmed" : "risk"}>
              {item.blockerResolution ? "Blocker resolved" : "Blocked"}
            </StatusLabel>
          )}
        </div>
      </header>
      {editing && canEdit ? (
        <WorkEditor
          path={path}
          item={editing}
          owners={owners}
          lead={lead}
          canSave={!item.archived}
          onSaved={() => {
            setEditing(undefined);
            setNotice("Work item saved.");
          }}
          onCancel={() => setEditing(undefined)}
        />
      ) : (
        <>
          {item.description && (
            <p className="planning-description">{item.description}</p>
          )}
          <dl className="planning-facts">
            <div>
              <dt>Owner</dt>
              <dd>{item.owner?.name ?? "Unassigned"}</dd>
            </div>
            {item.estimateDays !== null && (
              <div>
                <dt>Estimate</dt>
                <dd>
                  {item.estimateDays} working{" "}
                  {item.estimateDays === 1 ? "day" : "days"}
                </dd>
              </div>
            )}
            {item.deadline && (
              <div>
                <dt>Deadline</dt>
                <dd>
                  <time dateTime={item.deadline}>{item.deadline}</time>
                </dd>
              </div>
            )}
            {item.commitment && (
              <div>
                <dt>Committed date</dt>
                <dd>
                  <time dateTime={item.commitment}>{item.commitment}</time>
                </dd>
              </div>
            )}
            {item.blockerReason && (
              <div>
                <dt>Blocker reason</dt>
                <dd>{item.blockerReason}</dd>
              </div>
            )}
            {item.blockerOwner && (
              <div>
                <dt>Blocker owner</dt>
                <dd>{item.blockerOwner.name}</dd>
              </div>
            )}
            {item.blockerResolution && (
              <div>
                <dt>Blocker resolution</dt>
                <dd>{item.blockerResolution}</dd>
              </div>
            )}
          </dl>
          {canEdit && (
            <div className="planning-actions">
              {!item.archived && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setNotice("");
                      setEditing(item);
                    }}
                  >
                    Edit {item.kind}
                  </Button>
                  {item.status === "done" && (
                    <Button
                      variant="secondary"
                      disabled={command.busy}
                      onClick={() => lifecycle("reopen", "Work item reopened.")}
                    >
                      Reopen {item.kind}
                    </Button>
                  )}
                </>
              )}
              {item.archived ? (
                <Button
                  variant="secondary"
                  disabled={command.busy}
                  onClick={() => lifecycle("restore", "Work item restored.")}
                >
                  Restore {item.kind}
                </Button>
              ) : (
                <Button
                  variant="quiet"
                  disabled={command.busy}
                  onClick={() => lifecycle("archive", "Work item archived.")}
                >
                  Archive {item.kind}
                </Button>
              )}
            </div>
          )}
          {command.error && (
            <p role="alert" className="planning-error">
              {command.error.message}
            </p>
          )}
          <p className="planning-notice" role="status">
            {notice || command.notice}
          </p>
        </>
      )}
      <WorkHistory path={path} item={item} />
    </div>
  );
}

const historyLabels = {
  "work.created": "Created",
  "work.edited": "Edited",
  "work.completed": "Completed",
  "work.reopened": "Reopened",
  "work.archived": "Archived",
  "work.restored": "Restored",
} as const;

function WorkHistory({ path, item }: { path: string; item: WorkItem }) {
  const { key } = usePlanning();
  const [cursor, setCursor] = useState("");
  const history = useQuery({
    queryKey: [
      ...key,
      "project",
      item.projectId,
      "history",
      item.id,
      item.version,
      cursor,
    ],
    queryFn: ({ signal }) =>
      read(
        cursor
          ? `${path}/history?cursor=${encodeURIComponent(cursor)}`
          : `${path}/history`,
        workHistorySchema,
        signal,
      ),
    ...planningRefresh,
  });
  return (
    <section className="planning-history">
      <h4>History</h4>
      {history.isPending ? (
        <AsyncState kind="loading" message="Loading history…" />
      ) : history.isError ? (
        <AsyncState
          kind="error"
          message="Could not load history."
          retry={() => void history.refetch()}
        />
      ) : (
        <>
          {history.data.items.length ? (
            <ol>
              {history.data.items.map(
                ({ id, action, actor, occurredAt, before, after }) => (
                  <li key={id}>
                    <strong>{historyLabels[action]}</strong> by {actor.name}
                    <span className="planning-help">
                      {" "}
                      ·{" "}
                      <time dateTime={occurredAt}>
                        {new Date(occurredAt).toLocaleString()}
                      </time>
                    </span>
                    <p>
                      {before ? `${workLabels[before.status]} → ` : ""}
                      {workLabels[after.status]} · Version {after.version}
                    </p>
                    {before && before.title !== after.title && (
                      <p>
                        {before.title} → {after.title}
                      </p>
                    )}
                  </li>
                ),
              )}
            </ol>
          ) : (
            <p className="planning-help">No revisions have been recorded.</p>
          )}
          <div className="planning-actions">
            {cursor && (
              <Button variant="quiet" onClick={() => setCursor("")}>
                Latest history
              </Button>
            )}
            {history.data.nextCursor && (
              <Button
                variant="quiet"
                onClick={() => setCursor(history.data.nextCursor ?? "")}
              >
                Older history
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
