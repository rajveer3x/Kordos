CREATE TABLE "connector_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"label" text NOT NULL,
	"provider" text NOT NULL,
	"credential" text,
	"state" text DEFAULT 'enabled' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"issue" text,
	"last_success" timestamp with time zone,
	CONSTRAINT "connector_installations_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "connector_installations_state" CHECK ("connector_installations"."state" IN ('enabled','paused','disconnected'))
);
--> statement-breakpoint
CREATE TABLE "connector_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"mapping_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"delivery_id" text,
	"delivery_hash" text,
	"payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"lease" uuid,
	"lease_until" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "connector_jobs_installation_id_delivery_id_unique" UNIQUE("installation_id","delivery_id"),
	CONSTRAINT "connector_jobs_state" CHECK ("connector_jobs"."state" IN ('queued','running','succeeded','failed','canceled')),
	CONSTRAINT "connector_jobs_kind" CHECK (("connector_jobs"."kind" = 'cleanup' OR "connector_jobs"."mapping_id" IS NOT NULL)
      AND "connector_jobs"."kind" IN ('sync','delivery','cleanup','outbound'))
);
--> statement-breakpoint
CREATE TABLE "connector_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"project_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"provider_audience" text,
	"verified_until" timestamp with time zone,
	"checkpoint" text,
	"last_success" timestamp with time zone,
	"next_sync" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "connector_mappings_workspace_id_installation_id_id_unique" UNIQUE("workspace_id","installation_id","id"),
	CONSTRAINT "connector_mappings_workspace_id_installation_id_id_project_id_unique" UNIQUE("workspace_id","installation_id","id","project_id"),
	CONSTRAINT "connector_mappings_audience" CHECK ("connector_mappings"."audience" IN ('project','private') AND "connector_mappings"."provider_audience" IN ('project','private'))
);
--> statement-breakpoint
CREATE TABLE "connector_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"sharer_id" uuid NOT NULL,
	"title" text NOT NULL,
	"excerpt" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"mapping_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "source_objects_workspace_id_project_id_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "source_objects_mapping_id_external_id_unique" UNIQUE("mapping_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "source_revisions" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"revision_key" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"title" text,
	"body" text,
	"url" text,
	CONSTRAINT "source_revisions_workspace_id_project_id_source_id_revision_pk" PRIMARY KEY("workspace_id","project_id","source_id","revision"),
	CONSTRAINT "source_revisions_source_id_revision_key_unique" UNIQUE("source_id","revision_key")
);
--> statement-breakpoint
ALTER TABLE "connector_installations" ADD CONSTRAINT "connector_installations_owner_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_jobs" ADD CONSTRAINT "connector_jobs_installation_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."connector_installations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_jobs" ADD CONSTRAINT "connector_jobs_mapping_fk" FOREIGN KEY ("workspace_id","installation_id","mapping_id") REFERENCES "public"."connector_mappings"("workspace_id","installation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_mappings" ADD CONSTRAINT "connector_mappings_installation_fk" FOREIGN KEY ("workspace_id","installation_id") REFERENCES "public"."connector_installations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_mappings" ADD CONSTRAINT "connector_mappings_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_shares" ADD CONSTRAINT "connector_shares_revision_fk" FOREIGN KEY ("workspace_id","project_id","source_id","revision") REFERENCES "public"."source_revisions"("workspace_id","project_id","source_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_shares" ADD CONSTRAINT "connector_shares_sharer_fk" FOREIGN KEY ("workspace_id","sharer_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_objects" ADD CONSTRAINT "source_objects_mapping_fk" FOREIGN KEY ("workspace_id","installation_id","mapping_id","project_id") REFERENCES "public"."connector_mappings"("workspace_id","installation_id","id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD CONSTRAINT "source_revisions_source_fk" FOREIGN KEY ("workspace_id","project_id","source_id") REFERENCES "public"."source_objects"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_jobs_active_sync" ON "connector_jobs" USING btree ("mapping_id") WHERE "connector_jobs"."kind" = 'sync' AND "connector_jobs"."state" IN ('queued','running');--> statement-breakpoint
CREATE INDEX "connector_jobs_pending" ON "connector_jobs" USING btree ("available_at","installation_id","id") WHERE "connector_jobs"."state" IN ('queued','running');--> statement-breakpoint
CREATE UNIQUE INDEX "connector_mappings_active_scope" ON "connector_mappings" USING btree ("installation_id","scope") WHERE "connector_mappings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "connector_shares_project_idx" ON "connector_shares" USING btree ("workspace_id","project_id","id");--> statement-breakpoint
CREATE SCHEMA kordos_connectors;
REVOKE ALL ON SCHEMA kordos_connectors FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_connectors TO kordos_app, kordos_brief_worker;
ALTER TABLE public.connector_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_shares ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION kordos_connectors.health(i public.connector_installations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', i.id, 'provider', i.provider, 'label', i.label, 'version', i.version,
    'status', CASE
      WHEN i.state <> 'enabled' THEN i.state
      WHEN EXISTS (SELECT FROM public.connector_jobs j WHERE j.installation_id = i.id
        AND j.kind IN ('sync','delivery') AND (j.state = 'running'
          OR (j.state = 'queued' AND j.available_at <= statement_timestamp()))) THEN 'syncing'
      WHEN i.issue IS NOT NULL THEN 'failed'
      WHEN i.last_success IS NOT NULL THEN 'healthy'
      ELSE 'syncing' END,
    'issue', i.issue, 'lastSuccess', i.last_success,
    'retryAt', (SELECT min(j.available_at) FROM public.connector_jobs j
      WHERE j.installation_id = i.id AND j.kind IN ('sync','delivery') AND j.state = 'queued'
        AND j.available_at > statement_timestamp() AND i.state = 'enabled'),
    'canConfigure', i.owner_id = kordos_identity.actor_id(),
    'cleanupPending', EXISTS (SELECT FROM public.connector_jobs j WHERE j.installation_id = i.id
      AND j.kind = 'cleanup' AND j.state IN ('queued','running')),
    'mappings', coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id,
      'projectId', CASE WHEN visible.allowed THEN p.id END,
      'projectName', CASE WHEN visible.allowed THEN p.name END,
      'scope', CASE WHEN visible.allowed THEN m.scope END,
      'audience', CASE WHEN m.provider_audience = 'private' THEN 'private' ELSE m.audience END,
      'lastSuccess', m.last_success) ORDER BY m.id)
      FROM public.connector_mappings m
      JOIN public.projects p ON (p.workspace_id,p.id) = (m.workspace_id,m.project_id)
      CROSS JOIN LATERAL (SELECT kordos_planning.project_access(p.id) IS NOT NULL AS allowed) visible
      WHERE m.installation_id = i.id AND m.revoked_at IS NULL), '[]'))
