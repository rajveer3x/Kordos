CREATE TYPE "public"."project_visibility" AS ENUM('restricted', 'workspace');
--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('viewer', 'contributor', 'admin');
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_id" uuid NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "workspace_role" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitation_acceptance_pair" CHECK (("invitations"."accepted_at" IS NULL) = ("invitations"."accepted_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_role" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" "project_visibility" DEFAULT 'restricted' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"email_verified" boolean NOT NULL,
	CONSTRAINT "users_issuer_subject_unique" UNIQUE("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"time_zone" text NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_actor_id_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_accepted_by_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","accepted_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_events_workspace_id_created_at_index" ON "audit_events" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "memberships_user_id_workspace_id_index" ON "memberships" USING btree ("user_id","workspace_id") WHERE "memberships"."removed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "projects_workspace_id_name_index" ON "projects" USING btree ("workspace_id","name");
--> statement-breakpoint
CREATE SCHEMA kordos_identity;
--> statement-breakpoint
CREATE FUNCTION kordos_identity.actor_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('kordos.actor_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_identity.workspace_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('kordos.workspace_id', true), '')::uuid
$$;
--> statement-breakpoint
-- Read membership without recursively applying the memberships row policy.
CREATE FUNCTION kordos_identity.current_role() RETURNS public.workspace_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT role FROM public.memberships
  WHERE workspace_id = kordos_identity.workspace_id()
    AND user_id = kordos_identity.actor_id() AND removed_at IS NULL
$$;
--> statement-breakpoint
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_read ON public.users FOR SELECT TO kordos_app USING (
  id = kordos_identity.actor_id() OR (
    kordos_identity.current_role() = 'admin' AND EXISTS (
      SELECT 1 FROM public.memberships
      WHERE user_id = users.id AND workspace_id = kordos_identity.workspace_id()
    )
  )
);
CREATE POLICY workspaces_read ON public.workspaces FOR SELECT TO kordos_app USING (
  id = kordos_identity.workspace_id() AND kordos_identity.current_role() IS NOT NULL
);
CREATE POLICY memberships_read ON public.memberships FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND removed_at IS NULL
    AND (user_id = kordos_identity.actor_id() OR kordos_identity.current_role() = 'admin')
    AND kordos_identity.current_role() IS NOT NULL
);
CREATE POLICY projects_read ON public.projects FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND visibility = 'workspace'
    AND kordos_identity.current_role() IS NOT NULL
);
CREATE POLICY audit_read ON public.audit_events FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND kordos_identity.current_role() = 'admin'
);
--> statement-breakpoint
GRANT USAGE ON SCHEMA kordos_identity TO kordos_app;
GRANT SELECT (id, name, email, email_verified) ON public.users TO kordos_app;
GRANT SELECT ON public.workspaces, public.memberships, public.projects, public.audit_events TO kordos_app;
--> statement-breakpoint
CREATE FUNCTION kordos_identity.record_sign_in(
  p_issuer text, p_subject text, p_name text, p_email text, p_email_verified boolean
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  INSERT INTO public.users (issuer, subject, name, email, email_verified)
  VALUES (p_issuer, p_subject, p_name, p_email, p_email_verified)
  ON CONFLICT (issuer, subject) DO UPDATE SET
    name = EXCLUDED.name, email = EXCLUDED.email, email_verified = EXCLUDED.email_verified
  RETURNING id
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_identity.list_workspaces()
RETURNS TABLE (id uuid, name text, "timeZone" text, role public.workspace_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT w.id, w.name, w.time_zone, m.role
  FROM public.memberships m JOIN public.workspaces w ON w.id = m.workspace_id
  WHERE m.user_id = kordos_identity.actor_id() AND m.removed_at IS NULL
  ORDER BY w.name, w.id
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_identity.create_workspace(
  p_id uuid, p_name text, p_time_zone text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor uuid := kordos_identity.actor_id();
BEGIN
  IF actor IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.workspaces (id, name, time_zone, created_by)
  VALUES (p_id, p_name, p_time_zone, actor)
  ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM public.workspaces w
      JOIN public.memberships m ON m.workspace_id = w.id AND m.user_id = actor
      WHERE w.id = p_id AND w.created_by = actor AND m.removed_at IS NULL
        AND w.name = p_name AND w.time_zone = p_time_zone
    );
  END IF;

  INSERT INTO public.memberships (workspace_id, user_id, role)
  VALUES (p_id, actor, 'admin');
  INSERT INTO public.audit_events (workspace_id, actor_id, action, target_id, details)
  VALUES (p_id, actor, 'workspace.created', p_id, jsonb_build_object('role', 'admin'));
  RETURN true;
END
$$;
--> statement-breakpoint
-- The workspace row serializes membership changes and invitation issuance.
-- Recheck the caller's authority after acquiring the lock.
CREATE FUNCTION kordos_identity.create_invitation(
  p_email text, p_role public.workspace_role, p_token_hash text
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  invitation uuid;
  expiration timestamptz;
BEGIN
  IF kordos_identity.current_role() IS DISTINCT FROM 'admin' THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.workspaces WHERE id = tenant FOR UPDATE;
  IF kordos_identity.current_role() IS DISTINCT FROM 'admin' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.invitations (workspace_id, email, role, token_hash, expires_at)
  VALUES (tenant, p_email, p_role, p_token_hash, clock_timestamp() + interval '7 days')
  RETURNING id, expires_at INTO invitation, expiration;
  INSERT INTO public.audit_events (workspace_id, actor_id, action, target_id, details)
  VALUES (tenant, actor, 'invitation.created', invitation, jsonb_build_object('role', p_role));
  RETURN expiration;
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_identity.accept_invitation(p_token_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor uuid := kordos_identity.actor_id();
  invitation public.invitations%ROWTYPE;
BEGIN
  IF actor IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT i.* INTO invitation FROM public.invitations i JOIN public.users u ON u.id = actor
  WHERE i.token_hash = p_token_hash AND u.email_verified AND u.email = i.email
    AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM public.workspaces WHERE id = invitation.workspace_id FOR UPDATE;
  SELECT i.* INTO invitation FROM public.invitations i JOIN public.users u ON u.id = actor
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp()
    AND u.email_verified AND u.email = i.email
    AND NOT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.workspace_id = i.workspace_id AND m.user_id = actor AND m.removed_at IS NULL
    )
  FOR UPDATE OF i FOR SHARE OF u;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.memberships (workspace_id, user_id, role)
  VALUES (invitation.workspace_id, actor, invitation.role)
  ON CONFLICT (workspace_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, removed_at = NULL, version = public.memberships.version + 1;
  UPDATE public.invitations SET accepted_at = clock_timestamp(), accepted_by = actor
  WHERE id = invitation.id;
  INSERT INTO public.audit_events (workspace_id, actor_id, action, target_id, details)
  VALUES (invitation.workspace_id, actor, 'invitation.accepted', invitation.id,
    jsonb_build_object('role', invitation.role));
  RETURN invitation.workspace_id;
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_identity.update_member(
  p_user_id uuid, p_expected_version integer, p_role public.workspace_role
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  member public.memberships%ROWTYPE;
BEGIN
  IF kordos_identity.current_role() IS DISTINCT FROM 'admin' THEN
    RETURN 'unavailable';
  END IF;
  PERFORM 1 FROM public.workspaces WHERE id = tenant FOR UPDATE;
  IF kordos_identity.current_role() IS DISTINCT FROM 'admin' THEN
    RETURN 'unavailable';
  END IF;

  SELECT * INTO member FROM public.memberships
  WHERE workspace_id = tenant AND user_id = p_user_id AND removed_at IS NULL;
  IF NOT FOUND THEN
    RETURN 'unavailable';
  END IF;
  IF member.version <> p_expected_version THEN
    RETURN 'conflict';
  END IF;
  IF member.role = p_role THEN
    RETURN 'updated';
  END IF;
  IF member.role = 'admin' AND p_role IS DISTINCT FROM 'admin' AND NOT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE workspace_id = tenant AND role = 'admin' AND removed_at IS NULL AND user_id <> p_user_id
  ) THEN
    RETURN 'last_admin';
  END IF;

  UPDATE public.memberships SET
    role = coalesce(p_role, role), version = version + 1,
    removed_at = CASE WHEN p_role IS NULL THEN clock_timestamp() ELSE NULL END
  WHERE workspace_id = tenant AND user_id = p_user_id;
  IF p_role IS NULL THEN
    UPDATE public.invitations i SET expires_at = clock_timestamp()
    FROM public.users u
    WHERE u.id = p_user_id AND i.workspace_id = tenant AND i.email = u.email
      AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp();
  END IF;
  INSERT INTO public.audit_events (workspace_id, actor_id, action, target_id, details)
  VALUES (tenant, actor,
    CASE WHEN p_role IS NULL THEN 'membership.removed' ELSE 'membership.role_changed' END,
    p_user_id, jsonb_build_object('previousRole', member.role, 'role', p_role));
  RETURN 'updated';
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_identity FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_identity TO kordos_app;
