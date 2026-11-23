import {
  briefJobSchema,
  briefListSchema,
  briefPlanSchema,
  pasteBriefSchema,
  idSchema,
  projectPeopleSchema,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  AsyncState,
  Button,
  PageHeading,
  StatusLabel,
} from "../../components/ui";
import { denied, read } from "../identity/api";
import { EvidencePassage } from "../knowledge/evidence-passage";
import {
  planningRefresh,
  useLiveProject,
  usePlanning,
  usePlanningCommand,
} from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import { PlanEditor } from "./plan";

const jobLabel = {
  queued: "Queued",
  running: "Extracting tasks",
  ready: "Candidates ready",
  failed: "Extraction failed",
};
const failures = {
  timeout: "The model timed out. The brief is saved.",
  provider_unavailable:
    "The model provider is unavailable. The brief is saved.",
  invalid_output:
    "The model did not return a valid plan with verifiable passages. The brief is saved.",
  access_changed: "Project access changed before extraction completed.",
  interrupted: "The extraction was interrupted. The brief is saved.",
};

export function BriefsPage() {
  const { details } = useLiveProject();
  const { workspace, api, key } = usePlanning();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const command = usePlanningCommand();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const path = `${api}/projects/${details.id}/briefs`;
  const base = workspacePath(projectPath(details.id), workspace.id) + "/briefs";
  const cursor = idSchema.safeParse(params.get("cursor")).data;
  const directory = useQuery({
    queryKey: [...key, "project", details.id, "briefs", cursor],
    queryFn: ({ signal }) =>
      read(path + (cursor ? `?cursor=${cursor}` : ""), briefListSchema, signal),
    ...planningRefresh,
  });
  return (
    <section className="glass-panel planning-panel brief-page">
      <title>Project briefs · Kordos</title>
      <PageHeading title="Project briefs" />
      {details.role !== "viewer" && !details.archived && (
        <form
          className="planning-form"
          onSubmit={(event) => {
            event.preventDefault();
            const result = pasteBriefSchema
              .omit({ mutationId: true })
              .safeParse({ title, content });
            if (!result.success) {
              command.invalid("Enter a title and brief text.");
              return;
            }
            void command.save(path, "POST", result.data, (id) =>
              navigate(`${base}/${id}`),
            );
          }}
        >
          <h2>Add a brief</h2>
          <p className="planning-help">
            Paste brief text or{" "}
            <Link to={base.replace(/briefs$/, "documents")}>
              choose a project document
            </Link>{" "}
            and open its revision.
          </p>
          <label>
            Brief title
            <input
              required
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Brief text
            <textarea
              required
              rows={7}
              maxLength={16000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={command.busy}>
            Extract a plan
          </Button>
          {command.error && (
            <p className="planning-error" role="alert">
              {command.error.message}
            </p>
          )}
        </form>
      )}
      <h2>Saved briefs</h2>
      {directory.isPending ? (
        <AsyncState kind="loading" message="Loading briefs…" />
      ) : directory.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(directory.error)
              ? "Briefs are unavailable."
              : "Could not load briefs."
          }
          retry={
            denied(directory.error) ? undefined : () => void directory.refetch()
          }
        />
      ) : directory.data.items.length ? (
        <ul className="review-list">
          {directory.data.items.map((item) => (
            <li key={item.id}>
              <Link to={`${base}/${item.id}`}>{item.title}</Link>
              <StatusLabel>{jobLabel[item.status]}</StatusLabel>
            </li>
          ))}
        </ul>
      ) : (
        <p className="planning-help">No briefs have been added.</p>
      )}
      <div className="planning-actions">
        {cursor && (
          <Button variant="quiet" onClick={() => setParams({})}>
            Back to latest
          </Button>
        )}
        {directory.data?.nextCursor && (
          <Button
            variant="quiet"
            onClick={() => setParams({ cursor: directory.data.nextCursor! })}
          >
            Older briefs
          </Button>
        )}
      </div>
    </section>
  );
}

