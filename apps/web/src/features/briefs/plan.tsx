import type { BriefPlan, ResolvedCitation } from "@kordos/contracts";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui";
import { EvidencePassage } from "../knowledge/evidence-passage";
import "./briefs.css";

type Task = BriefPlan["tasks"][number];
type Owners = { id: string; name: string }[];
type Evidence = (task: Task) => ReactNode;

const certaintyLabel = {
  explicit: "Stated in brief",
  inferred: "Inferred from brief",
  missing: "Missing from brief",
  edited: "Set in review",
} as const;

function newTask(passages: Task["passages"] = []): Task {
  return {
    id: crypto.randomUUID(),
    title: "",
    description: null,
    ownerId: null,
    estimateDays: null,
    deadline: null,
    passages,
    certainty: { owner: "missing", estimate: "missing", deadline: "missing" },
  };
}

export function TaskEvidence({
  task,
  evidence,
}: {
  task: Task;
  evidence: ResolvedCitation[];
}) {
  return task.passages.map((anchor) => {
    const entry = evidence.find(
      ({ source }) =>
        source.kind === "document" &&
        source.anchor.revision === anchor.revision &&
        source.anchor.start === anchor.start &&
        source.anchor.end === anchor.end,
    );
    return (
      entry && (
        <EvidencePassage key={`${anchor.start}:${anchor.end}`} entry={entry} />
      )
    );
  });
}