$$;

CREATE FUNCTION kordos_connectors.directory() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(kordos_connectors.health(i) ORDER BY i.label, i.id)
      FROM public.connector_installations i WHERE i.workspace_id = kordos_identity.workspace_id()), '[]'),
    'destinations', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) ORDER BY p.name, p.id)
      FROM public.projects p WHERE p.workspace_id = kordos_identity.workspace_id()
      AND p.archived_at IS NULL AND kordos_planning.project_access(p.id) = 'lead'), '[]'))
  WHERE kordos_identity.current_role() = 'admin'
$$;

CREATE FUNCTION kordos_connectors.enqueue_sync(p_installation uuid, p_mapping uuid DEFAULT NULL) RETURNS void
LANGUAGE sql SET search_path = pg_catalog AS $$
  INSERT INTO public.connector_jobs (workspace_id, installation_id, mapping_id, kind)
  SELECT m.workspace_id, m.installation_id, m.id, 'sync' FROM public.connector_mappings m
  WHERE m.installation_id = p_installation AND m.revoked_at IS NULL
    AND (p_mapping IS NULL OR m.id = p_mapping)
  ON CONFLICT DO NOTHING
$$;

CREATE FUNCTION kordos_connectors.audit(
  p_project uuid, p_target uuid, p_action text, p_mutation uuid, p_fingerprint text
) RETURNS void LANGUAGE sql SET search_path = pg_catalog AS $$
  INSERT INTO public.audit_events (workspace_id, project_id, actor_id, target_id, action, details)
  VALUES (kordos_identity.workspace_id(), p_project, kordos_identity.actor_id(), p_target,
    'connector.' || p_action, jsonb_strip_nulls(jsonb_build_object('mutationId', p_mutation, 'fingerprint', p_fingerprint)))
$$;

