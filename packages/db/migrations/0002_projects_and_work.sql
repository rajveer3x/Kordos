CREATE TYPE "public"."project_role" AS ENUM('viewer', 'contributor', 'lead');--> statement-breakpoint
CREATE TYPE "public"."work_kind" AS ENUM('task', 'milestone');--> statement-breakpoint
CREATE TYPE "public"."work_status" AS ENUM('backlog', 'ready', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "outbox_workspace_id_actor_id_mutation_id_unique" UNIQUE("workspace_id","actor_id","mutation_id")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "project_role" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "project_members_workspace_id_project_id_user_id_pk" PRIMARY KEY("workspace_id","project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"kind" "work_kind" NOT NULL,
	"status" "work_status" NOT NULL,
	"owner_id" uuid,
	"estimate_days" integer,
	"deadline" date,
	"commitment" date,
	"blocker_reason" text,
	"blocker_owner_id" uuid,
	"blocker_resolution" text,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "work_items_workspace_id_project_id_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "work_items_estimate" CHECK ("work_items"."estimate_days" BETWEEN 1 AND 3650),
	CONSTRAINT "work_items_commitment" CHECK ("work_items"."kind" = 'milestone' OR "work_items"."commitment" IS NULL),
	CONSTRAINT "work_items_completion" CHECK (("work_items"."status" = 'done') = ("work_items"."completed_at" IS NOT NULL)),
	CONSTRAINT "work_items_blocker" CHECK ("work_items"."blocker_reason" IS NOT NULL OR
    ("work_items"."blocker_owner_id" IS NULL AND "work_items"."blocker_resolution" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "workdays" smallint[] DEFAULT ARRAY[1,2,3,4,5]::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "nonworking_dates" date[] DEFAULT '{}'::date[] NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_id_audit_events_id_fk" FOREIGN KEY ("id") REFERENCES "public"."audit_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_membership_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_owner_fk" FOREIGN KEY ("workspace_id","project_id","owner_id") REFERENCES "public"."project_members"("workspace_id","project_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_blocker_owner_fk" FOREIGN KEY ("workspace_id","project_id","blocker_owner_id") REFERENCES "public"."project_members"("workspace_id","project_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("created_at","id") WHERE "outbox"."delivered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "work_items_assigned_idx" ON "work_items" USING btree ("workspace_id","owner_id","id") WHERE "work_items"."archived_at" IS NULL AND "work_items"."status" <> 'done';--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_work_history_idx" ON "audit_events" USING btree ("workspace_id","project_id","target_id","created_at","id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workdays" CHECK (cardinality("projects"."workdays") BETWEEN 1 AND 7
      AND "projects"."workdays" <@ ARRAY[1,2,3,4,5,6,7]::smallint[]);
--> statement-breakpoint
UPDATE public.projects p SET time_zone = w.time_zone
FROM public.workspaces w WHERE w.id = p.workspace_id;
--> statement-breakpoint
CREATE SCHEMA kordos_planning;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.project_access(p_project uuid) RETURNS public.project_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN m.role IS NOT NULL AND kordos_identity.current_role() = 'viewer' THEN 'viewer'
    WHEN m.role IS NOT NULL THEN m.role
    WHEN p.visibility = 'workspace' THEN 'viewer'
  END
  FROM public.projects p
  LEFT JOIN public.project_members m ON m.workspace_id = p.workspace_id AND m.project_id = p.id
    AND m.user_id = kordos_identity.actor_id() AND m.removed_at IS NULL
  WHERE p.workspace_id = kordos_identity.workspace_id() AND p.id = p_project
    AND kordos_identity.current_role() IS NOT NULL
$$;
--> statement-breakpoint
DROP POLICY projects_read ON public.projects;
CREATE POLICY projects_read ON public.projects FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND kordos_planning.project_access(id) IS NOT NULL
);
DROP POLICY audit_read ON public.audit_events;
CREATE POLICY audit_read ON public.audit_events FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND (
    (project_id IS NULL AND kordos_identity.current_role() = 'admin')
    OR (project_id IS NOT NULL AND kordos_planning.project_access(project_id) IS NOT NULL)
  )
);
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_items_read ON public.work_items FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND kordos_planning.project_access(project_id) IS NOT NULL
);
GRANT SELECT ON public.work_items TO kordos_app;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.person(p_project uuid, p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', u.id, 'name', u.name)
  FROM public.project_members pm JOIN public.users u ON u.id = pm.user_id
  WHERE pm.workspace_id = kordos_identity.workspace_id() AND pm.project_id = p_project
    AND pm.user_id = p_user AND kordos_planning.project_access(p_project) IS NOT NULL
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.lead(p_project uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', u.id, 'name', u.name)
  FROM public.project_members pm
  JOIN public.memberships m USING (workspace_id, user_id)
  JOIN public.users u ON u.id = pm.user_id
  WHERE pm.workspace_id = kordos_identity.workspace_id() AND pm.project_id = p_project
    AND pm.role = 'lead' AND pm.removed_at IS NULL AND m.removed_at IS NULL AND m.role <> 'viewer'
    AND kordos_planning.project_access(p_project) IS NOT NULL
  ORDER BY pm.joined_at, pm.user_id LIMIT 1
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.people(p_project uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH access AS (
    SELECT kordos_planning.project_access(p_project) AS role
  ), roster AS (
    SELECT u.id, u.name, m.role AS workspace_role, pm.role, pm.version
    FROM public.memberships m
    JOIN public.users u ON u.id = m.user_id
    LEFT JOIN public.project_members pm ON pm.workspace_id = m.workspace_id
      AND pm.user_id = m.user_id AND pm.project_id = p_project AND pm.removed_at IS NULL
    WHERE m.workspace_id = kordos_identity.workspace_id() AND m.removed_at IS NULL
  )
  SELECT jsonb_build_object(
    'owners', CASE WHEN access.role IN ('contributor', 'lead') THEN (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name, id), '[]')
      FROM roster WHERE role IN ('lead', 'contributor') AND workspace_role <> 'viewer'
    ) ELSE '[]'::jsonb END,
    'members', CASE WHEN access.role = 'lead' THEN (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'role', role, 'version', version
      ) ORDER BY name, id), '[]') FROM roster WHERE role IS NOT NULL
    ) ELSE '[]'::jsonb END,
    'candidates', CASE WHEN access.role = 'lead' THEN (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name, id), '[]')
      FROM roster WHERE role IS NULL
    ) ELSE '[]'::jsonb END
  ) FROM access WHERE access.role IS NOT NULL
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.audience() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT count(*)::integer FROM public.memberships
  WHERE workspace_id = kordos_identity.workspace_id() AND removed_at IS NULL
    AND kordos_identity.current_role() IN ('contributor', 'admin')
  HAVING kordos_identity.current_role() IN ('contributor', 'admin')
