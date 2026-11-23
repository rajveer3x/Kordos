import {
  createScenarioSchema,
  scenarioSchema,
  type ProjectGraph,
  type ScheduleItem,
} from "@kordos/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "../../components/ui";
import { errorMessage, request } from "../identity/api";

type Adjustment = {
  id: string;
  workId: string;
  kind: "handoff" | "remaining";
  value: string;
};

function adjustment(workId: string): Adjustment {
  return { id: crypto.randomUUID(), workId, kind: "handoff", value: "" };
}

export function ForecastScenario({
  graph,
  tasks,
  selected,
  path,
  queryKey,
  onPreview,
  refresh,
}: {
  graph: ProjectGraph;
  tasks: ScheduleItem[];
  selected: string | undefined;
  path: string;
  queryKey: readonly string[];
  onPreview: (id: string) => void;
  refresh: () => void;
}) {
  const [adjustments, setAdjustments] = useState(() => [
    adjustment(
      tasks.some(({ id }) => id === selected) ? selected! : tasks[0]!.id,
    ),
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const last = useRef<{ fingerprint: string; mutationId: string }>(null);
  const client = useQueryClient();

  function edit(id: string, fields: Partial<Adjustment>) {
    setAdjustments((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...fields } : row)),
    );
  }

  async function preview() {
    const body = {
      inputRevision: graph.inputRevision,
      asOf: graph.asOf,
      changes: adjustments.map(({ workId, kind, value }) =>
        kind === "handoff"
          ? { workId, kind, finish: value }
          : { workId, kind, days: Number(value) },
      ),
    };
    const fingerprint = JSON.stringify(body);
    if (last.current?.fingerprint !== fingerprint) {
      last.current = { fingerprint, mutationId: crypto.randomUUID() };
    }
    const validated = createScenarioSchema.safeParse({
      ...body,
      mutationId: last.current.mutationId,
    });
    if (!validated.success) {
      setError(
        "Choose a different unfinished task for each adjustment and enter a valid date or estimate.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const scenario = await request(path, {
        method: "POST",
        body: validated.data,
        schema: scenarioSchema,
      });
      if (!scenario) throw new Error("Missing scenario.");
      client.setQueryData([...queryKey, scenario.id], scenario);
      onPreview(scenario.id);
    } catch (failure) {
      setError(errorMessage(failure));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="forecast-form planning-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void preview();
      }}
    >
      {adjustments.map((row, index) => (
        <fieldset
          key={row.id}
          className="forecast-adjustment planning-form-grid"
          disabled={busy}
        >
          <legend>Adjustment {index + 1}</legend>
          <label>
            Task
            <select
              required
              value={row.workId}
              onChange={(event) => edit(row.id, { workId: event.target.value })}
            >
              <option value="">Choose a task</option>
              {tasks.map(({ id, title }) => (
                <option
                  key={id}
                  value={id}
                  disabled={adjustments.some(
                    (other) => other.id !== row.id && other.workId === id,
                  )}
                >
                  {title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Change
            <select
              value={row.kind}
              onChange={(event) =>
                edit(row.id, {
                  kind:
                    event.target.value === "remaining"
                      ? "remaining"
                      : "handoff",
                  value: "",
                })
              }
            >
              <option value="handoff">Handoff date</option>
              <option value="remaining">Remaining estimate</option>
            </select>
          </label>
          <label>
            {row.kind === "handoff"
              ? "Hypothetical handoff"
              : "Remaining workdays"}
            <input
              required
              type={row.kind === "handoff" ? "date" : "number"}
              min={row.kind === "handoff" ? graph.asOf : 1}
              max={row.kind === "handoff" ? "9999-12-31" : 3650}
              value={row.value}
              onChange={(event) => edit(row.id, { value: event.target.value })}
            />
          </label>
          {adjustments.length > 1 && (
            <Button
              variant="secondary"
              type="button"
              onClick={() =>
                setAdjustments(adjustments.filter(({ id }) => id !== row.id))
              }
            >
              Remove adjustment {index + 1}
            </Button>
          )}
        </fieldset>
      ))}
      {error && <p role="alert">{error}</p>}
      <div className="planning-actions">
        <Button type="submit" disabled={busy}>
          {busy ? "Calculating…" : "Preview scenario"}
        </Button>
        {adjustments.length < Math.min(tasks.length, 60) && (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              const next = tasks.find(
                ({ id }) => !adjustments.some(({ workId }) => id === workId),
              );
              if (next) setAdjustments([...adjustments, adjustment(next.id)]);
            }}
          >
            Add adjustment
          </Button>
        )}
      </div>
    </form>
  );
}
