import {
  createWorkspaceSchema,
  idSchema,
  invitationTokenSchema,
  type SessionIdentity,
  type WorkspaceSummary,
} from "@kordos/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { Brand } from "../../components/brand";
import { GlassArtwork } from "../../components/glass-artwork";
import { Button, PageHeading } from "../../components/ui";
import { workspacePath } from "../workspace/workspace-model";
import { errorMessage, request } from "./api";

const idResponse = z.object({ id: idSchema });

export function SignInPage({ available }: { available: boolean }) {
  const { state, search } = useLocation();
  const pending = useMutation({
    mutationFn: async () => {
      const response = await request("/auth/login", {
        method: "POST",
        body: {
          returnTo:
            typeof state?.returnTo === "string" ? state.returnTo : "/workspace",
        },
        schema: z.object({ url: z.url({ protocol: /^https?$/ }) }),
      });
      if (response) window.location.assign(response.url);
    },
  });
  const failed = new URLSearchParams(search).has("error");

  return (
    <main className="public-page">
      <title>Sign in · Kordos</title>
      <Brand />
      <section
        className="public-panel glass-panel glass-panel--blur"
        aria-labelledby="sign-in-title"
      >
        <div className="public-panel__art">
          <GlassArtwork />
        </div>
        <div className="public-panel__content">
          <h1 id="sign-in-title" className="page-title page-title--display">
            Sign in to Kordos
          </h1>
          <p>The AI workspace for software teams.</p>
          {available ? (
            <Button
              onClick={() => pending.mutate()}
              disabled={pending.isPending}
            >
              {pending.isPending ? "Connecting…" : "Continue to sign in"}
            </Button>
          ) : (
            <p className="sign-in-note">Workspace sign-in is unavailable.</p>
          )}
          {pending.error && <p role="alert">{errorMessage(pending.error)}</p>}
          {!pending.error && failed && (
            <p role="alert">Sign-in could not be completed. Try again.</p>
          )}
        </div>
      </section>
    </main>
  );
}

export function SignOut() {
  const client = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => request("/auth/logout", { method: "POST" }),
    onSuccess: async () => {
      await client.cancelQueries();
      client.clear();
      window.location.replace("/sign-in");
    },
  });

  return (
    <div className="sign-out">
      <Button
        variant="secondary"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
      >
        {signOut.isPending ? "Signing out…" : "Sign out"}
      </Button>
      {signOut.error && <p role="alert">{errorMessage(signOut.error)}</p>}
    </div>
  );
}

export function WorkspaceChooser({
  workspaces,
}: {
  workspaces: WorkspaceSummary[];
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const createId = useRef<string>(undefined);
  const [validationError, setValidationError] = useState("");
  const create = useMutation({
    mutationFn: (body: z.infer<typeof createWorkspaceSchema>) =>
      request("/workspaces", { method: "POST", body, schema: idResponse }),
    onSuccess: async (workspace) => {
      if (workspace) {
        await client.invalidateQueries({
          queryKey: ["identity", "workspaces"],
        });
        navigate(workspacePath("/workspace", workspace.id), { replace: true });
      }
    },
  });

  return (
    <main className="public-page access-page">
      <title>Workspaces · Kordos</title>
      <Brand />
      <section className="access-card glass-panel glass-panel--blur">
        <PageHeading title="Your workspaces" />
        {workspaces.length ? (
          <ul className="destination-list">
            {workspaces.map(({ id, name, role }) => (
              <li key={id}>
                <Link to={workspacePath("/workspace", id)}>
                  {name} <span>{role}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>Create a workspace or open an invitation link to join a team.</p>
        )}
        <section
          aria-labelledby="create-workspace"
          className="identity-section"
        >
          <h2 id="create-workspace">Create workspace</h2>
          <form
            className="identity-form"
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              createId.current ??= crypto.randomUUID();
              const input = createWorkspaceSchema.safeParse({
                id: createId.current,
                name: fields.get("name"),
                timeZone: fields.get("timeZone"),
              });
              if (!input.success) {
                setValidationError(
                  input.error.issues[0]?.message ??
                    "Check the workspace details.",
                );
                return;
              }
              setValidationError("");
              create.mutate(input.data);
            }}
          >
            <label>
              Workspace name
              <input name="name" required maxLength={100} />
            </label>
            <label>
              Timezone
              <input
                name="timeZone"
                required
                maxLength={100}
                defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
              />
            </label>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating workspace…" : "Create workspace"}
            </Button>
            {(validationError || create.error) && (
              <p role="alert">
                {validationError || errorMessage(create.error)}
              </p>
            )}
          </form>
        </section>
        <SignOut />
      </section>
    </main>
  );
}

export function JoinWorkspace({ identity }: { identity: SessionIdentity }) {
  const token = invitationTokenSchema.safeParse(useLocation().hash.slice(1));
  const client = useQueryClient();
  const navigate = useNavigate();
  const join = useMutation({
    mutationFn: () =>
      request("/invitations/accept", {
        method: "POST",
        body: { token: token.data },
        schema: idResponse,
      }),
    onSuccess: async (workspace) => {
      if (workspace) {
        await client.invalidateQueries({
          queryKey: ["identity", "workspaces"],
        });
        navigate(workspacePath("/workspace", workspace.id), { replace: true });
      }
    },
  });

  return (
    <main className="public-page access-page">
      <title>Join workspace · Kordos</title>
      <Brand />
      <section className="access-card glass-panel glass-panel--blur">
        <PageHeading title="Join workspace" />
        {token.success ? (
          <>
            <p>
              Accept the invitation using the verified email address it was sent
              to.
            </p>
            <p>
              Signed in as <strong>{identity.email ?? identity.name}</strong>
            </p>
            {!identity.emailVerified && (
              <p>Your email address needs verification before you can join.</p>
            )}
            <Button
              disabled={join.isPending || !identity.emailVerified}
              onClick={() => join.mutate()}
            >
              {join.isPending ? "Joining workspace…" : "Accept invitation"}
            </Button>
            {join.error && <p role="alert">{errorMessage(join.error)}</p>}
          </>
        ) : (
          <p>
            This invitation link is incomplete. Open the link your workspace
            administrator shared.
          </p>
        )}
        <p>
          <Link to="/workspace">Your workspaces</Link>
        </p>
        <SignOut />
      </section>
    </main>
  );
}
