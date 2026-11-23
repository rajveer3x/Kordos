import {
  workFieldsSchema,
  workItemSchema,
  workKindSchema,
  workStatusSchema,
  type ProjectPeople,
  type WorkFields,
  type WorkItem,
} from "@kordos/contracts";
import { useState } from "react";
import { Button } from "../../components/ui";
import { citationFromLink } from "../knowledge/knowledge-client";
import {
  retainEdits,
  usePlanning,
  usePlanningCommand,
} from "./planning-client";

export const workLabels = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
} as const;

function toDraft(item?: WorkItem) {
  return {
    title: item?.title ?? "",
    description: item?.description ?? "",
    kind: item?.kind ?? "task",
    status: item?.status ?? "backlog",
    ownerId: item?.ownerId ?? "",
    estimateDays: item?.estimateDays?.toString() ?? "",
    deadline: item?.deadline ?? "",
    commitment: item?.commitment ?? "",
    blockerReason: item?.blockerReason ?? "",
    blockerOwnerId: item?.blockerOwnerId ?? "",
    blockerResolution: item?.blockerResolution ?? "",
  };
}

function OwnerSelect({
  label,
  value,
  onChange,
  owners,
  previousOwner,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  owners: ProjectPeople["owners"];
  previousOwner?: WorkItem["owner"];
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Unassigned</option>
        {previousOwner &&
          value === previousOwner.id &&
          !owners.some(({ id }) => id === previousOwner.id) && (
            <option value={previousOwner.id}>
              {previousOwner.name} (previous owner)
            </option>
          )}
        {owners.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ConflictDetails({
  current,
  original,
}: {
  current: WorkItem;
  original?: WorkItem;
}) {
  const labels: Record<keyof ReturnType<typeof toDraft>, string> = {
    title: "Title",
    description: "Description",
    kind: "Type",
    status: "Status",
    ownerId: "Owner",
    estimateDays: "Estimate (working days)",
    deadline: "Deadline",
    commitment: "Committed date",
    blockerReason: "Blocker reason",
    blockerOwnerId: "Blocker owner",
    blockerResolution: "Blocker resolution",
  };
  const latest = toDraft(current);
  const previous = toDraft(original);
  const changes = (Object.keys(labels) as (keyof typeof labels)[]).filter(
    (field) => latest[field] !== previous[field],
  );
  return (
    <>
      <p>
        Latest saved version {current.version}
        {current.archived ? " · Archived" : ""}
      </p>
      {changes.length > 0 && (
        <dl className="planning-facts">
          {changes.map((field) => (
            <div key={field}>
              <dt>{labels[field]}</dt>
              <dd>
                {field === "ownerId"
                  ? (current.owner?.name ?? "Unassigned")
                  : field === "blockerOwnerId"
                    ? (current.blockerOwner?.name ?? "Unassigned")
                    : field === "status"
                      ? workLabels[current.status]
                      : latest[field] || "Cleared"}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

export function WorkEditor({
  path,
  item,
  owners,
  lead,
  onSaved,
  onCancel,
  canSave,
  proposal,
}: {
  path: string;
  item?: WorkItem;
  owners: ProjectPeople["owners"];
  lead: boolean;
  onSaved: (id: string) => void;
  onCancel: () => void;
  canSave: boolean;
  proposal?: {
    initial?: WorkFields;
    evidenceLinks?: string[];
    revision?: { revision: number; expectedVersion: number };
  };
}) {
  const command = usePlanningCommand();
  const { workspace } = usePlanning();
  const [base, setBase] = useState(item);
  const [draft, setDraft] = useState(() =>
    toDraft(
      item && proposal?.initial ? { ...item, ...proposal.initial } : item,
    ),
  );
  const [showBlocker, setShowBlocker] = useState(!!draft.blockerReason);
  const [evidenceLinks, setEvidenceLinks] = useState(
    () => proposal?.evidenceLinks?.join("\n") ?? "",
  );
  const current = workItemSchema.safeParse(command.error?.current).data;

  function change<K extends keyof typeof draft>(
    name: K,
    value: (typeof draft)[K],
  ) {
    setDraft((previous) => ({ ...previous, [name]: value }));
  }

  return (
    <form
      className="planning-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave || current) return;
        const input = {
          ...draft,
          description: draft.description || null,
          ownerId: draft.ownerId || null,
          estimateDays: draft.estimateDays ? Number(draft.estimateDays) : null,
          deadline: draft.deadline || null,
          commitment:
            draft.kind === "milestone" ? draft.commitment || null : null,
          blockerReason: showBlocker ? draft.blockerReason : null,
          blockerOwnerId: showBlocker ? draft.blockerOwnerId || null : null,
          blockerResolution: showBlocker
            ? draft.blockerResolution || null
            : null,
        };
        const parsed = workFieldsSchema.safeParse(input);
        if (!parsed.success) {
          command.invalid(
            "Check the title, dates, estimate, and blocker details.",
          );
          return;
        }
        const fields = parsed.data;
        if (proposal && base) {
          const evidence = evidenceLinks
            .split("\n")
            .map((link) => link.trim())
            .filter(Boolean)
            .map((link) => citationFromLink(link, workspace.id));
          if (evidence.length > 12 || evidence.some((source) => !source)) {
            command.invalid(
              "Use up to 12 evidence links from this workspace, one per line.",
            );
            return;
          }
          const payload = {
            targetVersion: base.version,
            command: { kind: "work.edit", values: fields },
            evidence,
          };
          void command.save(
            path,
            proposal.revision ? "PATCH" : "POST",
            proposal.revision
              ? { ...payload, ...proposal.revision }
              : { ...payload, workId: base.id },
            onSaved,
          );
          return;
        }
        void command.save(
          path,
          base ? "PATCH" : "POST",
          base
            ? { ...fields, action: "edit", expectedVersion: base.version }
            : fields,
          onSaved,
        );
      }}
    >
      {!item && (
        <label>
          Work type
          <select
            value={draft.kind}
            onChange={(event) =>
              change("kind", workKindSchema.parse(event.target.value))
            }
          >
            <option value="task">Task</option>
            <option value="milestone">Milestone</option>
          </select>
        </label>
      )}
      <label>
        Title
        <input
          required
          maxLength={180}
          value={draft.title}
          onChange={(event) => change("title", event.target.value)}
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
      <div className="planning-form-grid">
        <label>
          Status
          <select
            value={draft.status}
            onChange={(event) =>
              change("status", workStatusSchema.parse(event.target.value))
            }
          >
            {Object.entries(workLabels).map(([status, name]) => (
              <option key={status} value={status}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <OwnerSelect
          label="Owner"
          value={draft.ownerId}
          owners={owners}
          previousOwner={base?.owner}
          onChange={(value) => change("ownerId", value)}
        />
        <label>
          Estimate (working days)
          <input
            type="number"
            min={1}
            max={3650}
            value={draft.estimateDays}
            onChange={(event) => change("estimateDays", event.target.value)}
          />
        </label>
        <label>
          Deadline
          <input
            type="date"
            value={draft.deadline}
            onChange={(event) => change("deadline", event.target.value)}
          />
        </label>
        {draft.kind === "milestone" && (
          <label>
            Committed date
            <input
              type="date"
              value={draft.commitment}
              readOnly={!lead}
              onChange={(event) => change("commitment", event.target.value)}
            />
          </label>
        )}
      </div>
      <fieldset>
        <legend>Blocker</legend>
        <label className="planning-choice">
          <input
            type="checkbox"
            checked={showBlocker}
            onChange={(event) => setShowBlocker(event.target.checked)}
          />{" "}
          Record a blocker
        </label>
        {showBlocker && (
          <>
            <label>
              Blocker reason
              <textarea
                required
                maxLength={2000}
                rows={2}
                value={draft.blockerReason}
                onChange={(event) =>
                  change("blockerReason", event.target.value)
                }
              />
            </label>
            <OwnerSelect
              label="Blocker owner"
              value={draft.blockerOwnerId}
              owners={owners}
              previousOwner={base?.blockerOwner}
              onChange={(value) => change("blockerOwnerId", value)}
            />
            <label>
              Blocker resolution
              <textarea
                placeholder="Leave blank while blocked"
                maxLength={2000}
                rows={2}
                value={draft.blockerResolution}
                onChange={(event) =>
                  change("blockerResolution", event.target.value)
                }
              />
            </label>
          </>
        )}
      </fieldset>
      {proposal && (
        <label>
          Evidence links (optional)
          <textarea
            rows={3}
            aria-describedby="proposal-evidence-help"
            value={evidenceLinks}
            onChange={(event) => setEvidenceLinks(event.target.value)}
          />
          <span id="proposal-evidence-help" className="planning-help">
            Paste a link to a document passage or comment, one per line.
          </span>
        </label>
      )}
      {!canSave && (
        <p className="planning-help">
          The item is archived. Your draft is still available to copy.
        </p>
      )}
      {command.error && (
        <p role="alert" className="planning-error">
          {command.error.message}
        </p>
      )}
      {current && (
        <div className="planning-conflict">
          <ConflictDetails current={current} original={base} />
          {!current.archived && (
            <Button
              variant="secondary"
              onClick={() => {
                const latest = toDraft(current);
                const merged = retainEdits(draft, toDraft(base), latest);
                if (showBlocker === !!base?.blockerReason)
                  setShowBlocker(!!merged.blockerReason);
                setDraft(merged);
                setBase(current);
                command.clearError();
              }}
            >
              Keep my edits and use latest version
            </Button>
          )}
        </div>
      )}
      <div className="planning-actions">
        <Button type="submit" disabled={!canSave || command.busy || !!current}>
          {proposal
            ? "Save proposal draft"
            : item
              ? "Save changes"
              : draft.kind === "milestone"
                ? "Create milestone"
                : "Create task"}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
