import { cyclePathSchema, type ProjectGraph } from "@kordos/contracts";
import { useState } from "react";
import { Button } from "../../components/ui";
import { edgeKey } from "./dependency-canvas";
import { usePlanningCommand } from "./planning-client";

export function DependencyEditor({
  graph,
  selected,
  path,
  refresh,
}: {
  graph: ProjectGraph;
  selected: string | undefined;
  path: string;
  refresh: () => void;
}) {
  const [predecessor, setPredecessor] = useState("");
  const [successor, setSuccessor] = useState(selected ?? "");
  const command = usePlanningCommand();
  const cycle = cyclePathSchema.safeParse(command.error?.current).data;
  function change(
    action: "add" | "remove",
    predecessorId: string,
    successorId: string,
  ) {
    void command.save(
      `${path}/dependencies`,
      "POST",
      {
        action,
        predecessorId,
        successorId,
        expectedVersion: graph.graphVersion,
      },
      () => {},
      action === "add" ? "Dependency added." : "Dependency removed.",
    );
  }
  return (
    <div className="forecast-form">
      <form
        className="planning-form forecast-form"
        onSubmit={(event) => {
          event.preventDefault();
          change("add", predecessor, successor);
        }}
      >
        <div className="planning-form-grid">
          <label>
            Predecessor
            <select
              required
              value={predecessor}
              onChange={(event) => setPredecessor(event.target.value)}
            >
              <option value="">Choose an item</option>
              {graph.items.map(({ id, title }) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Successor
            <select
              required
              value={successor}
              onChange={(event) => setSuccessor(event.target.value)}
            >
              <option value="">Choose an item</option>
              {graph.items.map(({ id, title }) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <Button type="submit" disabled={command.busy}>
            Add dependency
          </Button>
        </div>
      </form>
      <div aria-live="polite">{command.notice}</div>
      {command.error && (
        <div role="alert" className="forecast-error">
          <p>{command.error.message}</p>
          {cycle ? (
            <ol className="forecast-cycle" aria-label="Conflicting path">
              {cycle.path.map(({ id, title }, index) => (
                <li key={`${id}-${index}`}>{title}</li>
              ))}
            </ol>
          ) : (
            !!command.error.current && (
              <Button
                variant="secondary"
                onClick={() => {
                  refresh();
                  command.clearError();
                }}
              >
                Refresh graph
              </Button>
            )
          )}
        </div>
      )}
      {graph.edges.length > 0 && (
        <details>
          <summary>Remove a dependency</summary>
          <ul className="forecast-dependencies">
            {graph.edges.map((edge) => {
              const { predecessorId, successorId } = edge;
              const predecessorTitle = graph.items.find(
                ({ id }) => id === predecessorId,
              )!.title;
              const successorTitle = graph.items.find(
                ({ id }) => id === successorId,
              )!.title;
              return (
                <li key={edgeKey(edge)}>
                  <span>
                    {predecessorTitle} → {successorTitle}
                  </span>
                  <Button
                    variant="secondary"
                    aria-label={`Remove dependency from ${predecessorTitle} to ${successorTitle}`}
                    disabled={command.busy}
                    onClick={() => change("remove", predecessorId, successorId)}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
