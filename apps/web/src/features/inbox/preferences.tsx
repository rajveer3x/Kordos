import {
  inboxModeSchema,
  inboxPreferencesSchema,
  inboxReasonSchema,
  type InboxPreferences,
} from "@kordos/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AsyncState, Button } from "../../components/ui";
import { ApiError, denied, errorMessage, read, request } from "../identity/api";
import { planningRefresh, usePlanning } from "../planning/planning-client";
import { notificationLabels } from "./inbox";

const modeLabels = {
  in_app: "In-app only",
  email: "Immediate email",
  digest: "Daily email digest",
};

function PreferenceForm({ value }: { value: InboxPreferences }) {
  const { api, key } = usePlanning();
  const client = useQueryClient();
  const [draft, setDraft] = useState<InboxPreferences>();
  const [invalid, setInvalid] = useState("");
  const preferences = draft ?? value;
  const save = useMutation({
    mutationFn: (body: InboxPreferences) =>
      request(api + "/notification-preferences", {
        method: "PATCH",
        body,
        schema: inboxPreferencesSchema,
      }),
    onSuccess: (saved) => {
      if (saved)
        client.setQueryData([...key, "notification-preferences"], saved);
      setDraft(undefined);
    },
  });

  function change(fields: Partial<InboxPreferences>) {
    setDraft({ ...preferences, ...fields });
    setInvalid("");
    save.reset();
  }

  const conflict = inboxPreferencesSchema.safeParse(
    save.error instanceof ApiError && save.error.status === 409
      ? save.error.current
      : null,
  );
  const quiet = preferences.quietHours;

  return (
    <form
      className="planning-form"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = inboxPreferencesSchema.safeParse(preferences);
        if (parsed.success) save.mutate(parsed.data);
        else
          setInvalid(
            parsed.error.issues[0]?.message ??
              "Check the notification settings.",
          );
      }}
    >
      <fieldset disabled={save.isPending}>
        <legend>Schedule</legend>
        <div className="planning-form-grid">
          <label>
            Delivery timezone
            <input
              required
              value={preferences.timeZone}
              placeholder="Asia/Kolkata"
              onChange={(event) => change({ timeZone: event.target.value })}
            />
          </label>
          <label>
            Reminder days before due
            <input
              required
              type="number"
              min={0}
              max={30}
              value={
                Number.isNaN(preferences.reminderDays)
                  ? ""
                  : preferences.reminderDays
              }
              onChange={(event) =>
                change({ reminderDays: event.target.valueAsNumber })
              }
            />
          </label>
          <label>
            Days before overdue escalation
            <input
              required
              type="number"
              min={1}
              max={30}
              value={
                Number.isNaN(preferences.escalationDays)
                  ? ""
                  : preferences.escalationDays
              }
              onChange={(event) =>
                change({ escalationDays: event.target.valueAsNumber })
              }
            />
          </label>
        </div>
        <label className="planning-choice">
          <input
            type="checkbox"
            checked={!!quiet}
            onChange={(event) =>
              change({
                quietHours: event.target.checked
                  ? { start: "22:00", end: "07:00" }
                  : null,
              })
            }
          />
          Enable quiet hours
        </label>
        {quiet && (
          <div className="planning-form-grid">
            <label>
              Quiet hours start
              <input
                type="time"
                required
                value={quiet.start}
                onChange={(event) =>
                  change({
                    quietHours: { ...quiet, start: event.target.value },
                  })
                }
              />
            </label>
            <label>
              Quiet hours end
              <input
                type="time"
                required
                value={quiet.end}
                onChange={(event) =>
                  change({ quietHours: { ...quiet, end: event.target.value } })
                }
              />
            </label>
          </div>
        )}
        <p className="planning-help">
          Quiet hours follow your delivery timezone. Deadline dates follow the
          project timezone.
        </p>
      </fieldset>
      <fieldset disabled={save.isPending}>
        <legend>Delivery by notification type</legend>
        <p className="planning-help">
          Every notification appears in the inbox. Daily digests are scheduled
          for 08:00 in your delivery timezone.
        </p>
        <div className="planning-form-grid">
          {inboxReasonSchema.options.map((reason) => (
            <label key={reason}>
              {notificationLabels[reason]}
              <select
                value={preferences.channels[reason]}
                onChange={(event) => {
                  const mode = inboxModeSchema.parse(event.target.value);
                  change({
                    channels: { ...preferences.channels, [reason]: mode },
                  });
                }}
              >
                {inboxModeSchema.options.map((mode) => (
                  <option key={mode} value={mode}>
                    {modeLabels[mode]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </fieldset>
      {invalid && <p role="alert">{invalid}</p>}
      {save.isError && <p role="alert">{errorMessage(save.error)}</p>}
      {save.isSuccess && <p role="status">Notification preferences saved.</p>}
      <div className="planning-actions">
        <Button type="submit" disabled={!draft || save.isPending}>
          {save.isPending ? "Saving…" : "Save notification preferences"}
        </Button>
        {conflict.success && (
          <Button
            variant="secondary"
            onClick={() => {
              client.setQueryData(
                [...key, "notification-preferences"],
                conflict.data,
              );
              setDraft(undefined);
              save.reset();
            }}
          >
            Load saved preferences
          </Button>
        )}
      </div>
    </form>
  );
}

export function NotificationPreferences() {
  const { api, key } = usePlanning();
  const result = useQuery({
    queryKey: [...key, "notification-preferences"],
    queryFn: ({ signal }) =>
      read(api + "/notification-preferences", inboxPreferencesSchema, signal),
    ...planningRefresh,
  });

  return (
    <section
      className="glass-panel planning-panel"
      id="notifications"
      aria-labelledby="notification-settings"
    >
      <h2 id="notification-settings">Notifications</h2>
      {result.isPending ? (
        <AsyncState
          kind="loading"
          message="Loading notification preferences…"
        />
      ) : result.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(result.error)
              ? "Notification preferences are unavailable."
              : "Could not load notification preferences."
          }
          retry={denied(result.error) ? undefined : () => void result.refetch()}
        />
      ) : (
        <PreferenceForm value={result.data} />
      )}
    </section>
  );
}
