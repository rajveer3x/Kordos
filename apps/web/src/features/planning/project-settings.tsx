import {
  projectFieldsSchema,
  projectPeopleSchema,
  projectRoleSchema,
  projectSchema,
  audienceSchema,
  type ProjectDetails,
  type ProjectPeople,
  type ProjectRole,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { AsyncState, Button } from "../../components/ui";
import { read } from "../identity/api";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import {
  planningRefresh,
  retainEdits,
  useLiveProject,
  usePlanning,
  usePlanningCommand,
} from "./planning-client";

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function projectDraft(details: ProjectDetails | undefined, timeZone: string) {
  return {
    name: details?.name ?? "",
    description: details?.description ?? "",
    visibility: details?.visibility ?? "restricted",
    timeZone: details?.timeZone ?? timeZone,
    workdays: details?.workdays.join(",") ?? "1,2,3,4,5",
    nonworkingDates: details?.nonworkingDates.join("\n") ?? "",
  };
}

export function ProjectEditor({
  project,
  onSaved,
}: {
  project?: ProjectDetails;
  onSaved: (id: string) => void;
}) {
  const { key, api, workspace } = usePlanning();
  const command = usePlanningCommand();
  const [base, setBase] = useState(project);
  const [draft, setDraft] = useState(() =>
    projectDraft(project, workspace.timeZone),
  );
  const audience = useQuery({
    queryKey: [...key, "audience"],
    queryFn: ({ signal }) =>
      read(`${api}/project-audience`, audienceSchema, signal),
    enabled: draft.visibility === "workspace",
    ...planningRefresh,
  });
  const current = projectSchema.safeParse(command.error?.current).data;
  const selectedDays = draft.workdays.split(",").filter(Boolean).map(Number);

  function change<K extends keyof typeof draft>(
    key: K,
    value: (typeof draft)[K],
  ) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  return (
    <form
      className="planning-form"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = {
          ...draft,
          description: draft.description || null,
          workdays: selectedDays,
          nonworkingDates: [
            ...new Set(draft.nonworkingDates.split(/[\s,]+/).filter(Boolean)),
          ].sort(),
        };
        const validated = projectFieldsSchema.safeParse(fields);
        if (!validated.success) {
          command.invalid(
            "Enter a project name, an IANA timezone, at least one working day, and valid nonworking dates (YYYY-MM-DD).",
          );
          return;
        }
        const input = validated.data;
        void command.save(
          base ? `${api}/projects/${base.id}` : `${api}/projects`,
          base ? "PATCH" : "POST",
          base
            ? { ...input, action: "edit", expectedVersion: base.version }
            : input,
          onSaved,
          "Project saved.",
        );
      }}
    >
      <label>
        Project name
        <input
          required
          maxLength={100}
          value={draft.name}
          onChange={(event) => change("name", event.target.value)}
        />
      </label>
      <label>
        Description
        <textarea
          rows={3}
          maxLength={12000}
          value={draft.description}
          onChange={(event) => change("description", event.target.value)}
        />
      </label>
      <fieldset>
        <legend>Visibility</legend>
        <label className="planning-choice">
          <input
            type="radio"
            name="visibility"
            checked={draft.visibility === "restricted"}
            onChange={() => change("visibility", "restricted")}
          />{" "}
          Restricted
        </label>
        <label className="planning-choice">
          <input
            type="radio"
            name="visibility"
            checked={draft.visibility === "workspace"}
            onChange={() => change("visibility", "workspace")}
          />{" "}
          Workspace-visible
        </label>
        <p className="planning-help" aria-live="polite">
          {draft.visibility === "restricted"
            ? "Only people added to this project can open it."
            : audience.isPending
              ? "Checking the audience…"
              : audience.isError
                ? "All current and future workspace members can open this project."
                : `${audience.data.count} current members of ${workspace.name} can open this project. Future workspace members will also have access.`}
        </p>
      </fieldset>
      <fieldset>
        <legend>Working calendar</legend>
        <label>
          Project timezone
          <input
            required
            maxLength={100}
            value={draft.timeZone}
            onChange={(event) => change("timeZone", event.target.value)}
          />
        </label>
        <div className="planning-weekdays" aria-label="Working days">
          {weekdays.map((day, index) => (
            <label className="planning-choice" key={day}>
              <input
                type="checkbox"
                checked={selectedDays.includes(index + 1)}
                onChange={(event) => {
                  const days = event.target.checked
                    ? [...selectedDays, index + 1]
                    : selectedDays.filter((value) => value !== index + 1);
                  change(
                    "workdays",
                    days.sort((left, right) => left - right).join(","),
                  );
                }}
              />{" "}
              {day}
            </label>
          ))}
        </div>
        <label>
          Nonworking dates
          <textarea
            rows={2}
            placeholder="YYYY-MM-DD"
            value={draft.nonworkingDates}
            onChange={(event) => change("nonworkingDates", event.target.value)}
          />
        </label>
      </fieldset>
      {command.error && (
        <p role="alert" className="planning-error">
          {command.error.message}
        </p>
      )}
      {current && (
        <div className="planning-conflict">
          <p>
            Version {current.version} · {current.name} ·{" "}
            {current.visibility === "restricted"
              ? "Restricted"
              : "Workspace-visible"}
          </p>
          <Button
            variant="secondary"
            disabled={current.archived}
            onClick={() => {
              setDraft(
                retainEdits(
                  draft,
                  projectDraft(base, workspace.timeZone),
                  projectDraft(current, workspace.timeZone),
                ),
              );
              setBase(current);
              command.clearError();
            }}
          >
            Keep my edits and use latest version
          </Button>
        </div>
      )}
      <div className="planning-actions">
        <Button type="submit" disabled={command.busy || !!current}>
          {base ? "Save project" : "Create project"}
        </Button>
      </div>
      <p className="planning-notice" role="status">
        {command.notice}
      </p>
    </form>
  );
}

