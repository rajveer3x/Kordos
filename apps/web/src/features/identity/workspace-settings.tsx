import {
  createInvitationSchema,
  invitationSchema,
  membersResponseSchema,
  workspaceRoleSchema,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@kordos/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AsyncState, Button, PageHeading } from "../../components/ui";
import { ConnectorSettings } from "../connectors/connector-settings";
import { NotificationPreferences } from "../inbox/preferences";
import { SignOut } from "./access-pages";
import { denied, errorMessage, read, request } from "./api";

const labels: Record<WorkspaceRole, string> = {
  viewer: "Viewer",
  contributor: "Contributor",
  admin: "Administrator",
};

function RoleOptions() {
  return workspaceRoleSchema.options.map((role) => (
    <option key={role} value={role}>
      {labels[role]}
    </option>
  ));
}

function InvitationForm({
  workspaceId,
  timeZone,
}: {
  workspaceId: string;
  timeZone: string;
}) {
  const [validationError, setValidationError] = useState("");
  const [copied, setCopied] = useState(false);
  const invite = useMutation({
    mutationFn: (body: { email: string; role: WorkspaceRole }) =>
      request(`/workspaces/${workspaceId}/invitations`, {
        method: "POST",
        body,
        schema: invitationSchema,
      }),
  });
  const link =
    invite.data &&
    new URL(`/join#${invite.data.token}`, window.location.origin).href;
  const expiresAt =
    invite.data &&
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(invite.data.expiresAt));

  return (
    <section
      className="identity-section glass-panel"
      aria-labelledby="invite-title"
    >
      <h2 id="invite-title">Invite a member</h2>
      <form
        className="identity-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const parsed = createInvitationSchema.safeParse({
            email: data.get("email"),
            role: data.get("role"),
          });
          if (!parsed.success) {
            setValidationError("Enter a valid email address and role.");
            return;
          }
          setCopied(false);
          setValidationError("");
          invite.mutate(parsed.data);
        }}
      >
        <label>
          Email address
          <input name="email" type="email" required maxLength={254} />
        </label>
        <label>
          Invitation role
          <select name="role">
            <RoleOptions />
          </select>
        </label>
        <Button type="submit" disabled={invite.isPending}>
          {invite.isPending ? "Creating invitation…" : "Create invitation"}
        </Button>
        {(validationError || invite.error) && (
          <p role="alert">{validationError || errorMessage(invite.error)}</p>
        )}
      </form>
      {link && (
        <div className="invitation-result">
          <p role="status">
            {copied
              ? "Invitation link copied."
              : `Share this link with the invitee. It expires ${expiresAt} (${timeZone}).`}
          </p>
          <label>
            Invitation link
            <input
              readOnly
              value={link}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard
                .writeText(link)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            Copy invitation link
          </Button>
        </div>
      )}
    </section>
  );
}

function MemberRow({
  member,
  workspaceId,
  actorId,
}: {
  member: WorkspaceMember;
  workspaceId: string;
  actorId: string;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<WorkspaceRole>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const name = member.id === actorId ? `${member.name} (you)` : member.name;
  const mutation = useMutation({
    mutationFn: (role: WorkspaceRole | null) =>
      request(`/workspaces/${workspaceId}/members/${member.id}`, {
        method: "PATCH",
        body: { role, expectedVersion: member.version },
      }),
    onSuccess: async () => {
      setDraft(undefined);
      setConfirmRemove(false);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["identity"] }),
  });

  return (
    <li className="membership-row">
      <div className="member-details">
        <strong>{name}</strong>
        {member.email && <span>{member.email}</span>}
        <span>{labels[member.role]}</span>
      </div>
      {confirmRemove ? (
        <div className="membership-actions">
          <p>Remove {member.name} from this workspace?</p>
          <Button
            onClick={() => mutation.mutate(null)}
            disabled={mutation.isPending}
          >
            Confirm removal
          </Button>
          <Button
            variant="quiet"
            onClick={() => setConfirmRemove(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <form
          className="membership-actions"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft) mutation.mutate(draft);
          }}
        >
          <select
            aria-label={`Role for ${member.name}`}
            value={draft ?? member.role}
            onChange={(event) =>
              setDraft(workspaceRoleSchema.parse(event.target.value))
            }
          >
            <RoleOptions />
          </select>
          <Button
            type="submit"
            variant="secondary"
            disabled={!draft || draft === member.role || mutation.isPending}
          >
            Save role<span className="sr-only"> for {member.name}</span>
          </Button>
          <Button
            variant="quiet"
            onClick={() => setConfirmRemove(true)}
            disabled={mutation.isPending}
          >
            Remove<span className="sr-only"> {member.name}</span>
          </Button>
        </form>
      )}
      {mutation.error && <p role="alert">{errorMessage(mutation.error)}</p>}
      {mutation.isSuccess && (
        <p className="sr-only" role="status">
          Membership updated.
        </p>
      )}
    </li>
  );
}

function Members({
  workspaceId,
  actorId,
}: {
  workspaceId: string;
  actorId: string;
}) {
  const members = useQuery({
    queryKey: ["identity", "members", actorId, workspaceId],
    queryFn: ({ signal }) =>
      read(`/workspaces/${workspaceId}/members`, membersResponseSchema, signal),
    gcTime: 0,
    refetchInterval: 5_000,
  });

  return (
    <section
      className="identity-section glass-panel"
      aria-labelledby="members-title"
    >
      <h2 id="members-title">Members</h2>
      {members.isPending ? (
        <AsyncState kind="loading" message="Loading members…" />
      ) : members.isError ? (
        <AsyncState
          kind="error"
          message={
            denied(members.error)
              ? "Membership settings are unavailable."
              : "Could not load members."
          }
          retry={() => void members.refetch()}
        />
      ) : (
        <ul className="membership-list">
          {members.data.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              workspaceId={workspaceId}
              actorId={actorId}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function WorkspaceSettings({
  workspace,
  actorId,
}: {
  workspace: WorkspaceSummary;
  actorId: string;
}) {
  return (
    <div className="standard-page settings-page">
      <title>Settings · Kordos</title>
      <PageHeading title="Settings" description={workspace.name} />
      <dl className="workspace-details glass-panel">
        <div>
          <dt>Timezone</dt>
          <dd>{workspace.timeZone}</dd>
        </div>
        <div>
          <dt>Your role</dt>
          <dd>{labels[workspace.role]}</dd>
        </div>
      </dl>
      {workspace.role === "admin" && (
        <>
          <Members workspaceId={workspace.id} actorId={actorId} />
          <ConnectorSettings />
          <InvitationForm
            workspaceId={workspace.id}
            timeZone={workspace.timeZone}
          />
        </>
      )}
      <NotificationPreferences />
      <SignOut />
    </div>
  );
}
