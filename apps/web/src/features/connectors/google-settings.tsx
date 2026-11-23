import {
  connectorSavedSchema,
  googleAuthorizationSchema,
  googleChoicesSchema,
  googleIntentSchema,
  type GoogleProvider,
} from "@kordos/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { AsyncState, Button } from "../../components/ui";
import { errorMessage, read, request } from "../identity/api";
import { usePlanning } from "../planning/planning-client";

export function GoogleConnect({
  provider,
  reconnect,
}: {
  provider: GoogleProvider;
  reconnect?: { id: string; version: number };
}) {
  const { api } = usePlanning();
  const name = provider === "calendar" ? "Google Calendar" : "Gmail";
  const start = useMutation({
    mutationFn: () =>
      request(api + "/connectors/google/start", {
        method: "POST",
        schema: googleAuthorizationSchema,
        body: { provider, reconnect },
      }),
    onSuccess: (result) => {
      if (result) window.location.assign(result.url);
    },
  });
  return (
    <>
      <Button
        variant="secondary"
        disabled={start.isPending}
        onClick={() => start.mutate()}
      >
        {start.isPending
          ? "Opening Google…"
          : `${reconnect ? "Reconnect" : "Connect"} ${name}`}
      </Button>
      {start.isError && <p role="alert">{errorMessage(start.error)}</p>}
    </>
  );
}

export function GoogleScopePicker({
  destinations,
}: {
  destinations: { id: string; name: string }[];
}) {
  const { api, key } = usePlanning();
  const client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const intent = googleIntentSchema.safeParse(
    search.get("googleSelection"),
  ).data;
  const error = search.get("googleError");
  const path = api + "/connectors/google/" + intent;
  const choices = useQuery({
    queryKey: [...key, "google-scope-selection", intent],
    queryFn: ({ signal }) => read(path, googleChoicesSchema, signal),
    enabled: !!intent,
    retry: false,
  });
  const status = choices.status;
  useEffect(() => {
    if (error || (intent && status !== "pending"))
      (alert.current ?? heading.current)?.focus();
  }, [error, intent, status]);
  const close = () => {
    const next = new URLSearchParams(search);
    next.delete("googleSelection");
    next.delete("googleError");
    setSearch(next, { replace: true });
  };
  const save = useMutation({
    mutationFn: (body: { projectId: string; scope: string }) =>
      request(path, { method: "POST", schema: connectorSavedSchema, body }),
    async onSuccess() {
      close();
      await client.invalidateQueries({ queryKey: key });
    },
  });
  if (error) {
    return (
      <div className="planning-actions">
        <p role="alert" ref={alert} tabIndex={-1}>
          {error === "consent"
            ? "Google authorization was canceled."
            : error === "reconnect"
              ? "Reconnect with the original Google account and current connection settings."
              : "Google authorization could not be completed. Start the connection again."}
        </p>
        <Button variant="quiet" onClick={close}>
          Dismiss
        </Button>
      </div>
    );
  }
  if (!intent)
    return save.isSuccess ? <p role="status">Connection saved.</p> : null;
  if (choices.isPending)
    return <AsyncState kind="loading" message="Loading your Google sources…" />;
  if (choices.isError) {
    return (
      <div className="planning-actions">
        <p role="alert" ref={alert} tabIndex={-1}>
          The Google selection is unavailable. Start the connection again.
        </p>
        <Button variant="quiet" onClick={close}>
          Dismiss
        </Button>
      </div>
    );
  }
  const calendar = choices.data.provider === "calendar";
  return (
    <form
      className="planning-form"
      aria-labelledby="google-scope-heading"
      onSubmit={(event) => {
        event.preventDefault();
        const input = new FormData(event.currentTarget);
        save.mutate({
          projectId: String(input.get("project")),
          scope: String(input.get("scope")),
        });
      }}
    >
      <h3 id="google-scope-heading" ref={heading} tabIndex={-1}>
        {calendar ? "Choose a calendar" : "Choose a Gmail project label"}
      </h3>
      <p className="planning-help">
        {calendar
          ? "You can preview events and add individual events to project meetings."
          : "You can preview individual messages and share an exact excerpt with the project."}
      </p>
      {choices.data.scopes.length && destinations.length ? (
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
            {calendar ? "Calendar" : "Gmail label"}
            <select name="scope" required defaultValue="">
              <option value="" disabled>
                {calendar ? "Choose a calendar" : "Choose a label"}
              </option>
              {choices.data.scopes.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <p>
          {calendar
            ? "An eligible calendar and destination project are required."
            : "Create a project label in Gmail and connect again."}
        </p>
      )}
      <div className="planning-actions">
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
        {!!choices.data.scopes.length && !!destinations.length && (
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Connecting…" : "Connect selected source"}
          </Button>
        )}
      </div>
      {save.isError && <p role="alert">{errorMessage(save.error)}</p>}
    </form>
  );
}
