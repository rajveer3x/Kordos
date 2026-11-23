import {
  connectorDirectorySchema,
  connectorSavedSchema,
  type Connector,
  type ConnectorCommand,
} from "@kordos/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { AsyncState, Button, StatusLabel } from "../../components/ui";
import { denied, errorMessage, read, request } from "../identity/api";
import { planningRefresh, usePlanning } from "../planning/planning-client";
import { projectPath, workspacePath } from "../workspace/workspace-model";
import "./connectors.css";

const labels = {
  healthy: "Healthy",
  syncing: "Syncing",
  paused: "Paused",
  failed: "Failed",
  disconnected: "Disconnected",
};
const issues = {
  credential_revoked:
    "The provider rejected the credential. The connection owner can reconnect with a valid token.",
  provider_unavailable:
    "The provider could not be reached. Check its availability or run a new sync.",
  invalid_batch:
    "The provider returned an invalid batch. Check the scope at the provider, then run a new sync.",
  scope_unavailable:
    "The scope or project is unavailable. Check project access and the provider grant.",
};
type Destination = { id: string; name: string };
type Mapping = {
  projectId: string;
  scope: string;
  audience: "private" | "project";
};
type Command<T = ConnectorCommand> = T extends ConnectorCommand
  ? Omit<T, "expectedVersion" | "mutationId">
  : never;

function MappingFields({ destinations }: { destinations: Destination[] }) {
  return (
    <div className="planning-form-grid">
      <label>
        Destination project
        <select name="project" required defaultValue="">
          <option value="" disabled>
            Choose a project
          </option>
          {destinations.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Provider scope
        <input
          name="scope"
          required
          maxLength={160}
          placeholder="team/repository"
        />
      </label>
      <label>
        Mirror audience
        <select name="audience" defaultValue="private">
          <option value="private">Connection owner</option>
          <option value="project">
            Project members, when permitted by the provider
          </option>
        </select>
      </label>
    </div>
  );
}

function mappingFields(form: FormData): Mapping {
  return {
    projectId: String(form.get("project")),
    scope: String(form.get("scope")),
    audience: form.get("audience") === "project" ? "project" : "private",
  };
}

function useConnectorMutation(id?: string) {
  const { api, key } = usePlanning();
  const queryClient = useQueryClient();
  const lastRequest = useRef<{ fields: object; mutationId: string } | null>(
    null,
  );
  return useMutation({
    async mutationFn(fields: object) {
      // Retry an unchanged form with the same ID. The credential is sent only in
      // this request and stays out of storage and cache keys.
      const prior = lastRequest.current;
      const mutationId =
        prior && JSON.stringify(prior.fields) === JSON.stringify(fields)
          ? prior.mutationId
          : crypto.randomUUID();
      lastRequest.current = { fields, mutationId };
      return request(api + "/connectors" + (id ? "/" + id : ""), {
        method: id ? "PATCH" : "POST",
        body: { ...fields, mutationId },
        schema: connectorSavedSchema,
      });
    },
    async onSuccess() {
      lastRequest.current = null;
      await queryClient.invalidateQueries({ queryKey: key });
    },
    async onError() {
      await queryClient.invalidateQueries({ queryKey: [...key, "connectors"] });
    },
  });
}

function NewConnection({ destinations }: { destinations: Destination[] }) {
  const save = useConnectorMutation();
  return (
    <details>
      <summary>Connect a fixture source</summary>
      <form
        className="planning-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          save.mutate(
            {
              provider: "fixture",
              label: String(values.get("label")),
              token: String(values.get("token")),
              ...mappingFields(values),
            },
            { onSuccess: () => form.reset() },
          );
        }}
      >
        <div className="planning-form-grid">
          <label>
            Connection name
            <input name="label" required maxLength={120} />
          </label>
          <label>
            Access token
            <input
              name="token"
              type="password"
              autoComplete="off"
              required
              maxLength={8192}
            />
          </label>
        </div>
        <MappingFields destinations={destinations} />
        <div className="planning-actions">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Connecting…" : "Connect source"}
          </Button>
        </div>
        {save.isError && <p role="alert">{errorMessage(save.error)}</p>}
        {save.isSuccess && <p role="status">Connection saved.</p>}
      </form>
    </details>
  );
}

