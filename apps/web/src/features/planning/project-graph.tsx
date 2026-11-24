import { idSchema, scenarioSchema } from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { AsyncState, Button } from "../../components/ui";
import { denied, errorMessage, read, request } from "../identity/api";
import { ProjectDate } from "../workspace/project-view";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import { DependencyEditor } from "./dependency-editor";
import { useForecast } from "./forecast-client";
import { ForecastScenario } from "./forecast-scenario";
import {
  planningRefresh,
  useLiveProject,
  usePlanning,
} from "./planning-client";
import { GraphContent } from "./graph-content";
import { graphReturnSchema, graphRowId } from "./graph-navigation";
import "./forecast.css";

export default function ProjectGraphPage() {
  const { project, details } = useLiveProject();
  const { workspace } = usePlanning();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const scenarioId = idSchema.safeParse(params.get("scenario")).data;
  const selection = idSchema.safeParse(params.get("focus")).data;
  const view = params.get("view") === "list" ? "list" : "canvas";
  const { query, path, key } = useForecast(project.id);
  const scenarioPath = `${path}/scenarios`;
  const saved = useQuery({
    queryKey: [...key, scenarioId],
    queryFn: ({ signal }) =>
      read(`${scenarioPath}/${scenarioId}`, scenarioSchema, signal),
    enabled: !!scenarioId && !!query.data && !denied(query.error),
    ...planningRefresh,
  });
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState("");
  const preview = useRef<HTMLDivElement>(null);
  const focusPreview = useRef<string>(null);
  const graphHeading = useRef<HTMLHeadingElement>(null);
  const scenarioHeading = useRef<HTMLHeadingElement>(null);
  const focusedReturn = useRef<string>(null);

  useEffect(() => {
    const target = graphReturnSchema.safeParse(location.state?.graphFocus).data;
    if (!target || !query.data || focusedReturn.current === location.key)
      return;
    if (target.row === "impact" && saved.isPending) return;
    const frame = requestAnimationFrame(() => {
      const link = document.getElementById(
        graphRowId(target.row, target.itemId),
      );
      (link ?? graphHeading.current)?.focus();
      focusedReturn.current = location.key;
    });
    return () => cancelAnimationFrame(frame);
  }, [location.key, location.state, query.data, saved.isPending]);

  useEffect(() => {
    if (!scenarioId || focusPreview.current !== scenarioId) return;
    preview.current?.focus();
    focusPreview.current = null;
  }, [scenarioId]);

  function setParam(name: string, value?: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    });
  }

  function close() {
    setParam("scenario");
    (scenarioHeading.current ?? graphHeading.current)?.focus();
  }

  async function discard() {
    setDiscarding(true);
    setDiscardError("");
    try {
      await request(`${scenarioPath}/${scenarioId}`, { method: "DELETE" });
      close();
    } catch (failure) {
      if (denied(failure)) close();
      else setDiscardError(errorMessage(failure));
    } finally {
      setDiscarding(false);
    }
  }

  if (denied(query.error))
    return <AsyncState kind="error" message="This graph is unavailable." />;
  if (query.isPending)
    return <AsyncState kind="loading" message="Loading dependency graph…" />;
  const graph = query.data;
  if (!graph)
    return (
      <AsyncState
        kind="error"
        message="Could not load this graph."
        retry={() => void query.refetch()}
      />
    );

  const scenario = denied(saved.error) ? undefined : saved.data;
  const stale =
    !!scenario &&
    (scenario.inputRevision !== graph.inputRevision ||
      scenario.asOf !== graph.asOf);
  const current = stale ? undefined : scenario;
  const canEdit = details.role !== "viewer" && !details.archived;
  const tasks = graph.items.filter(
    ({ kind, status }) => kind === "task" && status !== "done",
  );
  const workPath = (id: string) =>
    workspacePath(`${projectPath(project.id, "work")}/${id}`, workspace.id);

  return (
    <>
      <title>{`Dependency graph · ${project.name} · Kordos`}</title>
      <section
        className="planning-panel glass-panel forecast-panel"
        aria-labelledby="forecast-heading"
      >
        <div className="planning-heading">
          <h2 id="forecast-heading" ref={graphHeading} tabIndex={-1}>
            Dependencies and forecast
          </h2>
          {graph.items.length > 0 && (
            <div
              className="planning-actions"
              role="group"
              aria-label="Graph view"
            >
              <Button
                variant="secondary"
                aria-pressed={view === "canvas"}
                onClick={() => setParam("view")}
              >
                Canvas
              </Button>
              <Button
                variant="secondary"
                aria-pressed={view === "list"}
                onClick={() => setParam("view", "list")}
              >
                Ordered list
              </Button>
            </div>
          )}
        </div>
        {query.isError && (
          <AsyncState
            kind="error"
            message="Could not refresh the forecast."
            retry={() => void query.refetch()}
          />
        )}
        {scenarioId && (
          <div className="forecast-preview-status" ref={preview} tabIndex={-1}>
            {current && <p role="status">Private scenario preview</p>}
            {stale && (
              <p role="status">
                The baseline changed. Preview again using the latest forecast
                inputs.
              </p>
            )}
            {saved.isPending && <p role="status">Loading scenario…</p>}
            {denied(saved.error) && (
              <p role="status">This scenario is unavailable.</p>
            )}
            {saved.isError && !denied(saved.error) && (
              <AsyncState
                kind="error"
                message="Could not load the scenario."
                retry={() => void saved.refetch()}
              />
            )}
            <div className="planning-actions">
              <Button variant="secondary" disabled={discarding} onClick={close}>
                Close scenario
              </Button>
              {scenario && (
                <Button
                  variant="secondary"
                  disabled={discarding}
                  onClick={() => void discard()}
                >
                  Reset preview
                </Button>
              )}
            </div>
            {discardError && <p role="alert">{discardError}</p>}
          </div>
        )}
        {graph.items.length === 0 ? (
          <p className="empty-message">
            Add a task or milestone to start planning dependencies.
          </p>
        ) : (
          <GraphContent
            graph={graph}
            scenario={current}
            {...{ view, selection, workPath }}
            returnSearch={location.search}
            onSelect={(id) => setParam("focus", id)}
          />
        )}
        <details className="forecast-inputs">
          <summary>Forecast inputs</summary>
          <dl className="forecast-values">
            <div>
              <dt>As of</dt>
              <dd>
                <ProjectDate date={graph.asOf} />
              </dd>
            </div>
            <div>
              <dt>Project time zone</dt>
              <dd>{graph.calendar.timeZone}</dd>
            </div>
            <div>
              <dt>Graph version</dt>
              <dd>{graph.graphVersion}</dd>
            </div>
            <div>
              <dt>Input revision</dt>
              <dd>
                <code>{graph.inputRevision}</code>
              </dd>
            </div>
          </dl>
          <p>
            Successors start on the next working day after handoff. Milestone
            forecasts are at the start of the working day. Forecasts use the
            project calendar, actual completion dates, and remaining workday
            estimates. Missing estimates make downstream dates uncertain.
          </p>
        </details>
      </section>
      {canEdit && graph.items.length >= 2 && (
        <section
          className="planning-panel glass-panel forecast-panel"
          aria-labelledby="edit-dependencies"
        >
          <h2 id="edit-dependencies">Edit dependencies</h2>
          <DependencyEditor
            key={project.id}
            {...{ graph, selected: selection, path }}
            refresh={() => void query.refetch()}
          />
        </section>
      )}
      {canEdit && tasks.length > 0 && (
        <section
          className="planning-panel glass-panel forecast-panel"
          aria-labelledby="forecast-scenario"
        >
          <h2 id="forecast-scenario" ref={scenarioHeading} tabIndex={-1}>
            What-if scenario
          </h2>
          <ForecastScenario
            key={project.id}
            graph={graph}
            tasks={tasks}
            selected={selection}
            path={scenarioPath}
            queryKey={key}
            onPreview={(id) => {
              if (id === scenarioId) preview.current?.focus();
              else {
                focusPreview.current = id;
                setParam("scenario", id);
              }
            }}
            refresh={() => void query.refetch()}
          />
        </section>
      )}
    </>
  );
}