CREATE FUNCTION kordos_connectors.manage(p_id uuid, p_input jsonb, p_credential text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  action text := p_input->>'action';
  mutation uuid := (p_input->>'mutationId')::uuid;
  project uuid := (p_input->>'projectId')::uuid;
  installation public.connector_installations;
  mapping public.connector_mappings;
  previous public.audit_events;
BEGIN
  IF kordos_identity.current_role() IS DISTINCT FROM 'admin' THEN RETURN NULL; END IF;
  IF action NOT IN ('create','map','unmap','pause','resume','sync','disconnect','reconnect') THEN RETURN NULL; END IF;
  PERFORM kordos_planning.lock_workspace(mutation);
  IF kordos_identity.current_role() IS DISTINCT FROM 'admin' THEN RETURN NULL; END IF;

  SELECT * INTO previous FROM public.audit_events a
  WHERE (a.workspace_id,a.actor_id) = (tenant,actor)
    AND a.action LIKE 'connector.%' AND a.details->>'mutationId' = mutation::text LIMIT 1;
  IF FOUND THEN
    IF previous.target_id <> p_id OR previous.details->>'fingerprint' IS DISTINCT FROM p_fingerprint
      THEN RETURN jsonb_build_object('result','mutation_conflict'); END IF;
    RETURN jsonb_build_object('result','saved','id',p_id);
  END IF;

  IF action IN ('create','map') THEN
    PERFORM FROM public.projects p WHERE (p.workspace_id,p.id) = (tenant,project)
      AND p.archived_at IS NULL FOR SHARE;
    IF NOT FOUND OR kordos_planning.project_access(project) IS DISTINCT FROM 'lead' THEN RETURN NULL; END IF;
  END IF;

  IF action = 'create' THEN
    IF p_input->>'provider' IS DISTINCT FROM 'fixture' OR p_credential IS NULL OR p_id <> mutation
      THEN RETURN jsonb_build_object('result','invalid'); END IF;
    INSERT INTO public.connector_installations (id, workspace_id, owner_id, label, provider, credential)
    VALUES (p_id,tenant,actor,p_input->>'label',p_input->>'provider',p_credential)
    ON CONFLICT DO NOTHING RETURNING * INTO installation;
    IF NOT FOUND THEN RETURN jsonb_build_object('result','mutation_conflict'); END IF;
  ELSE
    SELECT * INTO installation FROM public.connector_installations i
    WHERE (i.workspace_id,i.id) = (tenant,p_id) FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF installation.version IS DISTINCT FROM (p_input->>'expectedVersion')::int THEN
      RETURN jsonb_build_object('result','conflict','current',kordos_connectors.health(installation));
    END IF;
    IF installation.state = 'disconnected' THEN RETURN jsonb_build_object('result','invalid'); END IF;
  END IF;

  IF action IN ('create','map') THEN
    -- A mapping binds the installation owner's grant to a project they can manage.
    IF installation.owner_id <> actor THEN RETURN NULL; END IF;
    INSERT INTO public.connector_mappings (workspace_id,installation_id,scope,project_id,audience)
    VALUES (tenant,p_id,p_input->>'scope',project,p_input->>'audience')
    ON CONFLICT DO NOTHING RETURNING * INTO mapping;
    IF NOT FOUND THEN RETURN jsonb_build_object('result','scope_exists'); END IF;
    PERFORM kordos_connectors.enqueue_sync(p_id,mapping.id);
  ELSIF action = 'unmap' THEN
    UPDATE public.connector_mappings SET revoked_at = clock_timestamp(), verified_until = NULL, checkpoint = NULL
    WHERE (workspace_id,installation_id,id) = (tenant,p_id,(p_input->>'mappingId')::uuid) AND revoked_at IS NULL
    RETURNING * INTO mapping;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT FROM public.connector_mappings WHERE installation_id = p_id AND revoked_at IS NULL) THEN
      UPDATE public.connector_installations SET state = 'paused',
        issue = CASE WHEN issue = 'credential_revoked' THEN issue END WHERE id = p_id;
    END IF;
    UPDATE public.connector_jobs SET state = 'canceled', finished_at = clock_timestamp()
    WHERE installation_id = p_id AND mapping_id = mapping.id AND state IN ('queued','running');
    INSERT INTO public.connector_jobs (workspace_id,installation_id,mapping_id,kind,available_at)
    VALUES (tenant,p_id,mapping.id,'cleanup',clock_timestamp() + interval '5 minutes');
  ELSIF action = 'disconnect' THEN
    UPDATE public.connector_installations SET state = 'disconnected', credential = NULL,
      issue = NULL WHERE id = p_id;
    UPDATE public.connector_mappings SET verified_until = NULL, checkpoint = NULL WHERE installation_id = p_id;
    UPDATE public.connector_jobs SET state = 'canceled', finished_at = clock_timestamp()
    WHERE installation_id = p_id AND kind <> 'cleanup' AND state IN ('queued','running');
    INSERT INTO public.connector_jobs (workspace_id,installation_id,kind,available_at)
    VALUES (tenant,p_id,'cleanup',clock_timestamp() + interval '5 minutes');
  ELSIF action = 'pause' AND installation.state = 'enabled' THEN
    UPDATE public.connector_installations SET state = 'paused' WHERE id = p_id;
    UPDATE public.connector_jobs SET state = 'queued', lease = NULL, lease_until = NULL,
      generation = generation + 1, attempts = greatest(attempts - 1, 0)
    WHERE installation_id = p_id AND kind IN ('sync','delivery') AND state = 'running';
  ELSIF action IN ('resume','reconnect','sync') THEN
    IF (action = 'reconnect' AND (actor <> installation.owner_id OR p_credential IS NULL))
      OR (action = 'resume' AND (installation.state <> 'paused' OR installation.issue = 'credential_revoked'))
      OR (action = 'sync' AND installation.state <> 'enabled')
      THEN RETURN jsonb_build_object('result','invalid'); END IF;
    IF action = 'reconnect' THEN
      UPDATE public.connector_mappings SET verified_until = NULL WHERE installation_id = p_id;
      UPDATE public.connector_jobs SET state = 'queued', lease = NULL, lease_until = NULL, attempts = 0,
        generation = generation + 1, available_at = clock_timestamp()
      WHERE installation_id = p_id AND kind IN ('sync','delivery') AND state IN ('queued','running');
    ELSE
      UPDATE public.connector_jobs SET available_at = clock_timestamp()
      WHERE installation_id = p_id AND kind IN ('sync','delivery') AND state = 'queued';
    END IF;
    UPDATE public.connector_installations SET state = 'enabled', issue = NULL,
      credential = coalesce(p_credential,credential) WHERE id = p_id;
    PERFORM kordos_connectors.enqueue_sync(p_id);
  ELSE
    RETURN jsonb_build_object('result','invalid');
  END IF;

  IF action <> 'create' THEN UPDATE public.connector_installations SET version = version + 1 WHERE id = p_id; END IF;
  PERFORM kordos_connectors.audit(NULL,p_id,action,mutation,p_fingerprint);
  RETURN jsonb_build_object('result','saved','id',p_id);
