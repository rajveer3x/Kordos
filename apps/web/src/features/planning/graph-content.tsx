import type {
  NodeForecast,
  ProjectGraph,
  Scenario,
  ScheduleItem,
} from "@kordos/contracts";
import { Link } from "react-router";
import { StatusLabel } from "../../components/ui";
import { ProjectDate } from "../workspace/project-view";
import { DependencyCanvas, edgeKey } from "./dependency-canvas";
import { graphRowId } from "./graph-navigation";

function ForecastDate({ forecast }: { forecast: NodeForecast }) {
  return (
    <>
      <ProjectDate date={forecast.finish ?? undefined} />
      {forecast.provisional && (
        <span className="forecast-note"> · Uncertain</span>
      )}
    </>
  );
}

function MilestoneStatus({
  item,
  forecast,
}: {
  item: ScheduleItem;
  forecast: NodeForecast;
}) {
  if (item.completedAt)
    return <StatusLabel tone="confirmed">Completed</StatusLabel>;
  if (forecast.provisional) return <StatusLabel>Uncertain</StatusLabel>;
  if (!item.commitment || !forecast.finish)
    return <StatusLabel>No commitment</StatusLabel>;
  return forecast.finish > item.commitment ? (
    <StatusLabel tone="risk">At risk</StatusLabel>
  ) : (
    <StatusLabel tone="confirmed">On track</StatusLabel>
  );
}

export function GraphContent({
  graph,
  scenario,
  selection,
  view,
  onSelect,
  workPath,
  returnSearch,
}: {
  graph: ProjectGraph;
  scenario: Scenario | undefined;
  selection: string | undefined;
  view: "canvas" | "list";
  onSelect: (id: string) => void;
  workPath: (id: string) => string;
  returnSearch: string;
}) {
  const items = new Map(graph.items.map((item) => [item.id, item]));
  const forecast = scenario?.forecast ?? graph.forecast;
  const baseline = new Map(graph.forecast.map((node) => [node.id, node]));
  const affected = new Set(scenario?.affectedIds);
  const path = new Set(scenario?.affectedEdges.map(edgeKey));
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const parents = incoming.get(edge.successorId) ?? [];
    parents.push(edge.predecessorId);
    incoming.set(edge.successorId, parents);
  }
  const selectedItem = selection ? items.get(selection) : undefined;
  const selectedForecast = forecast.find(({ id }) => id === selection);
  const milestones = forecast.filter(
    ({ id }) => items.get(id)?.kind === "milestone",
  );
  const returnState = (row: "impact" | "selection", itemId: string) => ({
    graphReturn: { search: returnSearch, itemId, row },
  });

  return (
    <>
      {milestones.length > 0 && (
        <section
          aria-label="Milestone forecasts"
          className="forecast-milestones"
        >
          {milestones.map((node) => {
            const item = items.get(node.id)!;
            return (
              <article key={node.id} className="forecast-milestone">
                <h3>{item.title}</h3>
                <MilestoneStatus item={item} forecast={node} />
                <dl className="forecast-values">
                  <div>
                    <dt>Committed</dt>
                    <dd>
                      <ProjectDate date={item.commitment ?? undefined} />
                    </dd>
                  </div>
                  <div>
                    <dt>{item.completedAt ? "Completed" : "Forecast"}</dt>
                    <dd>
                      <ForecastDate forecast={baseline.get(node.id)!} />
                    </dd>
                  </div>
                  {scenario && (
                    <div>
                      <dt>Scenario</dt>
                      <dd>
                        <ForecastDate forecast={node} />
                      </dd>
                    </div>
                  )}
                </dl>
              </article>
            );
          })}
        </section>
      )}
      {scenario && (
        <section className="forecast-impact" aria-label="Affected path">
          <h3>Affected path</h3>
          <dl className="forecast-values">
            {scenario.changes.map((change) => (
              <div key={change.workId}>
                <dt>{items.get(change.workId)!.title}</dt>
                <dd>
                  {change.kind === "handoff" ? (
                    <>
                      Handoff <ProjectDate date={change.finish} />
                    </>
                  ) : (
                    <>
                      {change.days} remaining{" "}
                      {change.days === 1 ? "workday" : "workdays"}
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <ol className="forecast-list">
            {forecast
              .filter(({ id }) => affected.has(id))
              .map((node) => {
                const item = items.get(node.id)!;
                const parents = (incoming.get(node.id) ?? []).filter(
                  (predecessorId) =>
                    path.has(edgeKey({ predecessorId, successorId: node.id })),
                );
                return (
                  <li key={node.id}>
                    <Link
                      to={workPath(node.id)}
                      id={graphRowId("impact", node.id)}
                      state={returnState("impact", node.id)}
                    >
                      {item.title}
                    </Link>
                    <span>{item.owner?.name ?? "Unassigned"}</span>
                    <span>
                      <ForecastDate forecast={baseline.get(node.id)!} /> →{" "}
                      <ForecastDate forecast={node} />
                    </span>
                    {parents.length > 0 && (
                      <span>
                        After{" "}
                        {parents.map((id) => items.get(id)!.title).join(", ")}
                      </span>
                    )}
                  </li>
                );
              })}
          </ol>
        </section>
      )}
      {view === "canvas" ? (
        <DependencyCanvas
          {...{
            items,
            forecast,
            edges: graph.edges,
            selection,
            affected,
            path,
            onSelect,
          }}
        />
      ) : (
        <ol className="forecast-list" aria-label="Work in dependency order">
          {forecast.map((node) => {
            const item = items.get(node.id)!;
            const parents = incoming.get(node.id) ?? [];
            return (
              <li key={node.id} data-affected={affected.has(node.id)}>
                <button
                  className="forecast-select"
                  type="button"
                  aria-pressed={selection === node.id}
                  onClick={() => onSelect(node.id)}
                >
                  {item.title}
                </button>
                <span>{item.owner?.name ?? "Unassigned"}</span>
                <span>
                  <ForecastDate forecast={node} />
                </span>
                {affected.has(node.id) && <span>Affected</span>}
                {parents.length > 0 && (
                  <span>
                    After {parents.map((id) => items.get(id)!.title).join(", ")}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {selectedItem && selectedForecast && (
        <section
          className="forecast-inspector"
          aria-label="Selected work"
          aria-live="polite"
        >
          <h3>
            <Link
              to={workPath(selectedItem.id)}
              id={graphRowId("selection", selectedItem.id)}
              state={returnState("selection", selectedItem.id)}
            >
              {selectedItem.title}
            </Link>
          </h3>
          <dl className="forecast-values">
            <div>
              <dt>Owner</dt>
              <dd>{selectedItem.owner?.name ?? "Unassigned"}</dd>
            </div>
            <div>
              <dt>
                {selectedItem.completedAt ? "Completed" : "Forecast finish"}
              </dt>
              <dd>
                <ForecastDate forecast={selectedForecast} />
              </dd>
            </div>
            <div>
              <dt>Forecast start</dt>
              <dd>
                <ProjectDate date={selectedForecast.start ?? undefined} />
              </dd>
            </div>
            <div>
              <dt>Slack</dt>
              <dd>
                {selectedForecast.slackDays === null
                  ? "Unavailable"
                  : `${selectedForecast.slackDays} workdays`}
              </dd>
            </div>
          </dl>
          <p>
            Predecessors{" "}
            {incoming
              .get(selectedItem.id)
              ?.map((id) => items.get(id)!.title)
              .join(", ") || "None"}
          </p>
        </section>
      )}
    </>
  );
}