function MemberForm({
  projectId,
  member,
  candidates,
}: {
  projectId: string;
  member?: ProjectPeople["members"][number];
  candidates?: ProjectPeople["candidates"];
}) {
  const { api } = usePlanning();
  const command = usePlanningCommand();
  const [draft, setDraft] = useState<{
    role: ProjectRole;
    version: number | null;
  }>();
  const [candidate, setCandidate] = useState("");
  const role = draft?.role ?? member?.role ?? "viewer";
  const user = member?.id ?? candidate;
  const version = draft ? draft.version : (member?.version ?? null);
  const base = `${api}/projects/${projectId}/members/${user}`;
  const conflict = projectPeopleSchema.shape.members.element
    .nullable()
    .safeParse(command.error?.current);
  const name = member?.name;

  function save(value: ProjectRole | null) {
    void command.save(
      base,
      "PATCH",
      { expectedVersion: version, role: value },
      () => {
        setDraft(undefined);
        setCandidate("");
      },
      value ? "Project role saved." : "Project access removed.",
    );
  }

  return (
    <form
      className="planning-member"
      onSubmit={(event) => {
        event.preventDefault();
        save(role);
      }}
    >
      {member ? (
        <strong>{name}</strong>
      ) : (
        <label>
          Workspace member
          <select
            required
            value={user}
            onChange={(event) => {
              setCandidate(event.target.value);
              setDraft(undefined);
              command.clearError();
            }}
          >
            <option value="">Select a member</option>
            {candidates?.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {name ? `Project role for ${name}` : "Project role"}
        <select
          value={role}
          onChange={(event) =>
            setDraft({
              role: projectRoleSchema.parse(event.target.value),
              version,
            })
          }
        >
          <option value="viewer">Viewer</option>
          <option value="contributor">Contributor</option>
          <option value="lead">Lead</option>
        </select>
      </label>
      <div className="planning-actions">
        <Button
          type="submit"
          variant="secondary"
          disabled={!user || command.busy || conflict.success}
        >
          {name ? `Save role for ${name}` : "Add member"}
        </Button>
        {member && (
          <Button
            variant="quiet"
            disabled={command.busy || conflict.success}
            onClick={() => save(null)}
          >{`Remove ${name}`}</Button>
        )}
      </div>
      {command.error && (
        <p role="alert" className="planning-error">
          {command.error.message}
        </p>
      )}
      {conflict.success && (
        <div className="planning-conflict">
          <p>
            {conflict.data
              ? `Current role is ${conflict.data.role}.`
              : "This person has no explicit project role."}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft({ role, version: conflict.data?.version ?? null });
              command.clearError();
            }}
          >
            Use current membership version
          </Button>
        </div>
      )}
      <p className="planning-notice" role="status">
        {command.notice}
      </p>
    </form>
  );
}

export function ProjectSettings() {
  const { details } = useLiveProject();
  const { key, api, workspace } = usePlanning();
  const path = workspacePath(projectPath(details.id), workspace.id);
  const navigate = useNavigate();
  const command = usePlanningCommand();
  const people = useQuery({
    queryKey: [...key, "project", details.id, "people"],
    queryFn: ({ signal }) =>
      read(`${api}/projects/${details.id}/people`, projectPeopleSchema, signal),
    enabled: details.role === "lead",
    ...planningRefresh,
  });
  if (details.role !== "lead")
    return <p className="empty-message">Project settings are unavailable.</p>;
  return (
    <section
      className="planning-settings"
      aria-labelledby="project-settings-title"
    >
      <title>{`Project settings · ${details.name} · Kordos`}</title>
      <Link to={path}>Back to overview</Link>
      <h2 id="project-settings-title">Project settings</h2>
      {!details.archived && (
        <div className="planning-panel glass-panel">
          <ProjectEditor project={details} onSaved={() => navigate(path)} />
        </div>
      )}
      <section
        className="planning-panel glass-panel"
        aria-labelledby="project-member-title"
      >
        <h3 id="project-member-title">Project members</h3>
        {people.isPending ? (
          <AsyncState kind="loading" message="Loading members…" />
        ) : people.isError ? (
          <AsyncState
            kind="error"
            message="Could not load project members."
            retry={() => void people.refetch()}
          />
        ) : (
          <>
            {people.data.members.map((member) => (
              <MemberForm
                key={member.id}
                projectId={details.id}
                member={member}
              />
            ))}
            {people.data.candidates.length > 0 && (
              <MemberForm
                projectId={details.id}
                candidates={people.data.candidates}
              />
            )}
          </>
        )}
      </section>
      <section
        className="planning-panel glass-panel"
        aria-labelledby="project-lifecycle-title"
      >
        <h3 id="project-lifecycle-title">Project lifecycle</h3>
        <p>
          {details.archived
            ? "Reopen the project to resume work and include it in active views."
            : "Archive the project to remove it from active views and keep its work and history available."}
        </p>
        <Button
          variant="secondary"
          disabled={command.busy}
          onClick={() => {
            void command.save(
              `${api}/projects/${details.id}`,
              "PATCH",
              {
                action: details.archived ? "reopen" : "archive",
                expectedVersion: details.version,
              },
              () => navigate(path),
            );
          }}
        >
          {details.archived ? "Reopen project" : "Archive project"}
        </Button>
        {command.error && (
          <p role="alert" className="planning-error">
            {command.error.message}
          </p>
        )}
      </section>
    </section>
  );
}