$$;
--> statement-breakpoint
-- Match the lock order used by workspace membership changes, then serialize
-- each project independently and deduplicate retries before changing state.
CREATE FUNCTION kordos_planning.lock_workspace(p_mutation uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id = kordos_identity.workspace_id() FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'kordos.planning:' || kordos_identity.workspace_id() || ':' ||
    kordos_identity.actor_id() || ':' || p_mutation, 0
  ));
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.replay(p_request jsonb, p_project uuid, p_target uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN o.request = p_request
    AND (p_project IS NULL OR o.project_id = p_project)
    AND (p_target IS NULL OR o.target_id = p_target)
    AND kordos_planning.project_access(o.project_id) IS NOT NULL
    THEN jsonb_build_object('result', 'saved', 'id', o.target_id)
    ELSE jsonb_build_object('result', 'mutation_conflict') END
  FROM public.outbox o WHERE o.workspace_id = kordos_identity.workspace_id()
    AND o.actor_id = kordos_identity.actor_id() AND o.mutation_id = (p_request->>'mutationId')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.emit(
  p_project uuid, p_target uuid, p_kind text, p_request jsonb, p_before jsonb, p_after jsonb
) RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE event_id uuid;
BEGIN
  INSERT INTO public.audit_events (workspace_id, project_id, actor_id, action, target_id, details, created_at)
  VALUES (kordos_identity.workspace_id(), p_project, kordos_identity.actor_id(), p_kind, p_target,
    jsonb_build_object('before', p_before, 'after', p_after), clock_timestamp())
  RETURNING id INTO event_id;
  INSERT INTO public.outbox (id, workspace_id, project_id, actor_id, mutation_id, kind, target_id, request, created_at)
  VALUES (event_id, kordos_identity.workspace_id(), p_project, kordos_identity.actor_id(),
    (p_request->>'mutationId')::uuid, p_kind, p_target, p_request, clock_timestamp());
  RETURN p_target;
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.project_snapshot(p public.projects) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('name', p.name, 'description', p.description, 'visibility', p.visibility,
    'timeZone', p.time_zone, 'workdays', p.workdays, 'nonworkingDates', p.nonworking_dates,
    'version', p.version, 'archived', p.archived_at IS NOT NULL)
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.save_project(p_project uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  previous public.projects;
  updated public.projects;
  request jsonb := p_input || jsonb_build_object('_command', CASE WHEN p_project IS NULL THEN 'project.create' ELSE 'project.update' END);
  action text := p_input->>'action';
  repeated jsonb;
  event_kind text;
BEGIN
  IF kordos_identity.current_role() NOT IN ('contributor', 'admin')
    OR kordos_identity.current_role() IS NULL THEN
    RETURN jsonb_build_object('result', 'unavailable');
  END IF;
  PERFORM kordos_planning.lock_workspace((p_input->>'mutationId')::uuid);
  IF kordos_identity.current_role() NOT IN ('contributor', 'admin')
    OR kordos_identity.current_role() IS NULL
    OR (p_project IS NOT NULL AND kordos_planning.project_access(p_project) IS DISTINCT FROM 'lead') THEN
    RETURN jsonb_build_object('result', 'unavailable');
  END IF;
  repeated := kordos_planning.replay(request, p_project, p_project);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;

  IF p_project IS NULL THEN
    INSERT INTO public.projects (workspace_id, name, description, visibility, time_zone, workdays, nonworking_dates)
    VALUES (tenant, p_input->>'name', p_input->>'description', (p_input->>'visibility')::public.project_visibility,
      p_input->>'timeZone', ARRAY(SELECT jsonb_array_elements_text(p_input->'workdays')::smallint),
      ARRAY(SELECT jsonb_array_elements_text(p_input->'nonworkingDates')::date))
    RETURNING * INTO updated;
    INSERT INTO public.project_members (workspace_id, project_id, user_id, role)
    VALUES (tenant, updated.id, kordos_identity.actor_id(), 'lead');
    event_kind := 'project.created';
  ELSE
    SELECT * INTO previous FROM public.projects
    WHERE workspace_id = tenant AND id = p_project FOR UPDATE;
    IF kordos_planning.project_access(p_project) IS DISTINCT FROM 'lead' THEN
      RETURN jsonb_build_object('result', 'unavailable');
    END IF;
    IF previous.version IS DISTINCT FROM (p_input->>'expectedVersion')::integer THEN
      RETURN jsonb_build_object('result', 'conflict');
    END IF;
    IF action = 'edit' AND previous.archived_at IS NULL THEN
      UPDATE public.projects SET name = p_input->>'name', description = p_input->>'description',
        visibility = (p_input->>'visibility')::public.project_visibility, time_zone = p_input->>'timeZone',
        workdays = ARRAY(SELECT jsonb_array_elements_text(p_input->'workdays')::smallint),
        nonworking_dates = ARRAY(SELECT jsonb_array_elements_text(p_input->'nonworkingDates')::date),
        version = version + 1
      WHERE workspace_id = tenant AND id = p_project RETURNING * INTO updated;
      event_kind := CASE WHEN previous.visibility <> updated.visibility THEN 'project.visibility_changed' ELSE 'project.edited' END;
    ELSIF (action = 'archive' AND previous.archived_at IS NULL)
      OR (action = 'reopen' AND previous.archived_at IS NOT NULL) THEN
      UPDATE public.projects SET archived_at = CASE WHEN action = 'archive' THEN clock_timestamp() END,
        version = version + 1
      WHERE workspace_id = tenant AND id = p_project RETURNING * INTO updated;
      event_kind := CASE WHEN action = 'archive' THEN 'project.archived' ELSE 'project.reopened' END;
    ELSE
      RETURN jsonb_build_object('result', 'invalid_state');
    END IF;
  END IF;

  PERFORM kordos_planning.emit(updated.id, updated.id, event_kind, request,
    CASE WHEN p_project IS NOT NULL THEN kordos_planning.project_snapshot(previous) END,
    kordos_planning.project_snapshot(updated));
  RETURN jsonb_build_object('result', 'saved', 'id', updated.id);
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.save_member(p_project uuid, p_user uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  previous public.project_members;
  updated public.project_members;
  desired public.project_role := (p_input->>'role')::public.project_role;
  request jsonb := p_input || jsonb_build_object('_command', 'project.member');
  repeated jsonb;
BEGIN
  IF kordos_planning.project_access(p_project) IS DISTINCT FROM 'lead' THEN
    RETURN jsonb_build_object('result', 'unavailable');
  END IF;
  PERFORM kordos_planning.lock_workspace((p_input->>'mutationId')::uuid);
  PERFORM 1 FROM public.projects WHERE workspace_id = tenant AND id = p_project FOR UPDATE;
  IF kordos_planning.project_access(p_project) IS DISTINCT FROM 'lead' THEN
    RETURN jsonb_build_object('result', 'unavailable');
  END IF;
  repeated := kordos_planning.replay(request, p_project, p_user);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE workspace_id = tenant
    AND user_id = p_user AND removed_at IS NULL) THEN
    RETURN jsonb_build_object('result', 'unavailable');
  END IF;
  IF desired IN ('contributor', 'lead') AND EXISTS (
    SELECT 1 FROM public.memberships WHERE workspace_id = tenant AND user_id = p_user AND role = 'viewer'
  ) THEN
    RETURN jsonb_build_object('result', 'invalid_role');
  END IF;

  SELECT * INTO previous FROM public.project_members
  WHERE workspace_id = tenant AND project_id = p_project AND user_id = p_user AND removed_at IS NULL;
  IF previous.version IS DISTINCT FROM (p_input->>'expectedVersion')::integer THEN
    RETURN jsonb_build_object('result', 'conflict');
  END IF;
  IF previous.role = 'lead' AND desired IS DISTINCT FROM 'lead' AND NOT EXISTS (
    SELECT 1 FROM public.project_members pm JOIN public.memberships m USING (workspace_id, user_id)
    WHERE pm.workspace_id = tenant AND pm.project_id = p_project AND pm.user_id <> p_user
      AND pm.role = 'lead' AND pm.removed_at IS NULL AND m.removed_at IS NULL AND m.role <> 'viewer'
  ) THEN
    RETURN jsonb_build_object('result', 'last_lead');
  END IF;

  IF desired IS NULL THEN
    IF previous.version IS NULL THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
    UPDATE public.project_members SET removed_at = clock_timestamp(), version = version + 1
    WHERE workspace_id = tenant AND project_id = p_project AND user_id = p_user
    RETURNING * INTO updated;
  ELSE
    INSERT INTO public.project_members (workspace_id, project_id, user_id, role)
    VALUES (tenant, p_project, p_user, desired)
    ON CONFLICT (workspace_id, project_id, user_id) DO UPDATE SET role = EXCLUDED.role,
      removed_at = NULL, version = public.project_members.version + 1,
      joined_at = CASE WHEN public.project_members.removed_at IS NOT NULL THEN clock_timestamp()
        ELSE public.project_members.joined_at END
    RETURNING * INTO updated;
  END IF;
  PERFORM kordos_planning.emit(p_project, p_user, 'project.member_changed', request,
    jsonb_build_object('role', previous.role, 'version', previous.version),
    jsonb_build_object('role', desired, 'version', updated.version));
  RETURN jsonb_build_object('result', 'saved', 'id', p_user);
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.revoke_workspace_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.project_members SET removed_at = NEW.removed_at, version = version + 1
  WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND removed_at IS NULL;
  RETURN NEW;
END
$$;
CREATE TRIGGER planning_revoke_workspace_member AFTER UPDATE OF removed_at ON public.memberships
FOR EACH ROW WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL)
EXECUTE FUNCTION kordos_planning.revoke_workspace_member();
--> statement-breakpoint
CREATE FUNCTION kordos_planning.owner_eligible(p_project uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_members pm JOIN public.memberships m USING (workspace_id, user_id)
    WHERE pm.workspace_id = kordos_identity.workspace_id() AND pm.project_id = p_project AND pm.user_id = p_user
      AND pm.removed_at IS NULL AND pm.role IN ('contributor', 'lead')
      AND m.removed_at IS NULL AND m.role <> 'viewer'
  )
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.work_snapshot(w public.work_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'title', w.title, 'description', w.description, 'kind', w.kind, 'status', w.status,
    'ownerId', w.owner_id, 'estimateDays', w.estimate_days, 'deadline', w.deadline, 'commitment', w.commitment,
    'blockerReason', w.blocker_reason, 'blockerOwnerId', w.blocker_owner_id, 'blockerResolution', w.blocker_resolution,
    'version', w.version, 'archived', w.archived_at IS NOT NULL,
    'completedAt', to_char(w.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.save_work(p_project uuid, p_work uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  access public.project_role;
  project_archived timestamptz;
  previous public.work_items;
  updated public.work_items;
  request jsonb := p_input || jsonb_build_object('_command', CASE WHEN p_work IS NULL THEN 'work.create' ELSE 'work.update' END);
  action text := p_input->>'action';
  repeated jsonb;
  event_kind text;
  desired_owner uuid := (p_input->>'ownerId')::uuid;
  desired_blocker_owner uuid := (p_input->>'blockerOwnerId')::uuid;
  desired_status public.work_status := (p_input->>'status')::public.work_status;
  desired_commitment date := (p_input->>'commitment')::date;
BEGIN
  access := kordos_planning.project_access(p_project);
  IF access IS NULL OR access = 'viewer' THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  PERFORM kordos_planning.lock_workspace((p_input->>'mutationId')::uuid);
  SELECT archived_at INTO project_archived FROM public.projects WHERE workspace_id = tenant AND id = p_project FOR UPDATE;
  access := kordos_planning.project_access(p_project);
  IF access IS NULL OR access = 'viewer' THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  repeated := kordos_planning.replay(request, p_project, p_work);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;

  IF p_work IS NOT NULL THEN
    SELECT * INTO previous FROM public.work_items WHERE workspace_id = tenant AND project_id = p_project AND id = p_work;
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
    IF previous.version IS DISTINCT FROM (p_input->>'expectedVersion')::integer THEN
      RETURN jsonb_build_object('result', 'conflict');
    END IF;
  END IF;
  IF project_archived IS NOT NULL THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;

  IF p_work IS NULL OR action = 'edit' THEN
    IF previous.archived_at IS NOT NULL OR
      (p_work IS NOT NULL AND previous.kind IS DISTINCT FROM (p_input->>'kind')::public.work_kind) THEN
      RETURN jsonb_build_object('result', 'invalid_state');
    END IF;
    IF desired_commitment IS DISTINCT FROM previous.commitment AND access <> 'lead' THEN
      RETURN jsonb_build_object('result', 'commitment_requires_lead');
    END IF;
    IF (desired_owner IS NOT NULL AND desired_owner IS DISTINCT FROM previous.owner_id
        AND NOT kordos_planning.owner_eligible(p_project, desired_owner))
      OR (desired_blocker_owner IS NOT NULL AND desired_blocker_owner IS DISTINCT FROM previous.blocker_owner_id
        AND NOT kordos_planning.owner_eligible(p_project, desired_blocker_owner)) THEN
      RETURN jsonb_build_object('result', 'invalid_owner');
    END IF;
    IF p_work IS NULL THEN
      INSERT INTO public.work_items (workspace_id, project_id, title, description, kind, status, owner_id, estimate_days,
        deadline, commitment, blocker_reason, blocker_owner_id, blocker_resolution, completed_at)
      VALUES (tenant, p_project, p_input->>'title', p_input->>'description', (p_input->>'kind')::public.work_kind,
        desired_status, desired_owner, (p_input->>'estimateDays')::integer, (p_input->>'deadline')::date, desired_commitment,
        p_input->>'blockerReason', desired_blocker_owner, p_input->>'blockerResolution',
        CASE WHEN desired_status = 'done' THEN clock_timestamp() END)
      RETURNING * INTO updated;
      event_kind := 'work.created';
    ELSE
      UPDATE public.work_items SET title = p_input->>'title', description = p_input->>'description', status = desired_status,
        owner_id = desired_owner, estimate_days = (p_input->>'estimateDays')::integer, deadline = (p_input->>'deadline')::date,
        commitment = desired_commitment, blocker_reason = p_input->>'blockerReason', blocker_owner_id = desired_blocker_owner,
        blocker_resolution = p_input->>'blockerResolution', version = version + 1,
        completed_at = CASE WHEN desired_status = 'done' THEN coalesce(completed_at, clock_timestamp()) END
      WHERE workspace_id = tenant AND project_id = p_project AND id = p_work RETURNING * INTO updated;
      event_kind := CASE
        WHEN previous.status <> 'done' AND updated.status = 'done' THEN 'work.completed'
        WHEN previous.status = 'done' AND updated.status <> 'done' THEN 'work.reopened'
        ELSE 'work.edited' END;
    END IF;
  ELSIF (action = 'archive' AND previous.archived_at IS NULL)
    OR (action = 'restore' AND previous.archived_at IS NOT NULL)
    OR (action = 'reopen' AND previous.archived_at IS NULL AND previous.status = 'done') THEN
    UPDATE public.work_items SET version = version + 1,
      archived_at = CASE WHEN action = 'archive' THEN clock_timestamp() END,
      status = CASE WHEN action = 'reopen' THEN 'ready' ELSE status END,
      completed_at = CASE WHEN action <> 'reopen' THEN completed_at END
    WHERE workspace_id = tenant AND project_id = p_project AND id = p_work RETURNING * INTO updated;
    event_kind := CASE action WHEN 'archive' THEN 'work.archived' WHEN 'restore' THEN 'work.restored' ELSE 'work.reopened' END;
  ELSE
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;

  PERFORM kordos_planning.emit(p_project, updated.id, event_kind, request,
    CASE WHEN p_work IS NOT NULL THEN kordos_planning.work_snapshot(previous) END, kordos_planning.work_snapshot(updated));
  RETURN jsonb_build_object('result', 'saved', 'id', updated.id);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_planning FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_planning TO kordos_app;
GRANT EXECUTE ON FUNCTION
  kordos_planning.project_access(uuid), kordos_planning.person(uuid, uuid),
  kordos_planning.lead(uuid), kordos_planning.people(uuid), kordos_planning.audience(),
  kordos_planning.save_project(uuid, jsonb), kordos_planning.save_member(uuid, uuid, jsonb),
  kordos_planning.work_snapshot(public.work_items), kordos_planning.save_work(uuid, uuid, jsonb)
TO kordos_app;
