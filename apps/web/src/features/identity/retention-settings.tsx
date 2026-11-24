import {
  retentionDaysSchema,
  retentionPolicySchema,
  type RetentionPolicy,
} from "@kordos/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { AsyncState, Button } from "../../components/ui";
import { ApiError, denied, errorMessage, read, request } from "./api";

const fields = [
  { key: "audioDays", label: "Audio retention", max: 90 },
  { key: "transcriptDays", label: "Transcript retention", max: 3650 },
  { key: "importedDays", label: "Imported source retention", max: 3650 },
  { key: "logDays", label: "Audit detail retention", max: 365 },
] as const;

const progress = [
  { key: "audio", label: "Recordings" },
  { key: "transcripts", label: "Transcript revisions" },
  { key: "imports", label: "Imported revisions" },
  { key: "shares", label: "Revoked shares" },
  { key: "logs", label: "Audit detail redactions" },
] as const;

function PolicyForm({
  policy,
  endpoint,
  saved,
}: {
  policy: RetentionPolicy;
  endpoint: string;
  saved: () => Promise<void>;
}) {
  const [base, setBase] = useState(policy);
  const [draft, setDraft] = useState(() => retentionDaysSchema.parse(policy));
  const [confirm, setConfirm] = useState(false);
  const mutationId = useRef(crypto.randomUUID());
  const save = useMutation({
    mutationFn: () =>
      request(endpoint, {
        method: "PATCH",
        body: {
          ...draft,
          expectedVersion: base.version,
          mutationId: mutationId.current,
        },
      }),
    onSuccess: async () => {
      setConfirm(false);
      await saved();
    },
  });
  const current = retentionPolicySchema.safeParse(
    save.error instanceof ApiError ? save.error.current : undefined,
  );
  const changed = fields.some(({ key }) => draft[key] !== base[key]);
  const reducesRetention = fields.some(({ key }) => draft[key] < base[key]);

  return (
    <form
      className="identity-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (reducesRetention && !confirm) setConfirm(true);
        else save.mutate();
      }}
    >
      {fields.map(({ key, label, max }) => (
        <label key={key}>
          {label} (days)
          <input
            type="number"
            required
            min={1}
            max={max}
            value={Number.isNaN(draft[key]) ? "" : draft[key]}
            onChange={(event) => {
              setDraft({ ...draft, [key]: event.target.valueAsNumber });
              setConfirm(false);
              mutationId.current = crypto.randomUUID();
              save.reset();
            }}
          />
        </label>
      ))}
      {confirm && (
        <p role="status">
          Shortening retention can immediately hide existing data and schedule
          permanent deletion.
        </p>
      )}
      <Button
        type="submit"
        disabled={
          !changed ||
          !retentionDaysSchema.safeParse(draft).success ||
          save.isPending ||
          current.success
        }
      >
        {save.isPending
          ? "Saving…"
          : confirm
            ? "Confirm retention change"
            : "Save retention policy"}
      </Button>
      {confirm && (
        <Button
          type="button"
          variant="quiet"
          onClick={() => setConfirm(false)}
          disabled={save.isPending}
        >
          Cancel
        </Button>
      )}
      {save.error && <p role="alert">{errorMessage(save.error)}</p>}
      {current.success && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setBase(current.data);
            setDraft(retentionDaysSchema.parse(current.data));
            setConfirm(false);
            mutationId.current = crypto.randomUUID();
            save.reset();
          }}
        >
          Load current policy
        </Button>
      )}
    </form>
  );
}

export function RetentionSettings({
  workspaceId,
  actorId,
}: {
  workspaceId: string;
  actorId: string;
}) {
  const client = useQueryClient();
  const endpoint = `/workspaces/${workspaceId}/retention`;
  const key = ["identity", "retention", actorId, workspaceId];
  const [savedVersion, setSavedVersion] = useState<number>();
  const policy = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => read(endpoint, retentionPolicySchema, signal),
    refetchInterval: 5_000,
    gcTime: 0,
  });
  return (
    <section
      className="identity-section glass-panel"
      aria-labelledby="retention-title"
    >
      <h2 id="retention-title">Retention and deletion</h2>
      {policy.isPending ? (
        <AsyncState kind="loading" message="Loading retention settings…" />
      ) : policy.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(policy.error)
              ? "Retention settings are unavailable."
              : "Could not load retention settings."
          }
          retry={() => void policy.refetch()}
        />
      ) : (
        <>
          <p>
            Meeting recording settings can expire audio sooner. Confirmed
            decisions, approved work, and active shares have their own access.
          </p>
          <PolicyForm
            key={savedVersion}
            policy={policy.data}
            endpoint={endpoint}
            saved={async () => {
              const result = await policy.refetch();
              if (result.data) setSavedVersion(result.data.version);
              await client.invalidateQueries({
                queryKey: ["identity", "workspace", actorId, workspaceId],
              });
            }}
          />
          {savedVersion !== undefined && (
            <p role="status">Retention policy saved.</p>
          )}
          <h3>Deletion progress</h3>
          <ul className="membership-list">
            {progress.map(({ key, label }) => (
              <li key={key}>
                {label} · {policy.data.pending[key]} pending ·{" "}
                {policy.data.removed[key]} finished
              </li>
            ))}
          </ul>
          <p>
            {policy.data.checkedAt
              ? `Last checked ${new Date(policy.data.checkedAt).toLocaleString()}.`
              : "Waiting for the next retention check."}{" "}
            The deployment backup window is up to 30 days.
          </p>
        </>
      )}
    </section>
  );
}