END
$$;

CREATE FUNCTION kordos_connectors.receive(
  p_installation uuid, p_delivery text, p_hash text, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  installation public.connector_installations;
  mapping public.connector_mappings;
  receipt public.connector_jobs;
BEGIN
  SELECT * INTO installation FROM public.connector_installations
  WHERE id = p_installation AND provider = 'fixture' AND state <> 'disconnected' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO receipt FROM public.connector_jobs WHERE (installation_id,delivery_id) = (p_installation,p_delivery);
  IF FOUND THEN
    IF receipt.delivery_hash IS DISTINCT FROM p_hash THEN RETURN jsonb_build_object('result','mutation_conflict'); END IF;
    RETURN jsonb_build_object('result','saved','id',receipt.id);
  END IF;
  SELECT * INTO mapping FROM public.connector_mappings
  WHERE installation_id = p_installation AND scope = p_payload->>'scope' AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.connector_jobs (workspace_id, installation_id, mapping_id, kind, delivery_id, delivery_hash, payload)
  VALUES (installation.workspace_id,p_installation,mapping.id,'delivery',p_delivery,p_hash,p_payload)
  RETURNING * INTO receipt;
  RETURN jsonb_build_object('result','saved','id',receipt.id);
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_connectors.owner_authorized(i public.connector_installations, m public.connector_mappings)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT FROM public.projects p
    JOIN public.memberships member ON (member.workspace_id,member.user_id) = (p.workspace_id,i.owner_id)
    JOIN public.project_members pm ON (pm.workspace_id,pm.project_id,pm.user_id) = (p.workspace_id,p.id,i.owner_id)
    WHERE (p.workspace_id,p.id) = (m.workspace_id,m.project_id) AND p.archived_at IS NULL
      AND member.removed_at IS NULL AND member.role <> 'viewer'
      AND pm.removed_at IS NULL AND pm.role IN ('lead','contributor')
  )
$$;