export function PlanPreview({
  plan,
  owners,
  evidence,
  workLinks,
}: {
  plan: BriefPlan;
  owners: Owners;
  evidence: Evidence;
  workLinks: Record<string, string>;
}) {
  const names = new Map(plan.tasks.map((task) => [task.id, task.title]));
  return (
    <>
      <ol className="brief-candidates">
        {plan.tasks.map((task) => (
          <li key={task.id} className="brief-candidate">
            <h3>
              {workLinks[task.id] ? (
                <Link to={workLinks[task.id]!}>{task.title}</Link>
              ) : (
                task.title
              )}
            </h3>
            {task.description && <p>{task.description}</p>}
            <dl className="planning-facts">
              <div>
                <dt>Owner</dt>
                <dd>
                  {owners.find(({ id }) => id === task.ownerId)?.name ??
                    "Unassigned"}{" "}
                  <small>{certaintyLabel[task.certainty.owner]}</small>
                </dd>
              </div>
              <div>
                <dt>Estimate</dt>
                <dd>
                  {task.estimateDays === null
                    ? "Unestimated"
                    : `${task.estimateDays} workday(s)`}{" "}
                  <small>{certaintyLabel[task.certainty.estimate]}</small>
                </dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd>
                  {task.deadline ?? "Undated"}{" "}
                  <small>{certaintyLabel[task.certainty.deadline]}</small>
                </dd>
              </div>
            </dl>
            {evidence(task)}
          </li>
        ))}
      </ol>
      <h3>Dependencies</h3>
      {plan.edges.length ? (
        <ul className="brief-edges">
          {plan.edges.map((edge) => (
            <li key={`${edge.predecessorId}/${edge.successorId}`}>
              {names.get(edge.successorId)} follows{" "}
              {names.get(edge.predecessorId)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="planning-help">No dependencies.</p>
      )}
    </>
  );
}

export function PlanEditor({
  initial,
  owners,
  evidence,
  busy,
  onSave,
  onCancel,
}: {
  initial: BriefPlan | null;
  owners: Owners;
  evidence: Evidence;
  busy: boolean;
  onSave: (plan: BriefPlan) => void;
  onCancel?: () => void;
}) {
  const [plan, setPlan] = useState<BriefPlan>(
    () => initial ?? { tasks: [newTask()], edges: [] },
  );
  const [predecessorId, setPredecessor] = useState("");
  const [successorId, setSuccessor] = useState("");
  const names = new Map(
    plan.tasks.map(({ id, title }, index) => [
      id,
      title.trim() || `Task ${index + 1}`,
    ]),
  );
  function update(id: string, fields: Partial<Task>) {
    setPlan((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.id === id ? { ...task, ...fields } : task,
      ),
    }));
  }

  return (
    <form
      className="planning-form brief-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(plan);
      }}
    >
      <ol className="brief-candidates">
        {plan.tasks.map((task, index) => (
          <li key={task.id}>
            <fieldset className="brief-candidate">
              <legend>Task {index + 1}</legend>
              <label>
                Task title
                <input
                  required
                  maxLength={180}
                  value={task.title}
                  onChange={(event) =>
                    update(task.id, { title: event.target.value })
                  }
                />
              </label>
              <label>
                Description
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={task.description ?? ""}
                  onChange={(event) =>
                    update(task.id, { description: event.target.value || null })
                  }
                />
              </label>
              <div className="planning-form-grid">
                <label>
                  Owner
                  <select
                    value={task.ownerId ?? ""}
                    onChange={(event) =>
                      update(task.id, {
                        ownerId: event.target.value || null,
                        certainty: { ...task.certainty, owner: "edited" },
                      })
                    }
                  >
                    <option value="">Unassigned</option>
                    {task.ownerId &&
                      !owners.some(({ id }) => id === task.ownerId) && (
                        <option value={task.ownerId}>Owner unavailable</option>
                      )}
                    {owners.map(({ id, name }) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <small>{certaintyLabel[task.certainty.owner]}</small>
                </label>
                <label>
                  Estimate (workdays)
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    value={task.estimateDays ?? ""}
                    onChange={(event) =>
                      update(task.id, {
                        estimateDays: event.target.value
                          ? event.target.valueAsNumber
                          : null,
                        certainty: { ...task.certainty, estimate: "edited" },
                      })
                    }
                  />
                  <small>{certaintyLabel[task.certainty.estimate]}</small>
                </label>
                <label>
                  Deadline
                  <input
                    type="date"
                    min="0001-01-01"
                    max="9999-12-31"
                    value={task.deadline ?? ""}
                    onChange={(event) =>
                      update(task.id, {
                        deadline: event.target.value || null,
                        certainty: { ...task.certainty, deadline: "edited" },
                      })
                    }
                  />
                  <small>{certaintyLabel[task.certainty.deadline]}</small>
                </label>
              </div>
              {evidence(task)}
              <div className="planning-actions">
                <Button
                  variant="secondary"
                  disabled={
                    busy || plan.tasks.length >= 24 || plan.edges.length >= 60
                  }
                  onClick={() => {
                    const second = newTask(task.passages);
                    setPlan({
                      tasks: plan.tasks.toSpliced(index + 1, 0, second),
                      edges: [
                        ...plan.edges.map((edge) =>
                          edge.predecessorId === task.id
                            ? { ...edge, predecessorId: second.id }
                            : edge,
                        ),
                        { predecessorId: task.id, successorId: second.id },
                      ],
                    });
                  }}
                >
                  Split task
                </Button>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => {
                    setPlan({
                      tasks: plan.tasks.filter(({ id }) => id !== task.id),
                      edges: plan.edges.filter(
                        (edge) =>
                          edge.predecessorId !== task.id &&
                          edge.successorId !== task.id,
                      ),
                    });
                    if (predecessorId === task.id) setPredecessor("");
                    if (successorId === task.id) setSuccessor("");
                  }}
                >
                  Remove task
                </Button>
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
      <Button
        variant="secondary"
        disabled={busy || plan.tasks.length >= 24}
        onClick={() => setPlan({ ...plan, tasks: [...plan.tasks, newTask()] })}
      >
        Add task
      </Button>
      <fieldset className="brief-candidate">
        <legend>Dependencies</legend>
        {plan.edges.length > 0 && (
          <ul className="brief-edges">
            {plan.edges.map((edge) => (
              <li key={`${edge.predecessorId}/${edge.successorId}`}>
                <span>
                  {names.get(edge.successorId)} follows{" "}
                  {names.get(edge.predecessorId)}
                </span>
                <Button
                  variant="quiet"
                  disabled={busy}
                  aria-label={`Remove dependency: ${names.get(edge.successorId)} follows ${names.get(edge.predecessorId)}`}
                  onClick={() =>
                    setPlan({
                      ...plan,
                      edges: plan.edges.filter((prior) => prior !== edge),
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {plan.tasks.length >= 2 && (
          <div className="planning-form-grid">
            <label>
              Predecessor
              <select
                value={predecessorId}
                onChange={(event) => setPredecessor(event.target.value)}
              >
                <option value="">Choose task</option>
                {Array.from(names, ([id, name]) => (
                  <option key={id} value={id} disabled={id === successorId}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Successor
              <select
                value={successorId}
                onChange={(event) => setSuccessor(event.target.value)}
              >
                <option value="">Choose task</option>
                {Array.from(names, ([id, name]) => (
                  <option key={id} value={id} disabled={id === predecessorId}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="secondary"
              disabled={
                busy ||
                !predecessorId ||
                !successorId ||
                plan.edges.length >= 60 ||
                plan.edges.some(
                  (edge) =>
                    edge.predecessorId === predecessorId &&
                    edge.successorId === successorId,
                )
              }
              onClick={() => {
                setPlan({
                  ...plan,
                  edges: [...plan.edges, { predecessorId, successorId }],
                });
                setPredecessor("");
                setSuccessor("");
              }}
            >
              Add dependency
            </Button>
          </div>
        )}
      </fieldset>
      <div className="planning-actions">
        <Button type="submit" disabled={busy || !plan.tasks.length}>
          Save plan draft
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
