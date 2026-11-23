import {
  createMeetingSchema,
  idSchema,
  meetingAudioExtensionSchema,
  meetingAudioMaxBytes,
  meetingDetailSchema,
  meetingItemValuesSchema,
  meetingPageSchema,
  projectPeopleSchema,
  type MeetingDetail,
  type MeetingSegment,
} from "@kordos/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  AsyncState,
  Button,
  PageHeading,
  StatusLabel,
} from "../../components/ui";
import { DiscussionPanel } from "../collaboration/discussion-panel";
import { denied, read } from "../identity/api";
import { citationPath } from "../knowledge/knowledge-client";
import {
  planningRefresh,
  useLiveProject,
  usePlanning,
  usePlanningCommand,
} from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import { recordingTime } from "./recording";
import "./meetings.css";

const statusLabel = {
  empty: "Needs a transcript",
  queued: "Queued",
  processing: "Processing transcript",
  ready: "Transcript ready",
  failed: "Processing failed",
};
const failures = {
  timeout: "Transcription timed out. Try again or paste a transcript.",
  provider_unavailable:
    "The transcription provider is unavailable. Try again or paste a transcript.",
  invalid_transcript:
    "The input could not be processed. Paste or correct the transcript.",
  media_unavailable:
    "The recording is unavailable. Paste a transcript to continue.",
  interrupted: "Processing was interrupted. Try again.",
  access_changed: "Project access changed during processing. A lead can retry.",
};

function useMeetingScope() {
  const { details } = useLiveProject();
  const { api, key, workspace } = usePlanning();
  const path = projectPath(details.id);
  return {
    base: workspacePath(path + "/meetings", workspace.id),
    endpoint: api + path + "/meetings",
    queryKey: [...key, "meetings", details.id],
    project: details,
    workspaceId: workspace.id,
  };
}