CREATE FUNCTION kordos_connectors.pending() RETURNS TABLE(id uuid, generation int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF pg_try_advisory_xact_lock(hashtextextended('kordos.connectors.schedule',0)) THEN
    INSERT INTO public.connector_jobs (workspace_id, installation_id, mapping_id, kind)
    SELECT m.workspace_id, m.installation_id, m.id, 'sync'
    FROM public.connector_mappings m JOIN public.connector_installations i ON i.id = m.installation_id
    WHERE i.state = 'enabled' AND m.revoked_at IS NULL AND m.next_sync <= statement_timestamp()
      AND NOT EXISTS (SELECT FROM public.connector_jobs j WHERE j.mapping_id = m.id AND j.kind = 'sync'
        AND j.state IN ('queued','running'))
    ORDER BY m.next_sync,m.id LIMIT 100 ON CONFLICT DO NOTHING;
  END IF;

  RETURN QUERY SELECT DISTINCT ON (j.installation_id) j.id,j.generation
  FROM public.connector_jobs j JOIN public.connector_installations i ON i.id = j.installation_id
  WHERE (j.kind = 'cleanup' OR (j.kind IN ('sync','delivery') AND i.state = 'enabled'))
    AND ((j.state = 'queued' AND j.available_at <= statement_timestamp())
      OR (j.state = 'running' AND j.lease_until <= statement_timestamp()))
    AND NOT EXISTS (SELECT FROM public.connector_jobs active WHERE active.installation_id = j.installation_id
      AND active.kind IN ('sync','delivery','cleanup') AND active.state = 'running' AND active.lease_until > statement_timestamp())
  ORDER BY j.installation_id,j.available_at,j.created_at,j.id LIMIT 100;
END
$$;

CREATE FUNCTION kordos_connectors.claim(p_job uuid, p_generation int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  job public.connector_jobs;
  installation public.connector_installations;
  mapping public.connector_mappings;
BEGIN
  SELECT * INTO installation FROM public.connector_installations
    WHERE id = (SELECT installation_id FROM public.connector_jobs WHERE id = p_job) FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.connector_jobs WHERE id = p_job AND generation = p_generation FOR UPDATE;
  IF NOT FOUND OR NOT coalesce((job.state = 'queued' AND job.available_at <= statement_timestamp())
    OR (job.state = 'running' AND job.lease_until <= statement_timestamp()),false)
    OR job.kind NOT IN ('sync','delivery','cleanup')
    OR (job.kind <> 'cleanup' AND installation.state <> 'enabled') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT FROM public.connector_jobs active WHERE active.installation_id = installation.id
    AND active.kind IN ('sync','delivery','cleanup') AND active.state = 'running' AND active.lease_until > statement_timestamp())
    THEN RETURN NULL; END IF;

  IF job.kind <> 'cleanup' THEN
    SELECT * INTO mapping FROM public.connector_mappings WHERE id = job.mapping_id AND revoked_at IS NULL;
    IF NOT FOUND OR NOT kordos_connectors.owner_authorized(installation,mapping) THEN
      UPDATE public.connector_jobs SET state = 'canceled', finished_at = clock_timestamp() WHERE id = p_job;
      UPDATE public.connector_mappings SET verified_until = NULL, next_sync = clock_timestamp() + interval '5 minutes' WHERE id = job.mapping_id;
      UPDATE public.connector_installations SET issue = 'scope_unavailable' WHERE id = installation.id;
      RETURN NULL;
    END IF;
  END IF;

  UPDATE public.connector_jobs SET state = 'running', attempts = attempts + 1,
    lease = gen_random_uuid(), lease_until = clock_timestamp() + interval '75 seconds'
  WHERE id = p_job RETURNING * INTO job;
  IF job.kind = 'cleanup' THEN RETURN jsonb_build_object('kind','cleanup','lease',job.lease); END IF;
  RETURN jsonb_build_object('kind',job.kind,'lease',job.lease,'workspaceId',installation.workspace_id,
    'installationId',installation.id,'provider',installation.provider,'credential',installation.credential,
    'scope',mapping.scope,'checkpoint',mapping.checkpoint,'delivery',job.payload);
END
$$;

CREATE FUNCTION kordos_connectors.apply_change(m public.connector_mappings, change jsonb, p_rebuild boolean) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  source public.source_objects;
  current_revision public.source_revisions;
  incoming_at timestamptz := (change->>'observedAt')::timestamptz;
  incoming_key text := change->>'revisionKey';
  gone boolean := change->>'kind' = 'delete';
BEGIN
  INSERT INTO public.source_objects (workspace_id,installation_id,mapping_id,project_id,external_id)
  VALUES (m.workspace_id,m.installation_id,m.id,m.project_id,change->>'externalId')
  ON CONFLICT (mapping_id,external_id) DO NOTHING;
  SELECT * INTO STRICT source FROM public.source_objects
  WHERE (mapping_id,external_id) = (m.id,change->>'externalId');
  SELECT * INTO current_revision FROM public.source_revisions
  WHERE (workspace_id,project_id,source_id,revision) = (m.workspace_id,m.project_id,source.id,source.revision);

  IF source.revision > 0 AND (incoming_at,incoming_key) < (current_revision.observed_at,current_revision.revision_key)
    THEN RETURN; END IF;
  IF EXISTS (SELECT FROM public.source_revisions r WHERE r.source_id = source.id AND r.revision_key = incoming_key) THEN
    IF EXISTS (SELECT FROM public.source_revisions r WHERE r.source_id = source.id AND r.revision_key = incoming_key
      AND (r.observed_at,r.title,r.body,r.url) IS DISTINCT FROM (incoming_at,change->>'title',change->>'body',change->>'url')) THEN
      RAISE EXCEPTION 'Conflicting source revision' USING ERRCODE = '22023';
    END IF;
    -- A complete rescan can restore a source that was withdrawn by an earlier rescan.
    IF incoming_key = current_revision.revision_key AND p_rebuild AND NOT gone THEN
      UPDATE public.source_objects SET withdrawn_at = NULL WHERE id = source.id;
    END IF;
    RETURN;
  END IF;
  INSERT INTO public.source_revisions (workspace_id,project_id,source_id,revision,revision_key,observed_at,title,body,url)
  VALUES (m.workspace_id,m.project_id,source.id,source.revision + 1,incoming_key,incoming_at,
    change->>'title',change->>'body',change->>'url');
  UPDATE public.source_objects SET revision = revision + 1,
    withdrawn_at = CASE WHEN gone THEN clock_timestamp() END WHERE id = source.id;
END
$$;

CREATE FUNCTION kordos_connectors.finish(p_job uuid, p_lease uuid, p_batch jsonb, p_issue text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  job public.connector_jobs;
  installation public.connector_installations;
  mapping public.connector_mappings;
  change jsonb;
  rebuild boolean := coalesce((p_batch->>'rebuild')::boolean,false);
  now_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO installation FROM public.connector_installations
  WHERE id = (SELECT installation_id FROM public.connector_jobs WHERE id = p_job) FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO job FROM public.connector_jobs WHERE id = p_job AND state = 'running'
    AND lease = p_lease AND lease_until > now_at FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF job.kind = 'cleanup' THEN
    -- Keep IDs and the revision key while removing mirrored text and raw payloads.
    UPDATE public.source_revisions r SET title = NULL, body = NULL, url = NULL
    FROM public.source_objects s WHERE (r.workspace_id,r.project_id,r.source_id) = (s.workspace_id,s.project_id,s.id)
      AND s.installation_id = installation.id AND (job.mapping_id IS NULL OR s.mapping_id = job.mapping_id);
    UPDATE public.connector_jobs SET payload = NULL WHERE installation_id = installation.id
      AND (job.mapping_id IS NULL OR mapping_id = job.mapping_id) AND kind <> 'cleanup';
  ELSE
    IF installation.state <> 'enabled' OR job.kind NOT IN ('sync','delivery') THEN RETURN false; END IF;
    SELECT * INTO mapping FROM public.connector_mappings WHERE id = job.mapping_id AND revoked_at IS NULL;
    IF NOT FOUND OR NOT kordos_connectors.owner_authorized(installation,mapping) THEN
      p_issue := 'scope_unavailable';
    END IF;
    IF p_issue IS NOT NULL THEN
      IF p_issue NOT IN ('credential_revoked','provider_unavailable','invalid_batch','scope_unavailable') THEN
        RAISE EXCEPTION 'Invalid connector result' USING ERRCODE = '22023';
      END IF;
      UPDATE public.connector_installations SET issue = p_issue,
        state = CASE WHEN p_issue = 'credential_revoked' THEN 'paused' ELSE state END,
        version = version + (p_issue = 'credential_revoked')::int WHERE id = installation.id;
      UPDATE public.connector_mappings SET verified_until = NULL, next_sync = now_at + interval '5 minutes'
        WHERE id = job.mapping_id OR (installation_id = installation.id AND p_issue = 'credential_revoked');

      IF p_issue = 'credential_revoked' OR (p_issue = 'provider_unavailable' AND job.attempts < 4) THEN
        UPDATE public.connector_jobs SET state = 'queued', lease = NULL, lease_until = NULL,
          generation = generation + 1,
          available_at = now_at + interval '5 seconds' * power(2,least(job.attempts - 1, 3))
        WHERE id = p_job;
      ELSE
        UPDATE public.connector_jobs SET state = 'failed', payload = NULL, finished_at = now_at,
          lease = NULL, lease_until = NULL WHERE id = p_job;
      END IF;
      RETURN true;
    END IF;

    IF jsonb_typeof(p_batch->'changes') IS DISTINCT FROM 'array'
      OR coalesce(p_batch->>'audience','') NOT IN ('project','private')
      OR (job.kind = 'sync' AND p_batch->>'checkpoint' IS NULL)
      OR (job.kind = 'delivery' AND (p_batch->>'checkpoint' IS NOT NULL OR rebuild))
    THEN RAISE EXCEPTION 'Invalid connector batch' USING ERRCODE = '22023'; END IF;

    FOR change IN SELECT value FROM jsonb_array_elements(p_batch->'changes') LOOP
      PERFORM kordos_connectors.apply_change(mapping,change,rebuild);
    END LOOP;
    IF rebuild THEN
      UPDATE public.source_objects s SET withdrawn_at = now_at
      WHERE s.mapping_id = mapping.id AND s.withdrawn_at IS NULL AND NOT EXISTS (
        SELECT FROM jsonb_array_elements(p_batch->'changes') entry
        WHERE entry->>'externalId' = s.external_id AND entry->>'kind' = 'upsert');
    END IF;
    UPDATE public.connector_mappings SET verified_until = now_at + interval '10 minutes',
      provider_audience = p_batch->>'audience',
      checkpoint = CASE WHEN job.kind = 'sync' THEN p_batch->>'checkpoint' ELSE checkpoint END,
      next_sync = CASE WHEN job.kind = 'sync' THEN now_at + interval '5 minutes' ELSE next_sync END,
      last_success = now_at WHERE id = mapping.id;
    UPDATE public.connector_installations SET last_success = now_at,
      issue = CASE WHEN EXISTS (SELECT FROM public.connector_mappings m WHERE m.installation_id = installation.id
        AND m.id <> mapping.id AND m.revoked_at IS NULL AND m.verified_until IS NULL)
        THEN issue END
      WHERE id = installation.id;
  END IF;
  UPDATE public.connector_jobs SET state = 'succeeded', payload = NULL, finished_at = now_at,
    lease = NULL, lease_until = NULL WHERE id = p_job;
  RETURN true;
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_connectors.mirror_allowed(s public.source_objects) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(s.withdrawn_at IS NULL AND EXISTS (
    SELECT FROM public.connector_mappings m
    JOIN public.connector_installations i ON (i.workspace_id,i.id) = (m.workspace_id,m.installation_id)
    WHERE (m.workspace_id,m.installation_id,m.id,m.project_id) = (s.workspace_id,s.installation_id,s.mapping_id,s.project_id)
      AND m.revoked_at IS NULL AND m.verified_until > statement_timestamp()
      AND i.state <> 'disconnected' AND i.issue IS DISTINCT FROM 'credential_revoked'
      AND kordos_connectors.owner_authorized(i,m)
      AND ((m.audience = 'project' AND m.provider_audience = 'project') OR i.owner_id = kordos_identity.actor_id())
  ),false)
  AND s.workspace_id = kordos_identity.workspace_id() AND kordos_planning.project_access(s.project_id) IS NOT NULL
$$;

CREATE FUNCTION kordos_connectors.sources(p_project uuid, p_cursor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH allowed AS (
    SELECT s.id,r.title,'mirror' AS kind,r.observed_at
    FROM public.source_objects s JOIN public.source_revisions r
      ON (r.workspace_id,r.project_id,r.source_id,r.revision) = (s.workspace_id,s.project_id,s.id,s.revision)
    WHERE (s.workspace_id,s.project_id) = (kordos_identity.workspace_id(),p_project)
      AND kordos_connectors.mirror_allowed(s)
    UNION ALL
    SELECT sh.id,sh.title,'share',sh.created_at FROM public.connector_shares sh
    WHERE (sh.workspace_id,sh.project_id) = (kordos_identity.workspace_id(),p_project) AND sh.revoked_at IS NULL
  ), page AS (
    SELECT * FROM allowed a WHERE p_cursor IS NULL OR (a.observed_at,a.id) <
      (SELECT observed_at,id FROM allowed WHERE id = p_cursor)
    ORDER BY a.observed_at DESC,a.id DESC LIMIT 31
  )
  SELECT jsonb_build_object('items', coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id',p.id,'title',p.title,'kind',p.kind,'observedAt',p.observed_at) ORDER BY p.observed_at DESC,p.id DESC)
    FROM (SELECT * FROM page ORDER BY observed_at DESC,id DESC LIMIT 30) p),'[]'),
    'nextCursor',CASE WHEN (SELECT count(*) FROM page) > 30
    THEN (SELECT id FROM page ORDER BY observed_at DESC,id DESC OFFSET 29 LIMIT 1) END)
  WHERE kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE FUNCTION kordos_connectors.source(p_project uuid, p_id uuid, p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id',s.id,'sourceId',s.id,'kind','mirror','revision',r.revision,
    'title',r.title,'body',r.body,'url',r.url,'observedAt',r.observed_at,'sharedBy',NULL,'canRevoke',false,
    'canShare',i.owner_id = kordos_identity.actor_id() AND r.revision = s.revision
      AND kordos_planning.project_access(p_project) IN ('lead','contributor'))
  FROM public.source_objects s
  JOIN public.source_revisions r ON (r.workspace_id,r.project_id,r.source_id,r.revision)
    = (s.workspace_id,s.project_id,s.id,coalesce(p_revision,s.revision))
  JOIN public.connector_installations i ON (i.workspace_id,i.id) = (s.workspace_id,s.installation_id)
  WHERE (s.workspace_id,s.project_id,s.id) = (kordos_identity.workspace_id(),p_project,p_id)
    AND r.body IS NOT NULL AND kordos_connectors.mirror_allowed(s)
  UNION ALL
  SELECT jsonb_build_object('id',sh.id,'sourceId',sh.source_id,'kind','share','revision',sh.revision,
    'title',sh.title,'body',sh.excerpt,'url',sh.url,'observedAt',sh.created_at,'sharedBy',u.name,'canShare',false,
    'canRevoke',sh.sharer_id = kordos_identity.actor_id() OR kordos_planning.project_access(p_project) = 'lead')
  FROM public.connector_shares sh JOIN public.users u ON u.id = sh.sharer_id
  WHERE (sh.workspace_id,sh.project_id,sh.id) = (kordos_identity.workspace_id(),p_project,p_id)
    AND (p_revision IS NULL OR sh.revision = p_revision)
    AND sh.revoked_at IS NULL AND kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE FUNCTION kordos_connectors.share(p_project uuid, p_source uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  revision int := (p_input->>'revision')::int;
  excerpt text := p_input->>'excerpt';
  source_record jsonb;
  previous public.connector_shares;
BEGIN
  IF kordos_planning.project_access(p_project) NOT IN ('lead','contributor')
    OR kordos_planning.project_access(p_project) IS NULL THEN RETURN NULL; END IF;
  PERFORM kordos_planning.lock_workspace(mutation);
  PERFORM FROM public.connector_installations i JOIN public.source_objects s
    ON (s.workspace_id,s.installation_id) = (i.workspace_id,i.id)
    WHERE (s.workspace_id,s.project_id,s.id) = (tenant,p_project,p_source) FOR SHARE OF i;
  SELECT * INTO previous FROM public.connector_shares sh WHERE sh.id = mutation AND sh.workspace_id = tenant
    AND sh.project_id = p_project AND sh.sharer_id = actor;
  IF FOUND THEN
    IF (previous.source_id,previous.revision,previous.excerpt) IS DISTINCT FROM (p_source,revision,excerpt)
      THEN RETURN jsonb_build_object('result','mutation_conflict'); END IF;
    RETURN jsonb_build_object('result','saved','id',previous.id);
  END IF;

  source_record := kordos_connectors.source(p_project,p_source,revision);
  IF source_record IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT FROM public.source_objects s WHERE s.id = mutation) THEN
    RETURN jsonb_build_object('result','mutation_conflict');
  END IF;
  IF NOT coalesce((source_record->>'canShare')::boolean,false) THEN RETURN jsonb_build_object('result','source_changed'); END IF;
  IF char_length(excerpt) NOT BETWEEN 1 AND 4000 OR btrim(excerpt) = ''
    OR position(excerpt IN source_record->>'body') = 0 THEN RETURN jsonb_build_object('result','invalid_excerpt'); END IF;

  INSERT INTO public.connector_shares (id,workspace_id,project_id,source_id,revision,sharer_id,title,excerpt,url)
  VALUES (mutation,tenant,p_project,p_source,revision,actor,source_record->>'title',excerpt,source_record->>'url')
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','mutation_conflict'); END IF;
  PERFORM kordos_connectors.audit(p_project,mutation,'share_created',mutation,NULL);
  RETURN jsonb_build_object('result','saved','id',mutation);
END
$$;

CREATE FUNCTION kordos_connectors.revoke_share(p_project uuid, p_share uuid, p_mutation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE share public.connector_shares;
BEGIN
  IF kordos_identity.current_role() IS NULL THEN RETURN NULL; END IF;
  PERFORM kordos_planning.lock_workspace(p_mutation);
  SELECT * INTO share FROM public.connector_shares sh
  WHERE (sh.workspace_id,sh.project_id,sh.id) = (kordos_identity.workspace_id(),p_project,p_share)
    AND (sh.sharer_id = kordos_identity.actor_id() OR kordos_planning.project_access(p_project) = 'lead') FOR UPDATE;
  IF NOT FOUND OR kordos_identity.current_role() IS NULL THEN RETURN NULL; END IF;
  IF share.revoked_at IS NULL THEN
    UPDATE public.connector_shares SET revoked_at = clock_timestamp() WHERE id = p_share;
    PERFORM kordos_connectors.audit(p_project,p_share,'share_revoked',p_mutation,NULL);
  END IF;
  RETURN jsonb_build_object('result','saved','id',share.id);
END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_connectors FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_connectors.directory(), kordos_connectors.manage(uuid,jsonb,text,text),
  kordos_connectors.receive(uuid,text,text,jsonb), kordos_connectors.sources(uuid,uuid),
  kordos_connectors.source(uuid,uuid,int), kordos_connectors.share(uuid,uuid,jsonb),
  kordos_connectors.revoke_share(uuid,uuid,uuid) TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_connectors.pending(), kordos_connectors.claim(uuid,int),
  kordos_connectors.finish(uuid,uuid,jsonb,text) TO kordos_brief_worker;
