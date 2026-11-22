import {
  foundationJobIdSchema,
  foundationJobSchema,
  readinessSchema,
} from "@kordos/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Brand } from "../../components/brand";
import { Button, PageHeading, StatusLabel } from "../../components/ui";
import "./health.css";

const dependencies = [
  ["postgres", "PostgreSQL"],
  ["redis", "Redis"],
  ["storage", "Private storage"],
] as const;

const jobKey = (id: string | undefined) => ["foundation-job", id] as const;

export function HealthPage() {
  const [params, setParams] = useSearchParams();
  const linkedId = foundationJobIdSchema.safeParse(params.get("job"));
  const id = linkedId.data;
  const queryClient = useQueryClient();

  const readiness = useQuery({
    queryKey: ["foundation-readiness"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/health/ready", { signal });
      if (!response.ok && response.status !== 503)
        throw new Error("Health check failed.");
      return readinessSchema.parse(await response.json());
    },
    refetchInterval: 1500,
  });
  const job = useQuery({
    queryKey: jobKey(id),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/foundation/jobs/${id}`, { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Job status is unavailable.");
      return foundationJobSchema.parse(await response.json());
    },
    refetchInterval: ({ state }) => {
      return state.data === null || state.data?.status === "completed"
        ? false
        : 1000;
    },
  });
  const submission = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await fetch("/api/foundation/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jobId }),
      });
      if (response.status === 404)
        throw new Error("Test jobs are disabled on this API.");
      if (!response.ok)
        throw new Error("Could not submit the test job. Try again.");
      return foundationJobSchema.parse(await response.json());
    },
    onSuccess: (record) => {
      queryClient.setQueryData(jobKey(record.id), record);
      setParams({ job: record.id }, { replace: true });
    },
  });

  const health = readiness.isError ? undefined : readiness.data;
  const status =
    health?.status ?? (readiness.isError ? "unavailable" : "checking");
  const statusLabels = {
    ready: "Ready",
    degraded: "Degraded",
    unavailable: "API unavailable",
    checking: "Checking",
  };
  const statusTones = {
    ready: "confirmed",
    degraded: "risk",
    unavailable: "risk",
    checking: "neutral",
  } as const;
  const currentJob =
    submission.isPending || submission.isError ? undefined : job.data;

  return (
    <div className="health-page">
      <title>Workspace health · Kordos</title>
      <header className="health-header">
        <div className="health-container">
          <Brand />
        </div>
      </header>
      <main className="health-container">
        <PageHeading title="Workspace health" />

        <section
          aria-labelledby="services-heading"
          className="health-panel glass-panel"
        >
          <div className="health-section-heading">
            <h2 id="services-heading">Services</h2>
            <StatusLabel tone={statusTones[status]} announce>
              {statusLabels[status]}
            </StatusLabel>
          </div>
          <dl className="checks">
            {dependencies.map(([key, label]) => {
              const check = health?.checks[key];
              return (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd data-health={check}>
                    {check === "up"
                      ? "Available"
                      : check === "down"
                        ? "Unavailable"
                        : "Unknown"}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>

        <section
          aria-labelledby="job-heading"
          className="health-panel glass-panel"
        >
          <h2 id="job-heading">Worker test</h2>
          <p>
            Run a synthetic job and check that the worker records its result in
            PostgreSQL.
          </p>
          <Button
            disabled={
              submission.isPending ||
              Boolean(id && job.isPending) ||
              currentJob?.status === "pending"
            }
            onClick={() =>
              submission.mutate(
                submission.isError && submission.variables
                  ? submission.variables
                  : crypto.randomUUID(),
              )
            }
          >
            {submission.isError ? "Retry test job" : "Run test job"}
          </Button>
          <div role="status" className="job-result">
            {submission.isPending && <p>Submitting job…</p>}
            {submission.isError && <p>{submission.error.message}</p>}
            {!submission.isError && !submission.isPending && (
              <>
                {id && job.isPending && <p>Checking job status…</p>}
                {job.isError && (
                  <p>Job status is unavailable. Checking again…</p>
                )}
                {currentJob === null && <p>Test job not found.</p>}
                {currentJob?.status === "pending" && (
                  <p>Pending. Waiting for the worker.</p>
                )}
                {currentJob?.status === "completed" && (
                  <p>Completed. Result recorded in PostgreSQL.</p>
                )}
                {currentJob && <code>{currentJob.id}</code>}
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