function Connection({
  item,
  destinations,
  enabled,
}: {
  item: Connector;
  destinations: Destination[];
  enabled: boolean;
}) {
  const { workspace } = usePlanning();
  const save = useConnectorMutation(item.id);
  const [confirmation, setConfirmation] = useState<"disconnect" | string>();
  const disconnected = item.status === "disconnected";
  const revoked =
    item.status === "paused" && item.issue === "credential_revoked";
  const submit = (fields: Command, success?: () => void) =>
    save.mutate(
      { ...fields, expectedVersion: item.version },
      { onSuccess: success },
    );
  return (
    <li className="planning-panel glass-panel">
      <div className="planning-heading">
        <h3>{item.label}</h3>
        <StatusLabel
          tone={
            item.status === "healthy"
              ? "confirmed"
              : item.issue
                ? "risk"
                : "neutral"
          }
        >
          {labels[item.status]}
        </StatusLabel>
      </div>
      <p className="planning-help">
        Fixture provider ·{" "}
        {item.lastSuccess ? (
          <>
            Last success{" "}
            <time dateTime={item.lastSuccess}>
              {new Date(item.lastSuccess).toLocaleString()}
            </time>
          </>
        ) : (
          "Awaiting first successful sync"
        )}
      </p>
      {item.issue && <p>{issues[item.issue]}</p>}
      {item.retryAt && (
        <p className="planning-help">
          Next retry{" "}
          <time dateTime={item.retryAt}>
            {new Date(item.retryAt).toLocaleString()}
          </time>
        </p>
      )}
      {item.cleanupPending && (
        <p className="planning-help">Mirror cleanup is queued.</p>
      )}
      {item.mappings.length > 0 && (
        <ul className="connector-rows" aria-label="Scope mappings">
          {item.mappings.map((mapping) => (
            <li key={mapping.id} className="planning-heading">
              <div className="planning-item-copy">
                {mapping.projectId ? (
                  <Link
                    to={workspacePath(
                      projectPath(mapping.projectId, "documents") + "/sources",
                      workspace.id,
                    )}
                  >
                    {mapping.projectName}
                  </Link>
                ) : (
                  <strong>Restricted project</strong>
                )}
                <span>
                  {mapping.scope ? mapping.scope + " · " : ""}
                  {mapping.audience === "private"
                    ? "Connection owner"
                    : "Project audience"}
                </span>
              </div>
              {!disconnected &&
                mapping.projectId &&
                (confirmation === mapping.id ? (
                  <div className="planning-actions">
                    <Button
                      variant="secondary"
                      onClick={() => setConfirmation(undefined)}
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={save.isPending}
                      onClick={() =>
                        submit({ action: "unmap", mappingId: mapping.id }, () =>
                          setConfirmation(undefined),
                        )
                      }
                    >
                      Remove mapping
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="quiet"
                    onClick={() => setConfirmation(mapping.id)}
                  >
                    Remove scope
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {disconnected ? (
        <p className="planning-help">
          Open the project’s external sources to revoke any excerpts that were
          shared there.
        </p>
      ) : (
        <>
          <div className="planning-actions">
            {item.status === "paused" ? (
              !revoked && (
                <Button
                  variant="secondary"
                  disabled={save.isPending}
                  onClick={() => submit({ action: "resume" })}
                >
                  Resume syncing
                </Button>
              )
            ) : (
              <>
                <Button
                  variant="secondary"
                  disabled={save.isPending || item.status === "syncing"}
                  onClick={() => submit({ action: "sync" })}
                >
                  Sync now
                </Button>
                <Button
                  variant="quiet"
                  disabled={save.isPending}
                  onClick={() => submit({ action: "pause" })}
                >
                  Pause syncing
                </Button>
              </>
            )}
            <Button
              variant="quiet"
              disabled={save.isPending}
              onClick={() => setConfirmation("disconnect")}
            >
              Disconnect
            </Button>
          </div>
          {confirmation === "disconnect" && (
            <div className="planning-form">
              <p>
                Disconnecting hides mirrored records and cancels queued work.
                Project excerpts can be revoked separately.
              </p>
              <div className="planning-actions">
                <Button
                  variant="secondary"
                  onClick={() => setConfirmation(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={save.isPending}
                  onClick={() =>
                    submit({ action: "disconnect" }, () =>
                      setConfirmation(undefined),
                    )
                  }
                >
                  Confirm disconnect
                </Button>
              </div>
            </div>
          )}
          {enabled && item.canConfigure && (
            <>
              <details open={revoked || undefined}>
                <summary>Replace access token</summary>
                <form
                  className="planning-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    submit(
                      {
                        action: "reconnect",
                        token: String(new FormData(form).get("token")),
                      },
                      () => form.reset(),
                    );
                  }}
                >
                  <label>
                    New access token
                    <input
                      name="token"
                      type="password"
                      autoComplete="off"
                      required
                      maxLength={8192}
                    />
                  </label>
                  <Button type="submit" disabled={save.isPending}>
                    Reconnect
                  </Button>
                </form>
              </details>
              {destinations.length > 0 && (
                <details>
                  <summary>Add a scope mapping</summary>
                  <form
                    className="planning-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      submit(
                        { action: "map", ...mappingFields(new FormData(form)) },
                        () => form.reset(),
                      );
                    }}
                  >
                    <MappingFields destinations={destinations} />
                    <Button type="submit" disabled={save.isPending}>
                      Add mapping
                    </Button>
                  </form>
                </details>
              )}
            </>
          )}
        </>
      )}
      {save.isError && <p role="alert">{errorMessage(save.error)}</p>}
      {save.isSuccess && <p role="status">Connection updated.</p>}
    </li>
  );
}

export function ConnectorSettings() {
  const { api, key } = usePlanning();
  const query = useQuery({
    queryKey: [...key, "connectors"],
    queryFn: ({ signal }) =>
      read(api + "/connectors", connectorDirectorySchema, signal),
    ...planningRefresh,
    refetchInterval: 2000,
  });
  return (
    <section
      className="planning-panel glass-panel"
      id="connectors"
      aria-labelledby="connectors-title"
    >
      <h2 id="connectors-title">Connectors</h2>
      {query.isPending ? (
        <AsyncState kind="loading" message="Loading connections…" />
      ) : query.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(query.error)
              ? "Connectors are unavailable."
              : "Could not load connections."
          }
          retry={denied(query.error) ? undefined : () => void query.refetch()}
        />
      ) : (
        <>
          {!query.data.enabled ? (
            <p className="planning-help">
              A connector provider must be configured on the server to add a
              connection.
            </p>
          ) : query.data.destinations.length ? (
            <NewConnection destinations={query.data.destinations} />
          ) : (
            <p className="planning-help">
              A project lead can connect a source to an active project.
            </p>
          )}
          {query.data.items.length ? (
            <ul className="connector-list">
              {query.data.items.map((item) => (
                <Connection
                  key={item.id}
                  item={item}
                  destinations={query.data.destinations}
                  enabled={query.data.enabled}
                />
              ))}
            </ul>
          ) : (
            <p className="planning-help">No connections yet.</p>
          )}
        </>
      )}
    </section>
  );
}