export function BriefJobPage() {
  const { briefId } = useParams();
  const { details } = useLiveProject();
  const { api, key, workspace } = usePlanning();
  const navigate = useNavigate();
  const command = usePlanningCommand();
  const [manual, setManual] = useState(false);
  const project = `${api}/projects/${details.id}`;
  const path = `${project}/briefs/${briefId}`;
  const base = workspacePath(projectPath(details.id), workspace.id);
  const result = useQuery({
    queryKey: [...key, "project", details.id, "briefs", briefId],
    queryFn: ({ signal }) => read(path, briefJobSchema, signal),
    ...planningRefresh,
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.status ?? "")
        ? 1000
        : 5000,
  });
  const people = useQuery({
    queryKey: [...key, "project", details.id, "people"],
    queryFn: ({ signal }) =>
      read(project + "/people", projectPeopleSchema, signal),
    enabled: !!result.data?.canEdit && !result.data.proposalId,
    ...planningRefresh,
  });
  if (result.isPending)
    return <AsyncState kind="loading" message="Loading brief…" />;
  if (result.isError)
    return (
      <AsyncState
        kind="error"
        message={
          denied(result.error)
            ? "This brief is unavailable."
            : "Could not load this brief."
        }
        retry={denied(result.error) ? undefined : () => void result.refetch()}
      />
    );
  const brief = result.data;
  const review = (id: string) => workspacePath(`/reviews/${id}`, workspace.id);
  const chars = Array.from(brief.content);
  return (
    <section className="glass-panel planning-panel brief-page">
      <title>{brief.title} · Kordos</title>
      <Link to={`${base}/briefs`}>All project briefs</Link>
      <PageHeading title={brief.title} />
      <StatusLabel
        announce
        tone={
          brief.status === "failed"
            ? "risk"
            : brief.status === "ready"
              ? "confirmed"
              : "neutral"
        }
      >
        {jobLabel[brief.status]}
      </StatusLabel>
      <p className="planning-help">Extraction attempt {brief.attempt} of 3</p>
      <details
        className="brief-source"
        open={brief.status === "failed" || undefined}
      >
        <summary>Original brief</summary>
        <p className="planning-help">
          <time dateTime={brief.capturedAt}>
            {new Date(brief.capturedAt).toLocaleString(undefined, {
              timeZone: brief.timeZone,
            })}
          </time>{" "}
          · {brief.timeZone}
        </p>
        <p className="brief-source-text">{brief.content}</p>
        <Link
          to={`${base}/documents/${brief.documentId}/revisions/${brief.sourceRevision}`}
        >
          Open source document
        </Link>
      </details>
      {brief.failure && (
        <p className="planning-conflict" role="status">
          {failures[brief.failure]}
        </p>
      )}
      {brief.proposalId ? (
        <Link className="button button--primary" to={review(brief.proposalId)}>
          Open plan proposal
        </Link>
      ) : (
        brief.canEdit && (
          <>
            {!manual && brief.status === "failed" && brief.attempt < 3 && (
              <Button
                variant="secondary"
                disabled={command.busy}
                onClick={() =>
                  void command.save(
                    path + "/retry",
                    "POST",
                    { expectedVersion: brief.version },
                    () => {},
                    "Extraction requeued.",
                  )
                }
              >
                Retry extraction
              </Button>
            )}
            {!manual && !brief.candidates && (
              <Button
                variant="secondary"
                disabled={command.busy}
                onClick={() => setManual(true)}
              >
                Plan manually
              </Button>
            )}
            {(manual || brief.candidates) && (
              <>
                <h2>Plan candidates</h2>
                {people.isPending ? (
                  <AsyncState
                    kind="loading"
                    message="Loading eligible owners…"
                  />
                ) : people.isError ? (
                  <AsyncState
                    kind="error"
                    message="Could not load eligible owners."
                    retry={() => void people.refetch()}
                  />
                ) : (
                  <PlanEditor
                    initial={manual ? null : brief.candidates}
                    owners={people.data.owners}
                    busy={command.busy}
                    evidence={(task) =>
                      task.passages.map((anchor) => (
                        <EvidencePassage
                          key={`${anchor.start}:${anchor.end}`}
                          entry={{
                            source: {
                              kind: "document",
                              projectId: details.id,
                              id: brief.documentId,
                              anchor,
                            },
                            title: brief.title,
                            excerpt: chars
                              .slice(anchor.start, anchor.end)
                              .join(""),
                            capturedAt: brief.capturedAt,
                            author: brief.author,
                            newer: false,
                          }}
                        />
                      ))
                    }
                    onSave={(plan) => {
                      const validated = briefPlanSchema.safeParse(plan);
                      if (!validated.success) {
                        command.invalid(
                          "Check the task titles, dates and estimates.",
                        );
                        return;
                      }
                      void command.save(
                        project + "/plan-proposals",
                        "POST",
                        { briefId: brief.id, plan: validated.data },
                        (id) => navigate(review(id)),
                      );
                    }}
                  />
                )}
              </>
            )}
          </>
        )
      )}
      {command.error && (
        <p className="planning-error" role="alert">
          {command.error.message}
        </p>
      )}
      <p role="status" className="planning-notice">
        {command.notice}
      </p>
    </section>
  );
}