function MeetingFields({
  existing,
  busy,
  onSave,
  onCancel,
}: {
  existing?: MeetingDetail;
  busy: boolean;
  onSave: (input: {
    title: string;
    agenda: string | null;
    startsAt: string;
    retentionDays: number;
  }) => void;
  onCancel?: () => void;
}) {
  const now = new Date(existing?.startsAt ?? Date.now());
  const [starts, setStarts] = useState(
    new Date(now.valueOf() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16),
  );
  const [title, setTitle] = useState(existing?.title ?? "");
  const [agenda, setAgenda] = useState(existing?.agenda ?? "");
  const [retention, setRetention] = useState(existing?.retentionDays ?? 30);
  return (
    <form
      className="planning-form"
      onSubmit={(event) => {
        event.preventDefault();
        const date = new Date(starts);
        if (!isNaN(date.valueOf()))
          onSave({
            title,
            agenda: agenda.trim() || null,
            startsAt: date.toISOString(),
            retentionDays: retention,
          });
      }}
    >
      <label>
        Meeting title
        <input
          required
          maxLength={160}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        Agenda
        <textarea
          rows={3}
          maxLength={4000}
          value={agenda}
          onChange={(event) => setAgenda(event.target.value)}
        />
      </label>
      <div className="planning-form-grid">
        <label>
          Starts at (your local time)
          <input
            type="datetime-local"
            required
            value={starts}
            onChange={(event) => setStarts(event.target.value)}
          />
        </label>
        <label>
          Recording retention
          <select
            value={retention}
            onChange={(event) =>
              setRetention(Number(event.target.value) as typeof retention)
            }
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
      </div>
      <div className="planning-actions">
        <Button type="submit" disabled={busy || !title.trim()}>
          {existing ? "Save meeting details" : "Create meeting"}
        </Button>
        {onCancel && (
          <Button variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export function MeetingsPage() {
  const { base, endpoint, queryKey, project } = useMeetingScope();
  const [search, setSearch] = useSearchParams();
  const cursor = idSchema.safeParse(search.get("cursor")).data;
  const navigate = useNavigate();
  const command = usePlanningCommand();
  const [creating, setCreating] = useState(false);
  const result = useQuery({
    queryKey: [...queryKey, "directory", cursor],
    queryFn: ({ signal }) =>
      read(
        endpoint + (cursor ? `?cursor=${cursor}` : ""),
        meetingPageSchema,
        signal,
      ),
    ...planningRefresh,
  });
  return (
    <section className="glass-panel planning-panel meeting-panel">
      <title>Project meetings · Kordos</title>
      <div className="planning-heading">
        <PageHeading title="Meetings" />
        <Link to={base.replace(/meetings$/, "documents/decisions")}>
          Decision register
        </Link>
      </div>
      {project.role !== "viewer" &&
        !project.archived &&
        (creating ? (
          <MeetingFields
            busy={command.busy}
            onCancel={() => setCreating(false)}
            onSave={(values) => {
              const input = createMeetingSchema
                .omit({ mutationId: true })
                .safeParse(values);
              if (!input.success) {
                command.invalid(
                  "Enter the meeting title, start time and retention period.",
                );
                return;
              }
              void command.save(endpoint, "POST", input.data, (id) =>
                navigate(`${base}/${id}`),
              );
            }}
          />
        ) : (
          <div className="planning-actions">
            <Button onClick={() => setCreating(true)}>New meeting</Button>
          </div>
        ))}
      {command.error && (
        <p className="planning-error" role="alert">
          {command.error.message}
        </p>
      )}
      {result.isPending ? (
        <AsyncState kind="loading" message="Loading meetings…" />
      ) : result.isError ? (
        <AsyncState
          kind="error"
          message="Could not load meetings."
          retry={denied(result.error) ? undefined : () => void result.refetch()}
        />
      ) : result.data.items.length ? (
        <ul className="meeting-list">
          {result.data.items.map((meeting) => (
            <li key={meeting.id}>
              <div className="planning-item-copy">
                <Link to={`${base}/${meeting.id}`}>{meeting.title}</Link>
                <span>
                  {meeting.organizer.name} ·{" "}
                  <time dateTime={meeting.startsAt}>
                    {new Date(meeting.startsAt).toLocaleString()}
                  </time>
                </span>
              </div>
              <StatusLabel>{statusLabel[meeting.status]}</StatusLabel>
            </li>
          ))}
        </ul>
      ) : (
        <p className="planning-help">No meetings have been added.</p>
      )}
      <div className="planning-actions">
        {cursor && (
          <Button variant="quiet" onClick={() => setSearch({})}>
            Back to latest
          </Button>
        )}
        {result.data?.nextCursor && (
          <Button
            variant="quiet"
            onClick={() => setSearch({ cursor: result.data.nextCursor! })}
          >
            Older meetings
          </Button>
        )}
      </div>
    </section>
  );
}

export function MeetingPage() {
  const settings = useMeetingScope();
  const { meetingId } = useParams();
  const [search] = useSearchParams();
  const revision = search.get("revision");
  const endpoint = settings.endpoint + "/" + meetingId;
  const result = useQuery({
    queryKey: [...settings.queryKey, meetingId, revision],
    queryFn: ({ signal }) =>
      read(
        endpoint +
          (revision ? `?revision=${encodeURIComponent(revision)}` : ""),
        meetingDetailSchema,
        signal,
      ),
    ...planningRefresh,
    refetchInterval: (query) =>
      ["queued", "processing"].includes(query.state.data?.status ?? "")
        ? 1000
        : 5000,
  });
  if (result.isPending)
    return <AsyncState kind="loading" message="Loading meeting…" />;
  if (result.isError)
    return (
      <AsyncState
        kind="error"
        message={
          denied(result.error)
            ? "This meeting is unavailable."
            : "Could not load the meeting."
        }
        retry={denied(result.error) ? undefined : () => void result.refetch()}
      />
    );
  return (
    <MeetingContents
      key={`${meetingId}:${revision ?? ""}`}
      meeting={result.data}
      endpoint={endpoint}
      historical={!!revision}
    />
  );
}

function MeetingContents({
  meeting,
  endpoint,
  historical,
}: {
  meeting: MeetingDetail;
  endpoint: string;
  historical: boolean;
}) {
  const { base, project, workspaceId } = useMeetingScope();
  const command = usePlanningCommand();
  const [editing, setEditing] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [paste, setPaste] = useState("");
  const busy = meeting.status === "queued" || meeting.status === "processing";
  const head = `${base}/${meeting.id}`;
  const action = (fields: object, success = () => {}) =>
    void command.save(
      endpoint,
      "PATCH",
      { ...fields, expectedVersion: meeting.version },
      success,
    );
  return (
    <>
      <section className="glass-panel planning-panel meeting-panel">
        <title>{meeting.title} · Kordos</title>
        <Link to={base}>All meetings</Link>
        <PageHeading title={meeting.title} />
        <p className="planning-help">
          {meeting.organizer.name} ·{" "}
          <time dateTime={meeting.startsAt}>
            {new Date(meeting.startsAt).toLocaleString(undefined, {
              timeZone: meeting.timeZone,
            })}
          </time>{" "}
          · {meeting.timeZone}
        </p>
        {meeting.agenda && (
          <div className="meeting-section">
            <h2>Agenda</h2>
            <p className="meeting-transcript-text">{meeting.agenda}</p>
          </div>
        )}
        <div className="planning-actions">
          <StatusLabel
            announce
            tone={
              meeting.status === "failed"
                ? "risk"
                : meeting.status === "ready"
                  ? "confirmed"
                  : "neutral"
            }
          >
            {statusLabel[meeting.status]}
          </StatusLabel>
          {meeting.canManage && !busy && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit meeting
            </Button>
          )}
          {historical && <Link to={head}>Current transcript</Link>}
        </div>
        {editing && meeting.canManage && (
          <MeetingFields
            existing={meeting}
            busy={command.busy}
            onCancel={() => setEditing(false)}
            onSave={(fields) =>
              action({ ...fields, action: "edit" }, () => setEditing(false))
            }
          />
        )}
        {meeting.failure && (
          <p className="planning-conflict" role="status">
            {failures[meeting.failure]} Attempt {meeting.attempt} of 3.
          </p>
        )}
        {meeting.audio === "available" && meeting.expiresAt && (
          <p className="planning-help">
            Recording expires{" "}
            <time dateTime={meeting.expiresAt}>
              {new Date(meeting.expiresAt).toLocaleDateString()}
            </time>
            .
          </p>
        )}
        {meeting.audio === "unavailable" && (
          <p className="planning-help">
            Recording unavailable. Saved transcript excerpts and approved items
            are available below.
          </p>
        )}
        {!historical && meeting.canManage && (
          <div className="meeting-section">
            {(meeting.audio === "available" || meeting.audio === "pending") && (
              <div className="planning-actions">
                {confirmRemoval ? (
                  <>
                    <span>Remove the private recording permanently?</span>
                    <Button
                      variant="secondary"
                      disabled={command.busy}
                      onClick={() =>
                        action({ action: "remove-audio" }, () =>
                          setConfirmRemoval(false),
                        )
                      }
                    >
                      Confirm removal
                    </Button>
                    <Button
                      variant="quiet"
                      onClick={() => setConfirmRemoval(false)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="quiet"
                    onClick={() => setConfirmRemoval(true)}
                  >
                    Remove recording
                  </Button>
                )}
              </div>
            )}
            {!busy &&
              meeting.status === "failed" &&
              meeting.attempt < 3 &&
              meeting.failure !== "media_unavailable" && (
                <div className="planning-actions">
                  <Button
                    variant="secondary"
                    disabled={command.busy}
                    onClick={() => action({ action: "retry" })}
                  >
                    Retry processing
                  </Button>
                </div>
              )}
            {!busy && meeting.revision === 0 && (
              <div className="meeting-section">
                {(meeting.audio === "none" ||
                  meeting.audio === "pending" ||
                  meeting.audio === "unavailable") && (
                  <RecordingUpload endpoint={endpoint} meeting={meeting} />
                )}
                <form
                  className="planning-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    action({ action: "paste", content: paste }, () =>
                      setPaste(""),
                    );
                  }}
                >
                  <label>
                    Paste transcript
                    <textarea
                      rows={5}
                      maxLength={80000}
                      required
                      value={paste}
                      onChange={(event) => setPaste(event.target.value)}
                    />
                  </label>
                  <div className="planning-actions">
                    <Button
                      type="submit"
                      disabled={command.busy || !paste.trim()}
                    >
                      Process transcript
                    </Button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}
        {command.error && (
          <p className="planning-error" role="alert">
            {command.error.message}
          </p>
        )}
        <p className="planning-notice" role="status">
          {command.notice}
        </p>
      </section>
      {meeting.transcript && (
        <section className="glass-panel planning-panel meeting-panel">
          <div className="planning-heading">
            <h2>Transcript · Revision {meeting.transcript.revision}</h2>
            {!historical && meeting.canManage && !busy && (
              <Button
                variant="secondary"
                disabled={command.busy}
                onClick={() => action({ action: "reprocess" })}
              >
                Reprocess suggestions
              </Button>
            )}
          </div>
          {meeting.history.length > 1 && (
            <nav className="planning-actions" aria-label="Transcript revisions">
              {meeting.history.map(({ revision }) => (
                <Link
                  key={revision}
                  to={`${head}?revision=${revision}`}
                  aria-current={
                    revision === meeting.transcript?.revision
                      ? "page"
                      : undefined
                  }
                >
                  Revision {revision}
                </Link>
              ))}
            </nav>
          )}
          <ol className="meeting-segments">
            {meeting.transcript.segments.map((segment) => (
              <Segment
                key={`${meeting.transcript!.revision}/${segment.id}`}
                segment={segment}
                source={citationPath(workspaceId, {
                  kind: "meeting",
                  projectId: project.id,
                  id: meeting.id,
                  anchor: {
                    revision: meeting.transcript!.revision,
                    segmentId: segment.id,
                    start: 0,
                    end: Array.from(segment.text).length,
                  },
                })}
                editable={meeting.canManage && !busy && !historical}
                endpoint={endpoint}
                version={meeting.version}
              />
            ))}
          </ol>
        </section>
      )}
      {!historical && meeting.transcript && (
        <MeetingItems endpoint={endpoint} meeting={meeting} />
      )}
      <DiscussionPanel
        projectId={project.id}
        subject={{ kind: "meeting", id: meeting.id }}
      />
    </>
  );
}

function Segment({
  segment,
  source,
  editable,
  endpoint,
  version,
}: {
  segment: MeetingSegment;
  source: string;
  editable: boolean;
  endpoint: string;
  version: number;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(segment.text);
  const [speaker, setSpeaker] = useState(segment.speaker ?? "");
  const command = usePlanningCommand();
  return (
    <li className="meeting-section">
      <strong>
        {segment.speaker || "Unknown speaker"}{" "}
        {segment.startMs !== null && `· ${recordingTime(segment.startMs)}`}
      </strong>
      {editing && editable ? (
        <form
          className="planning-form"
          onSubmit={(event) => {
            event.preventDefault();
            void command.save(
              endpoint,
              "PATCH",
              {
                action: "correct",
                expectedVersion: version,
                segmentId: segment.id,
                text,
                speaker: speaker.trim() || null,
              },
              () => setEditing(false),
            );
          }}
        >
          <label>
            Speaker
            <input
              maxLength={100}
              value={speaker}
              onChange={(event) => setSpeaker(event.target.value)}
            />
          </label>
          <label>
            Segment text
            <textarea
              required
              maxLength={2000}
              rows={3}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="planning-actions">
            <Button type="submit" disabled={command.busy || !text.trim()}>
              Save correction
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {command.error && (
            <p role="alert" className="planning-error">
              {command.error.message}
            </p>
          )}
        </form>
      ) : (
        <>
          <p className="meeting-transcript-text">{segment.text}</p>
          <div className="planning-actions">
            <Link to={source}>
              {segment.startMs === null
                ? "Open transcript evidence"
                : "Open recording segment"}
            </Link>
            {editable && (
              <Button variant="quiet" onClick={() => setEditing(true)}>
                Correct segment
              </Button>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function RecordingUpload({
  endpoint,
  meeting,
}: {
  endpoint: string;
  meeting: MeetingDetail;
}) {
  const { key } = usePlanning();
  const client = useQueryClient();
  const attempt = useRef<{
    file: File;
    mutationId: string;
    version: number;
  } | null>(null);
  const [file, setFile] = useState<File>();
  const [authorized, setAuthorized] = useState(false);
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState("");
  const busy = progress !== undefined;
  function upload() {
    if (!file || !authorized || busy) return;
    const extension = meetingAudioExtensionSchema.safeParse(
      file.name.split(".").at(-1)?.toLowerCase(),
    );
    if (!extension.success || !file.size || file.size > meetingAudioMaxBytes) {
      setError("Choose an MP3, WAV or M4A recording up to 20 MB.");
      return;
    }
    if (attempt.current?.file !== file)
      attempt.current = {
        file,
        mutationId: crypto.randomUUID(),
        version: meeting.version,
      };
    const params = new URLSearchParams({
      extension: extension.data,
      authorized: "true",
      mutationId: attempt.current.mutationId,
      expectedVersion: String(attempt.current.version),
    });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${endpoint}/audio?${params}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        setProgress(Math.round((event.loaded * 100) / event.total));
    };
    xhr.onload = () => {
      setProgress(undefined);
      if (xhr.status >= 200 && xhr.status < 300) {
        attempt.current = null;
        setFile(undefined);
        void client.invalidateQueries({ queryKey: key });
      } else {
        let message = "Could not upload the recording. Try again.";
        try {
          const value: unknown = JSON.parse(xhr.responseText);
          if (
            value &&
            typeof value === "object" &&
            "message" in value &&
            typeof value.message === "string"
          )
            message = value.message;
        } catch {
          /* Keep the fallback message. */
        }
        setError(message);
      }
    };
    xhr.onerror = () => {
      setProgress(undefined);
      setError("The upload was interrupted. Try again.");
    };
    xhr.ontimeout = xhr.onerror;
    xhr.timeout = 60000;
    setError("");
    setProgress(0);
    xhr.send(file);
  }
  return (
    <form
      className="planning-form"
      onSubmit={(event) => {
        event.preventDefault();
        upload();
      }}
    >
      <label>
        Recording
        <input
          type="file"
          accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4"
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0]);
            setError("");
          }}
        />
      </label>
      <p className="planning-help">
        MP3, WAV or M4A up to 20 MB. Retained for {meeting.retentionDays} days.
      </p>
      <label className="planning-choice">
        <input
          type="checkbox"
          checked={authorized}
          disabled={busy}
          onChange={(event) => setAuthorized(event.target.checked)}
        />
        I’m authorized to upload and transcribe this recording.
      </label>
      <div className="planning-actions">
        <Button type="submit" disabled={busy || !authorized || !file}>
          Upload recording
        </Button>
      </div>
      {busy && (
        <div role="status">
          <progress
            max={100}
            value={progress}
            aria-label="Recording upload progress"
          />{" "}
          {progress === 100 ? "Saving recording…" : `${progress}% uploaded`}
        </div>
      )}
      {error && (
        <p className="planning-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

type Item = MeetingDetail["items"][number];
const itemLabel = {
  suggested: "Suggested",
  submitted: "Awaiting approval",
  stale: "Needs review",
  accepted: "Accepted",
  rejected: "Rejected",
};
function MeetingItems({
  meeting,
  endpoint,
}: {
  meeting: MeetingDetail;
  endpoint: string;
}) {
  const { project, workspaceId } = useMeetingScope();
  const { api, key } = usePlanning();
  const people = useQuery({
    queryKey: [...key, "project", project.id, "people"],
    queryFn: ({ signal }) =>
      read(`${api}/projects/${project.id}/people`, projectPeopleSchema, signal),
    enabled: meeting.items.length > 0,
    ...planningRefresh,
  });
  return (
    <section className="glass-panel planning-panel meeting-panel">
      <h2>Follow-up</h2>
      {meeting.items.length === 0 ? (
        <p className="planning-help">
          No actions, decisions or questions were found in this transcript.
        </p>
      ) : (
        meeting.items.map((item) => (
          <MeetingItem
            key={item.id}
            item={item}
            meeting={meeting}
            endpoint={endpoint}
            workspaceId={workspaceId}
            projectId={project.id}
            owners={people.data?.owners ?? []}
          />
        ))
      )}
    </section>
  );
}

function MeetingItem({
  item,
  meeting,
  endpoint,
  workspaceId,
  projectId,
  owners,
}: {
  item: Item;
  meeting: MeetingDetail;
  endpoint: string;
  workspaceId: string;
  projectId: string;
  owners: { id: string; name: string }[];
}) {
  const [draft, setDraft] = useState<Item["values"]>();
  const navigate = useNavigate();
  const command = usePlanningCommand();
  const values = item.values;
  const base = workspacePath(projectPath(projectId), workspaceId);
  const review = (id: string) => workspacePath(`/reviews/${id}`, workspaceId);
  const source = citationPath(workspaceId, {
    kind: "meeting",
    projectId,
    id: meeting.id,
    anchor: item.anchor,
  });
  const action = (data: object, done: (id: string) => void = () => {}) =>
    void command.save(
      `${endpoint}/items/${item.id}`,
      "POST",
      { ...data, expectedVersion: item.version },
      done,
    );
  const kindLabel = {
    action: "Action",
    decision: "Decision",
    question: "Open question",
  }[values.kind];
  return (
    <article className="meeting-section meeting-item">
      <div className="planning-heading">
        <h3>{values.title}</h3>
        <StatusLabel
          tone={
            item.status === "stale"
              ? "risk"
              : item.status === "accepted"
                ? "confirmed"
                : "neutral"
          }
        >
          {item.completedAt ? "Completed" : itemLabel[item.status]}
        </StatusLabel>
      </div>
      <p className="planning-help">
        {kindLabel} ·{" "}
        {owners.find(({ id }) => id === values.ownerId)?.name ??
          (values.ownerId ? "Assigned" : "Unassigned")}{" "}
        · {values.date ?? "No date"}
      </p>
      {item.sourceChanged && (
        <p className="planning-help">
          The supporting transcript segment has been corrected.
        </p>
      )}
      <div className="planning-actions">
        <Link to={source}>Open supporting segment</Link>
        {item.proposalId && (
          <Link to={review(item.proposalId)}>Open review</Link>
        )}
        {item.workId && (
          <Link to={`${base}/work/${item.workId}`}>Open resulting task</Link>
        )}
        {item.decisionId && (
          <Link to={`${base}/documents/decisions/${item.decisionId}`}>
            Open confirmed decision
          </Link>
        )}
      </div>
      {values.detail && <p>{values.detail}</p>}
      {draft && meeting.canSubmit && item.status === "suggested" ? (
        <form
          className="planning-form"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = meetingItemValuesSchema.safeParse(draft);
            if (!parsed.success) {
              command.invalid("Check the title, date and follow-up text.");
              return;
            }
            action({ action: "submit", values: parsed.data }, (id) =>
              navigate(review(id)),
            );
          }}
        >
          <label>
            Follow-up title
            <input
              required
              maxLength={160}
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label>
            {draft.kind === "decision" ? "Conclusion" : "Details"}
            <textarea
              rows={2}
              maxLength={2000}
              required={draft.kind === "decision"}
              value={draft.detail ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, detail: event.target.value || null })
              }
            />
          </label>
          {draft.kind !== "question" && (
            <div className="planning-form-grid">
              <label>
                {draft.kind === "decision" ? "Accountable person" : "Owner"}
                <select
                  required={draft.kind === "decision"}
                  value={draft.ownerId ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, ownerId: event.target.value || null })
                  }
                >
                  <option value="">
                    {draft.kind === "decision"
                      ? "Choose a person"
                      : "Unassigned"}
                  </option>
                  {draft.ownerId &&
                    !owners.some(({ id }) => id === draft.ownerId) && (
                      <option value={draft.ownerId}>Owner unavailable</option>
                    )}
                  {owners.map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
                <small>
                  {item.ownerExplicit
                    ? "Transcript names an owner"
                    : "Owner needs confirmation"}
                </small>
              </label>
              <label>
                {draft.kind === "decision" ? "Effective date" : "Due date"}
                <input
                  type="date"
                  min="0001-01-01"
                  max="9999-12-31"
                  value={draft.date ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, date: event.target.value || null })
                  }
                />
                <small>
                  {item.dateExplicit
                    ? "Date stated in transcript"
                    : "Date needs confirmation"}
                </small>
              </label>
            </div>
          )}
          <div className="planning-actions">
            <Button type="submit" disabled={command.busy}>
              Submit for approval
            </Button>
            <Button variant="quiet" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="planning-actions">
          {meeting.canSubmit && item.status === "suggested" && (
            <Button variant="secondary" onClick={() => setDraft(values)}>
              Review {values.kind}
            </Button>
          )}
          {meeting.canReject &&
            ["suggested", "stale"].includes(item.status) && (
              <Button
                variant="quiet"
                disabled={command.busy}
                onClick={() => action({ action: "reject" })}
              >
                Reject {values.kind}
              </Button>
            )}
        </div>
      )}
      {command.error && (
        <p className="planning-error" role="alert">
          {command.error.message}
        </p>
      )}
    </article>
  );
}
