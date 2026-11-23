CREATE TABLE "github_work_links" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	CONSTRAINT "github_work_links_workspace_id_project_id_source_id_work_id_pk" PRIMARY KEY("workspace_id","project_id","source_id","work_id")
);
--> statement-breakpoint
ALTER TABLE "proposal_revisions" DROP CONSTRAINT "proposal_revisions_command";--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT "proposals_one_target";--> statement-breakpoint
ALTER TABLE "connector_installations" ADD COLUMN "github_installation" text;--> statement-breakpoint
ALTER TABLE "connector_mappings" ADD COLUMN "github_repository" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "github_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "github_lease" uuid;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "github_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "github_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "github_remote" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "github_source_id" uuid;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD COLUMN "github" jsonb;--> statement-breakpoint
ALTER TABLE "github_work_links" ADD CONSTRAINT "github_work_links_source_fk" FOREIGN KEY ("workspace_id","project_id","source_id") REFERENCES "public"."source_objects"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_work_links" ADD CONSTRAINT "github_work_links_work_fk" FOREIGN KEY ("workspace_id","project_id","work_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_work_links_work_idx" ON "github_work_links" USING btree ("workspace_id","project_id","work_id");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_github_source_fk" FOREIGN KEY ("workspace_id","project_id","github_source_id") REFERENCES "public"."source_objects"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_installations_active_github" ON "connector_installations" USING btree ("workspace_id","github_installation") WHERE "connector_installations"."state" <> 'disconnected' AND "connector_installations"."github_installation" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "proposals_github_source_idx" ON "proposals" USING btree ("github_source_id");--> statement-breakpoint
ALTER TABLE "connector_installations" ADD CONSTRAINT "connector_installations_provider" CHECK (("connector_installations"."provider" = 'fixture' AND "connector_installations"."github_installation" IS NULL)
        OR ("connector_installations"."provider" = 'github' AND "connector_installations"."github_installation" ~ '^[1-9][0-9]{0,15}$' AND "connector_installations"."github_installation" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_command" CHECK (coalesce("proposal_revisions"."command"->>'kind' IN ('work.edit', 'plan.create', 'meeting.accept', 'github.comment'), false));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_one_target" CHECK (num_nonnulls("proposals"."work_id", "proposals"."brief_id", "proposals"."meeting_item_id", "proposals"."github_source_id") = 1);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION kordos_connectors.manage(p_id uuid, p_input jsonb, p_credential text, p_fingerprint text) RETURNS jsonb
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

  IF ((action='map' AND EXISTS (SELECT FROM public.connector_installations
    WHERE id=p_id AND workspace_id=tenant AND provider='github'))
    OR (action='create' AND p_input->>'provider'='github')) AND NOT coalesce(
      lower(p_input->>'scope') ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}$'
      AND split_part(p_input->>'scope','/',2) NOT IN ('.','..'),false)
  THEN RETURN jsonb_build_object('result','invalid'); END IF;

  IF action = 'create' THEN
    IF p_id <> mutation OR NOT coalesce(
      (p_input->>'provider' = 'fixture' AND p_credential IS NOT NULL AND p_input->>'installationId' IS NULL)
      OR (p_input->>'provider' = 'github' AND p_credential IS NULL AND p_input->>'installationId' ~ '^[1-9][0-9]{0,15}$'),false)
      THEN RETURN jsonb_build_object('result','invalid'); END IF;
    INSERT INTO public.connector_installations (id, workspace_id, owner_id, label, provider, credential, github_installation)
    VALUES (p_id,tenant,actor,p_input->>'label',p_input->>'provider',p_credential,p_input->>'installationId')
    ON CONFLICT DO NOTHING RETURNING * INTO installation;
    IF NOT FOUND THEN RETURN jsonb_build_object('result',CASE WHEN p_input->>'provider'='github'
      THEN 'scope_exists' ELSE 'mutation_conflict' END); END IF;
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
    VALUES (tenant,p_id,CASE WHEN installation.provider = 'github' THEN lower(p_input->>'scope') ELSE p_input->>'scope' END,project,p_input->>'audience')
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
    IF (action = 'reconnect' AND (actor <> installation.owner_id OR (p_credential IS NULL) <> (installation.provider = 'github')))
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

CREATE OR REPLACE FUNCTION kordos_connectors.claim(p_job uuid, p_generation int) RETURNS jsonb
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
    'scope',mapping.scope,'checkpoint',mapping.checkpoint,
    'githubInstallation',installation.github_installation,
    'delivery',CASE WHEN installation.provider = 'fixture' THEN job.payload END,
    'githubDelivery',CASE WHEN installation.provider = 'github' THEN job.payload END);
END
$$;

CREATE OR REPLACE FUNCTION kordos_connectors.apply_change(m public.connector_mappings, change jsonb, p_rebuild boolean) RETURNS void
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

  IF source.revision > 0 AND (CASE WHEN m.github_repository IS NOT NULL
    THEN incoming_at < current_revision.observed_at AND source.withdrawn_at IS NULL
    ELSE (incoming_at,incoming_key) < (current_revision.observed_at,current_revision.revision_key) END)
    THEN RETURN; END IF;
  IF m.github_repository IS NOT NULL THEN
    -- GitHub timestamps have one-second resolution. Workers serialize canonical reads,
    -- so the later read wins ties. A repeated delete is already reflected in the mirror.
    IF gone AND (source.withdrawn_at IS NOT NULL OR source.revision = 0) THEN
      DELETE FROM public.source_objects WHERE id=source.id AND revision=0;
      RETURN;
    END IF;
    IF NOT gone AND incoming_key = split_part(current_revision.revision_key,':',1) THEN
      UPDATE public.source_objects SET withdrawn_at=NULL WHERE id=source.id AND withdrawn_at IS NOT NULL;
      RETURN;
    END IF;
    incoming_key := incoming_key || ':' || (source.revision + 1)::text;
  END IF;
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
  INSERT INTO public.source_revisions (workspace_id,project_id,source_id,revision,revision_key,observed_at,title,body,url,github)
  VALUES (m.workspace_id,m.project_id,source.id,source.revision + 1,incoming_key,incoming_at,
    change->>'title',change->>'body',change->>'url',CASE WHEN m.github_repository IS NOT NULL THEN change->'github' END);
  UPDATE public.source_objects SET revision = revision + 1,
    withdrawn_at = CASE WHEN gone THEN clock_timestamp() END WHERE id = source.id;
END
$$;

CREATE OR REPLACE FUNCTION kordos_connectors.finish(p_job uuid, p_lease uuid, p_batch jsonb, p_issue text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  job public.connector_jobs;
  installation public.connector_installations;
  mapping public.connector_mappings;
  change jsonb;
  rebuild boolean := coalesce((p_batch->>'rebuild')::boolean,false);
  now_at timestamptz := clock_timestamp();
  repo text := p_batch->>'repositoryId';
BEGIN
  SELECT * INTO installation FROM public.connector_installations
  WHERE id = (SELECT installation_id FROM public.connector_jobs WHERE id = p_job) FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO job FROM public.connector_jobs WHERE id = p_job AND state = 'running'
    AND lease = p_lease AND lease_until > now_at FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF job.kind = 'cleanup' THEN
    -- Keep IDs and the revision key while removing mirrored text and raw payloads.
    UPDATE public.source_revisions r SET title = NULL, body = NULL, url = NULL, github = NULL
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
    IF p_issue IS NULL AND installation.provider='github' AND (repo IS NULL
      OR (mapping.github_repository IS NOT NULL AND mapping.github_repository <> repo)) THEN
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

    IF installation.provider = 'github' AND mapping.github_repository IS NULL THEN
      UPDATE public.connector_mappings SET github_repository=repo WHERE id=mapping.id RETURNING * INTO mapping;
    END IF;
    FOR change IN SELECT value FROM jsonb_array_elements(p_batch->'changes') LOOP
      IF installation.provider='github' AND change->>'kind'='upsert'
        AND (change->'github'->>'repositoryId' IS DISTINCT FROM repo
          OR change->'github'->>'repository' IS DISTINCT FROM mapping.scope) THEN
        RAISE EXCEPTION 'Invalid GitHub repository' USING ERRCODE = '22023';
      END IF;
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

CREATE SCHEMA kordos_github;
REVOKE ALL ON SCHEMA kordos_github FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_github TO kordos_app, kordos_brief_worker;
ALTER TABLE public.github_work_links ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION kordos_github.receive(p_workspace uuid, p_installation text, p_delivery text, p_hash text, p_scope text, p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  i public.connector_installations;
  m public.connector_mappings;
  j public.connector_jobs;
BEGIN
  SELECT * INTO i FROM public.connector_installations
    WHERE workspace_id=p_workspace AND github_installation=p_installation AND state<>'disconnected' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO j FROM public.connector_jobs WHERE (installation_id,delivery_id)=(i.id,p_delivery);
  IF FOUND THEN
    IF j.delivery_hash IS DISTINCT FROM p_hash THEN RETURN jsonb_build_object('result','mutation_conflict'); END IF;
    RETURN jsonb_build_object('result','saved','id',j.id);
  END IF;
  SELECT * INTO m FROM public.connector_mappings
    WHERE installation_id=i.id AND scope=p_scope AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.connector_jobs (workspace_id,installation_id,mapping_id,kind,delivery_id,delivery_hash,payload)
    VALUES(i.workspace_id,i.id,m.id,'delivery',p_delivery,p_hash,p_event) RETURNING * INTO j;
  RETURN jsonb_build_object('result','saved','id',j.id);
END
$$;

CREATE FUNCTION kordos_github.invalidate(p_workspace uuid, p_installation text, p_repositories jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i public.connector_installations;
BEGIN
  SELECT * INTO i FROM public.connector_installations
    WHERE workspace_id=p_workspace AND github_installation=p_installation AND state<>'disconnected' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  WITH scopes AS (
    UPDATE public.connector_mappings m SET verified_until=NULL, next_sync=clock_timestamp()
      WHERE m.installation_id=i.id AND m.revoked_at IS NULL
        AND (p_repositories IS NULL OR p_repositories ? m.scope)
      RETURNING m.id
  )
  UPDATE public.connector_jobs j SET state='canceled',lease=NULL,lease_until=NULL,finished_at=clock_timestamp(),payload=NULL
    FROM scopes WHERE j.mapping_id=scopes.id AND j.kind IN ('sync','delivery') AND j.state IN ('queued','running');
END
$$;

CREATE FUNCTION kordos_github.destination(g jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN g IS NOT NULL THEN jsonb_build_object(
    'repository',g->'repository','repositoryId',g->'repositoryId','number',g->'number',
    'kind',g->'kind','nodeId',g->'nodeId') END
$$;

CREATE FUNCTION kordos_github.linked(s public.source_objects, r public.source_revisions, w uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(r.github->'workIds' ? w::text,false) OR EXISTS (
    SELECT FROM public.github_work_links l WHERE (l.workspace_id,l.project_id,l.source_id,l.work_id)
      =(s.workspace_id,s.project_id,s.id,w))
$$;

CREATE FUNCTION kordos_github.destination_allowed(s public.source_objects) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT kordos_connectors.mirror_allowed(s) AND EXISTS (
    SELECT FROM public.connector_installations i
    JOIN public.connector_mappings m ON (m.workspace_id,m.installation_id)=(i.workspace_id,i.id)
    WHERE (m.workspace_id,m.id)=(s.workspace_id,s.mapping_id) AND i.provider='github'
      AND i.state='enabled' AND m.github_repository IS NOT NULL
  ) AND EXISTS (
    SELECT FROM public.source_revisions r
    JOIN public.work_items w ON (w.workspace_id,w.project_id)=(r.workspace_id,r.project_id)
    WHERE r.source_id=s.id AND r.revision=s.revision AND w.archived_at IS NULL
      AND w.id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(r.github->'workIds')
        UNION ALL
        SELECT l.work_id FROM public.github_work_links l
          WHERE (l.workspace_id,l.project_id,l.source_id)=(s.workspace_id,s.project_id,s.id)
      )
  )
$$;

CREATE FUNCTION kordos_github.activity(p_project uuid, p_work uuid, p_after uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH allowed AS (
    SELECT s.id,s.revision,r.title,r.observed_at,r.github
    FROM public.source_objects s
    JOIN public.source_revisions r ON (r.workspace_id,r.project_id,r.source_id,r.revision)
      =(s.workspace_id,s.project_id,s.id,s.revision)
    WHERE (s.workspace_id,s.project_id)=(kordos_identity.workspace_id(),p_project)
      AND r.github IS NOT NULL AND kordos_connectors.mirror_allowed(s)
      AND (p_work IS NULL OR kordos_github.linked(s,r,p_work))
  ), page AS (
    SELECT * FROM allowed a WHERE p_after IS NULL OR (a.observed_at,a.id) <
      (SELECT observed_at,id FROM allowed WHERE id=p_after)
    ORDER BY observed_at DESC,id DESC LIMIT 31
  )
  SELECT jsonb_build_object(
    'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'revision',revision,
      'title',title,'observedAt',observed_at,'github',github) ORDER BY observed_at DESC,id DESC)
      FROM (SELECT * FROM page ORDER BY observed_at DESC,id DESC LIMIT 30) visible),'[]'),
    'nextCursor',CASE WHEN (SELECT count(*) FROM page)>30
      THEN (SELECT id FROM page ORDER BY observed_at DESC,id DESC OFFSET 29 LIMIT 1) END)
  WHERE kordos_planning.project_access(p_project) IS NOT NULL AND (p_work IS NULL OR EXISTS (
    SELECT FROM public.work_items w WHERE (w.workspace_id,w.project_id,w.id)=(kordos_identity.workspace_id(),p_project,p_work)))
$$;

CREATE FUNCTION kordos_github.link_work(p_project uuid, p_source uuid, p_work uuid, p_mutation uuid, p_linked boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  s public.source_objects;
  existing public.outbox;
  command jsonb := jsonb_build_object('mutationId',p_mutation,'_command','github.link','workId',p_work,'linked',p_linked);
BEGIN
  PERFORM kordos_planning.lock_workspace(p_mutation);
  PERFORM kordos_reviews.lock_projects(p_project,'[]');
  IF kordos_planning.project_access(p_project) IS DISTINCT FROM 'lead' THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.source_objects
    WHERE (workspace_id,project_id,id)=(tenant,p_project,p_source);
  IF NOT FOUND OR NOT kordos_connectors.mirror_allowed(s) OR NOT EXISTS (
    SELECT FROM public.source_revisions r WHERE r.source_id=s.id AND r.revision=s.revision AND r.github IS NOT NULL
  ) OR NOT EXISTS (
    SELECT FROM public.work_items w JOIN public.projects p ON (p.workspace_id,p.id)=(w.workspace_id,w.project_id)
    WHERE (w.workspace_id,w.project_id,w.id)=(tenant,p_project,p_work)
      AND w.archived_at IS NULL AND p.archived_at IS NULL
  ) THEN RETURN NULL; END IF;
  SELECT * INTO existing FROM public.outbox WHERE workspace_id=tenant AND actor_id=actor AND mutation_id=p_mutation;
  IF FOUND THEN
    IF (existing.project_id,existing.target_id,existing.request) IS DISTINCT FROM (p_project,p_source,command)
    THEN RETURN jsonb_build_object('result','mutation_conflict'); END IF;
    RETURN jsonb_build_object('result','saved','id',p_source);
  END IF;
  IF p_linked THEN
    INSERT INTO public.github_work_links VALUES(tenant,p_project,p_source,p_work) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.github_work_links WHERE (workspace_id,project_id,source_id,work_id)=(tenant,p_project,p_source,p_work);
  END IF;
  PERFORM kordos_planning.emit(p_project,p_source,'github.work_link_changed',command,NULL,
    jsonb_build_object('workId',p_work,'linked',p_linked));
  RETURN jsonb_build_object('result','saved','id',p_source);
END
$$;

ALTER FUNCTION kordos_connectors.source(uuid,uuid,int) RENAME TO source_before_github;
REVOKE EXECUTE ON FUNCTION kordos_connectors.source_before_github(uuid,uuid,int) FROM kordos_app;
CREATE FUNCTION kordos_connectors.source(p_project uuid,p_id uuid,p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT original || CASE WHEN r.github IS NOT NULL THEN jsonb_build_object('github',r.github,
    'canDraftComment',kordos_github.destination_allowed(s) AND p.archived_at IS NULL
      AND kordos_planning.project_access(p_project) IN ('lead','contributor'),
    'canLinkWork',p.archived_at IS NULL AND kordos_planning.project_access(p_project)='lead',
    'linkedWork',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'title',w.title,
      'confirmed',l.work_id IS NOT NULL) ORDER BY w.title,w.id),'[]')
      FROM public.work_items w
      LEFT JOIN public.github_work_links l ON (l.workspace_id,l.project_id,l.source_id,l.work_id)
        =(w.workspace_id,w.project_id,s.id,w.id)
      WHERE (w.workspace_id,w.project_id)=(s.workspace_id,s.project_id)
        AND (l.work_id IS NOT NULL OR r.github->'workIds' ? w.id::text))) ELSE '{}' END
  FROM kordos_connectors.source_before_github(p_project,p_id,p_revision) original
  LEFT JOIN public.source_objects s ON (s.workspace_id,s.project_id,s.id)=(kordos_identity.workspace_id(),p_project,p_id)
    AND original->>'kind'='mirror'
  LEFT JOIN public.source_revisions r ON r.source_id=s.id AND r.revision=coalesce(p_revision,s.revision)
  LEFT JOIN public.projects p ON (p.workspace_id,p.id)=(s.workspace_id,s.project_id)
$$;

REVOKE EXECUTE ON FUNCTION kordos_connectors.source(uuid,uuid,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_connectors.source(uuid,uuid,int) TO kordos_app;

CREATE OR REPLACE FUNCTION kordos_reviews.can_read(p public.proposals) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT p.workspace_id=kordos_identity.workspace_id()
    AND kordos_planning.project_access(p.project_id) IS NOT NULL
    AND (p.status<>'draft' OR p.submitted_at IS NOT NULL
      OR p.requester_id=kordos_identity.actor_id() OR kordos_planning.project_access(p.project_id)='lead')
    AND (p.github_source_id IS NULL OR kordos_identity.actor_id() IN (p.requester_id,p.reviewer_id)
      OR EXISTS (SELECT FROM public.source_objects s WHERE s.id=p.github_source_id AND kordos_connectors.mirror_allowed(s)))
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.summary(
  p public.proposals, project public.projects, w public.work_items, r public.proposal_revisions
) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',p.id,'projectId',p.project_id,'projectName',project.name,
    'workId',w.id,'briefId',p.brief_id,'meetingId',r.before->>'meetingId','meetingItemId',p.meeting_item_id,
    'githubSourceId',s.id,
    'title',CASE WHEN p.github_source_id IS NOT NULL AND s.id IS NULL THEN 'GitHub comment'
      ELSE coalesce(w.title,r.before->>'title') END,
    'kind',coalesce(w.kind::text,CASE WHEN p.meeting_item_id IS NOT NULL THEN 'meeting'
      WHEN p.github_source_id IS NOT NULL THEN 'github' ELSE 'plan' END),
    'revision',r.revision,'status',kordos_reviews.effective_status(p,r),
    'requester',kordos_collaboration.person(p.requester_id),
    'requestedAt',CASE WHEN p.status='draft' THEN r.created_at ELSE coalesce(p.submitted_at,r.created_at) END)
  FROM (SELECT 1) base
  LEFT JOIN public.source_objects s ON s.id=p.github_source_id AND kordos_connectors.mirror_allowed(s)
$$;

ALTER FUNCTION kordos_reviews.detail(uuid,int) RENAME TO detail_before_github;
REVOKE EXECUTE ON FUNCTION kordos_reviews.detail_before_github(uuid,int) FROM kordos_app;
CREATE FUNCTION kordos_reviews.detail(p_id uuid,p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT view || CASE WHEN view->>'kind'='github' THEN jsonb_build_object(
    'githubComment',CASE WHEN visible THEN r.command END,
    'evidenceRestricted',NOT visible,
    'canEdit',available AND at_head AND p.status IN ('draft','pending','expired','stale','failed')
      AND (access='lead' OR (access='contributor' AND p.requester_id=kordos_identity.actor_id())),
    'canSubmit',available AND at_head AND p.status='draft' AND p.reviewer_id IS NULL
      AND r.expires_at>statement_timestamp()
      AND (access='lead' OR (access='contributor' AND p.requester_id=kordos_identity.actor_id())),
    'canReview',available AND at_head AND p.status='pending' AND r.expires_at>statement_timestamp() AND access='lead',
    'receipt',CASE WHEN jsonb_typeof(view->'receipt')='object' THEN
      view->'receipt' || jsonb_build_object('remote',CASE WHEN visible THEN e.github_remote END) END
    ) ELSE '{}' END
  FROM kordos_reviews.detail_before_github(p_id,p_revision) view
  LEFT JOIN public.proposals p ON p.id=p_id AND view->>'kind'='github'
  LEFT JOIN public.source_objects s ON s.id=p.github_source_id
  LEFT JOIN public.projects project ON (project.workspace_id,project.id)=(p.workspace_id,p.project_id)
  LEFT JOIN public.proposal_revisions r ON (r.workspace_id,r.project_id,r.proposal_id,r.revision)
    =(p.workspace_id,p.project_id,p.id,coalesce(p_revision,p.revision))
  LEFT JOIN public.executions e ON e.id=(view->'receipt'->>'id')::uuid
  CROSS JOIN LATERAL (SELECT s.id IS NOT NULL AND kordos_connectors.mirror_allowed(s) AS visible,
    s.id IS NOT NULL AND kordos_github.destination_allowed(s) AND project.archived_at IS NULL AS available,
    p.revision=r.revision AS at_head,kordos_planning.project_access(p.project_id) AS access) permissions
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.detail(uuid,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.detail(uuid,int) TO kordos_app;

CREATE FUNCTION kordos_github.mutate(p_project uuid,p_id uuid,p_action text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  project uuid := p_project;
  wanted int := (p_input->>'revision')::int;
  access public.project_role;
  p public.proposals;
  r public.proposal_revisions;
  s public.source_objects;
  source public.source_revisions;
  existing public.outbox;
  request jsonb;
  receipt uuid;
  event uuid;
  message text := p_input->>'body';
  effect_body text;
BEGIN
  IF p_action NOT IN ('create','revise','submit','approve','reject','request_edit') THEN
    RETURN jsonb_build_object('result','invalid_state');
  END IF;
  IF p_action<>'create' THEN
    SELECT * INTO p FROM public.proposals WHERE workspace_id=tenant AND id=p_id AND github_source_id IS NOT NULL;
    project := p.project_id;
  END IF;
  PERFORM kordos_planning.lock_workspace(mutation);
  PERFORM kordos_reviews.lock_projects(project,'[]');
  access := kordos_planning.project_access(project);
  IF access IS NULL OR access='viewer' THEN RETURN jsonb_build_object('result','unavailable'); END IF;
  IF (p_action IN ('approve','reject','request_edit') OR
    (p_action IN ('revise','submit') AND p.requester_id<>actor)) AND access<>'lead' THEN
    RETURN jsonb_build_object('result','forbidden');
  END IF;
  IF p_action<>'create' THEN
    SELECT * INTO STRICT p FROM public.proposals WHERE id=p_id AND workspace_id=tenant FOR UPDATE;
    IF NOT kordos_reviews.can_read(p) THEN RETURN jsonb_build_object('result','unavailable'); END IF;
  END IF;

  request := jsonb_build_object('mutationId',mutation,'_command','proposal.'||p_action,
    'hash',encode(sha256(convert_to(jsonb_build_array(p_id,p_input)::text,'UTF8')),'hex'));
  SELECT * INTO existing FROM public.outbox WHERE workspace_id=tenant AND actor_id=actor AND mutation_id=mutation;
  IF FOUND THEN
    IF existing.project_id<>project OR (existing.request-'revision')<>request THEN
      RETURN jsonb_build_object('result','mutation_conflict');
    END IF;
    SELECT id INTO receipt FROM public.executions WHERE approval_audit_id=existing.id;
    RETURN jsonb_strip_nulls(jsonb_build_object('result','saved','id',existing.target_id,
      'revision',existing.request->'revision','receiptId',receipt));
  END IF;

  IF p_action='approve' THEN
    SELECT id INTO receipt FROM public.executions WHERE proposal_id=p.id AND revision=wanted;
    IF FOUND THEN
      RETURN jsonb_build_object('result','saved','id',p.id,'revision',wanted,'receiptId',receipt);
    END IF;
  END IF;
  IF p_action<>'create' THEN
    IF (p.revision,p.version) IS DISTINCT FROM (wanted,(p_input->>'expectedVersion')::int) THEN
      RETURN jsonb_build_object('result','conflict');
    END IF;
    SELECT * INTO STRICT r FROM public.proposal_revisions WHERE proposal_id=p.id AND revision=p.revision;
  END IF;

  SELECT * INTO s FROM public.source_objects WHERE (workspace_id,project_id,id)
    =(tenant,project,coalesce(p.github_source_id,(p_input->>'githubSourceId')::uuid));
  IF NOT FOUND OR NOT kordos_connectors.mirror_allowed(s) THEN
    RETURN jsonb_build_object('result','unavailable');
  END IF;
  IF NOT EXISTS (SELECT FROM public.projects WHERE (workspace_id,id)=(tenant,project) AND archived_at IS NULL) THEN
    RETURN jsonb_build_object('result','invalid_state');
  END IF;
  SELECT * INTO source FROM public.source_revisions WHERE source_id=s.id AND revision=s.revision;
  IF source.github IS NULL THEN RETURN jsonb_build_object('result','unavailable'); END IF;
  IF p_action IN ('create','revise','submit','approve') AND NOT kordos_github.destination_allowed(s) THEN
    RETURN jsonb_build_object('result','evidence_changed');
  END IF;

  IF p_action IN ('create','revise') THEN
    IF message IS NULL OR btrim(message,E' \t\n')='' OR length(message)>12000 OR strpos(message,E'\r')>0
      OR (p_action='revise' AND p.status NOT IN ('draft','pending','expired','stale','failed')) THEN
      RETURN jsonb_build_object('result','invalid_state');
    END IF;
    IF p_action='create' THEN
      INSERT INTO public.proposals(workspace_id,project_id,github_source_id,requester_id)
        VALUES(tenant,project,s.id,actor) RETURNING * INTO p;
    ELSE
      UPDATE public.proposals SET revision=revision+1,version=version+1,status='draft',reviewer_id=NULL,
        reviewed_at=NULL,reason=NULL WHERE id=p.id RETURNING * INTO p;
    END IF;
    effect_body := message || E'\n\n<!-- Kordos delivery ' || p.id::text || '/' || p.revision::text || ' -->';
    INSERT INTO public.proposal_revisions(workspace_id,project_id,proposal_id,revision,author_id,
      target_version,command,before,evidence,expires_at)
    VALUES(tenant,project,p.id,p.revision,actor,source.revision,
      jsonb_build_object('kind','github.comment','destination',kordos_github.destination(source.github),'message',message,'body',effect_body),
      jsonb_build_object('title',source.title),'[]',clock_timestamp()+interval '7 days');
  ELSIF (p_action='submit' AND p.status='draft' AND p.reviewer_id IS NULL)
      OR (p_action IN ('approve','reject','request_edit') AND p.status='pending') THEN
    IF r.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('result','expired'); END IF;
    IF p_action IN ('submit','approve') AND kordos_github.destination(source.github) IS DISTINCT FROM r.command->'destination' THEN
      RETURN jsonb_build_object('result','evidence_changed');
    END IF;
    IF p_action='approve' THEN
      PERFORM set_config('kordos.actor_id',p.requester_id::text,true);
      IF coalesce(kordos_planning.project_access(project)::text,'viewer')='viewer'
        OR NOT kordos_github.destination_allowed(s) THEN
        PERFORM set_config('kordos.actor_id',actor::text,true);
        RETURN jsonb_build_object('result','evidence_changed');
      END IF;
      PERFORM set_config('kordos.actor_id',actor::text,true);
    END IF;
    UPDATE public.proposals SET status=(CASE p_action WHEN 'submit' THEN 'pending'
      WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'draft' END)::public.proposal_status,
      version=version+1,submitted_at=CASE WHEN p_action='submit' THEN clock_timestamp() ELSE submitted_at END,
      reviewer_id=CASE WHEN p_action<>'submit' THEN actor END,
      reviewed_at=CASE WHEN p_action<>'submit' THEN clock_timestamp() END,
      reason=p_input->>'reason' WHERE id=p.id RETURNING * INTO p;
  ELSE RETURN jsonb_build_object('result','invalid_state');
  END IF;

  request := request || jsonb_build_object('revision',p.revision);
  IF p_action='approve' THEN
    receipt := gen_random_uuid();
    event := kordos_reviews.event(p,'proposal.approved',request,receipt);
    INSERT INTO public.executions(id,workspace_id,project_id,proposal_id,revision,reviewer_id,authority,approval_audit_id)
      VALUES(receipt,tenant,project,p.id,p.revision,actor,jsonb_build_object(
        'requester',kordos_reviews.authority(p.requester_id,project,'[]'),
        'reviewer',kordos_reviews.authority(actor,project,'[]')),event);
  ELSE
    PERFORM kordos_reviews.event(p,CASE p_action WHEN 'create' THEN 'proposal.drafted' WHEN 'revise' THEN 'proposal.revised'
      WHEN 'submit' THEN 'proposal.submitted' WHEN 'reject' THEN 'proposal.rejected' ELSE 'proposal.edits_requested' END,request);
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('result','saved','id',p.id,'revision',p.revision,'receiptId',receipt));
END
$$;

ALTER FUNCTION kordos_reviews.mutate(uuid,uuid,text,jsonb) RENAME TO mutate_before_github;
REVOKE EXECUTE ON FUNCTION kordos_reviews.mutate_before_github(uuid,uuid,text,jsonb) FROM kordos_app;
CREATE FUNCTION kordos_reviews.mutate(p_project uuid,p_id uuid,p_action text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF (p_action='create' AND p_input ? 'githubSourceId') OR EXISTS (
    SELECT FROM public.proposals WHERE workspace_id=kordos_identity.workspace_id() AND id=p_id AND github_source_id IS NOT NULL)
  THEN
    RETURN kordos_github.mutate(p_project,p_id,p_action,p_input);
  END IF;
  IF p_action='revise' AND p_input ? 'body' THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
  RETURN kordos_reviews.mutate_before_github(p_project,p_id,p_action,p_input);
END
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.mutate(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.mutate(uuid,uuid,text,jsonb) TO kordos_app;

CREATE OR REPLACE FUNCTION kordos_reviews.pending() RETURNS TABLE(id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT e.id FROM public.executions e JOIN public.outbox o ON o.id=e.approval_audit_id
  JOIN public.proposals p ON p.id=e.proposal_id
  WHERE e.status IN ('approved','applying') AND o.delivered_at IS NULL AND p.github_source_id IS NULL
  ORDER BY e.approved_at,e.id LIMIT 50
$$;

ALTER FUNCTION kordos_reviews.run(uuid,text) RENAME TO run_before_github;
REVOKE EXECUTE ON FUNCTION kordos_reviews.run_before_github(uuid,text) FROM kordos_app;
CREATE FUNCTION kordos_reviews.run(p_execution uuid,p_step text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT CASE WHEN EXISTS (SELECT FROM public.executions e JOIN public.proposals p ON p.id=e.proposal_id
    WHERE e.id=p_execution AND p.github_source_id IS NOT NULL) THEN false
    ELSE kordos_reviews.run_before_github(p_execution,p_step) END
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.run(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.run(uuid,text) TO kordos_app;

CREATE FUNCTION kordos_github.pending() RETURNS TABLE(id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT e.id FROM public.executions e JOIN public.proposals p ON p.id=e.proposal_id
  WHERE p.github_source_id IS NOT NULL AND e.status IN ('approved','applying')
    AND (e.github_next_at IS NULL OR e.github_next_at<=statement_timestamp())
  ORDER BY e.approved_at,e.id LIMIT 50
$$;

CREATE FUNCTION kordos_github.execute(p_id uuid,p_step text,p_lease uuid,p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  e public.executions;
  p public.proposals;
  s public.source_objects;
  r public.proposal_revisions;
  dest jsonb;
  i public.connector_installations;
  reviewer_allowed boolean;
  requester_allowed boolean;
  current_destination jsonb;
  effect uuid;
  attempt_at timestamptz := clock_timestamp();
BEGIN
  IF p_step NOT IN ('claim','start','complete','retry','refuse') THEN RETURN NULL; END IF;
  SELECT * INTO e FROM public.executions WHERE id=p_id AND status IN ('approved','applying');
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM set_config('kordos.workspace_id',e.workspace_id::text,true);
  PERFORM set_config('kordos.actor_id',e.reviewer_id::text,true);
  PERFORM kordos_planning.lock_workspace(e.write_mutation_id);
  PERFORM kordos_reviews.lock_projects(e.project_id,'[]');
  SELECT * INTO STRICT p FROM public.proposals WHERE id=e.proposal_id FOR UPDATE;
  SELECT * INTO STRICT e FROM public.executions WHERE id=p_id FOR UPDATE;
  IF p.github_source_id IS NULL OR p.revision<>e.revision OR e.status NOT IN ('approved','applying') THEN RETURN NULL; END IF;
  IF p_step='claim' THEN
    IF e.github_next_at>attempt_at THEN RETURN NULL; END IF;
  ELSIF e.github_lease IS DISTINCT FROM p_lease OR p_lease IS NULL OR e.github_next_at<=attempt_at THEN
    RETURN NULL;
  END IF;
  SELECT * INTO STRICT r FROM public.proposal_revisions WHERE proposal_id=p.id AND revision=e.revision;
  dest := r.command->'destination';
  SELECT * INTO STRICT s FROM public.source_objects WHERE id=p.github_source_id;
  SELECT * INTO STRICT i FROM public.connector_installations WHERE id=s.installation_id FOR UPDATE;

  IF p_step IN ('claim','start') AND e.github_started_at IS NULL THEN
    reviewer_allowed := kordos_planning.project_access(p.project_id)='lead' AND
      kordos_reviews.authority(e.reviewer_id,p.project_id,'[]') IS NOT DISTINCT FROM e.authority->'reviewer';
    IF reviewer_allowed IS DISTINCT FROM true THEN
      PERFORM kordos_reviews.finish(e,p,'stale','access_changed'); RETURN NULL;
    END IF;
    IF r.expires_at<=attempt_at THEN
      PERFORM kordos_reviews.finish(e,p,'expired','expired'); RETURN NULL;
    END IF;
    SELECT kordos_github.destination(github) INTO current_destination
      FROM public.source_revisions WHERE source_id=s.id AND revision=s.revision;
    IF NOT kordos_github.destination_allowed(s) OR dest IS DISTINCT FROM current_destination THEN
      PERFORM kordos_reviews.finish(e,p,'stale','destination_unavailable'); RETURN NULL;
    END IF;
    PERFORM set_config('kordos.actor_id',p.requester_id::text,true);
    requester_allowed := kordos_planning.project_access(p.project_id) IN ('lead','contributor')
      AND kordos_github.destination_allowed(s)
      AND kordos_reviews.authority(p.requester_id,p.project_id,'[]') IS NOT DISTINCT FROM e.authority->'requester';
    PERFORM set_config('kordos.actor_id',e.reviewer_id::text,true);
    IF requester_allowed IS DISTINCT FROM true THEN
      PERFORM kordos_reviews.finish(e,p,'stale','access_changed'); RETURN NULL;
    END IF;
  END IF;

  IF p_step='claim' THEN
    IF e.github_attempts>=5 THEN
      IF e.github_started_at IS NOT NULL THEN
        PERFORM kordos_reviews.finish(e,p,'reconciliation_required','ambiguous_effect');
      ELSE
        PERFORM kordos_reviews.finish(e,p,'failed','worker_failed');
      END IF;
      RETURN NULL;
    END IF;
    IF e.status='approved' THEN
      UPDATE public.proposals SET status='applying',version=version+1 WHERE id=p.id;
      PERFORM kordos_reviews.event(p,'proposal.applying',jsonb_build_object('mutationId',gen_random_uuid()),e.id,NULL,true);
    END IF;
    UPDATE public.executions SET status='applying',github_lease=gen_random_uuid(),
      github_next_at=attempt_at+interval '75 seconds',github_attempts=github_attempts+1
      WHERE id=p_id RETURNING * INTO e;
    RETURN jsonb_build_object('lease',e.github_lease,'started',e.github_started_at IS NOT NULL,
      'workspaceId',e.workspace_id,'installationId',i.github_installation,'command',r.command);
  ELSIF p_step='start' AND e.github_started_at IS NULL THEN
    IF p_value->>'audience' IS NULL OR p_value->>'audience' NOT IN ('project','private') OR
      (p_value->>'audience'='private' AND (i.owner_id<>e.reviewer_id OR i.owner_id<>p.requester_id)) THEN
      PERFORM kordos_reviews.finish(e,p,'stale','destination_unavailable'); RETURN NULL;
    END IF;
    -- Commit the one-shot sending intent before contacting GitHub. A recovered
    -- lease can only reconcile an intent whose POST may have been attempted.
    UPDATE public.executions SET github_started_at=attempt_at WHERE id=p_id;
    RETURN 'true';
  ELSIF p_step='complete' AND e.github_started_at IS NOT NULL THEN
    IF p_value->>'id' !~ '^[1-9][0-9]*$' OR p_value->>'url' IS DISTINCT FROM (
      'https://github.com/' || (dest->>'repository') || '/' ||
      CASE WHEN dest->>'kind'='pull' THEN 'pull' ELSE 'issues' END || '/' ||
      (dest->>'number') || '#issuecomment-' || (p_value->>'id')) OR p_value->>'id' IS NULL THEN RETURN NULL; END IF;
    PERFORM kordos_planning.emit(p.project_id,s.id,'github.comment_published',
      jsonb_build_object('mutationId',e.write_mutation_id),NULL,
      jsonb_build_object('proposalId',p.id,'revision',e.revision,'receiptId',e.id,'executor',true));
    SELECT id INTO STRICT effect FROM public.outbox WHERE workspace_id=e.workspace_id
      AND actor_id=e.reviewer_id AND mutation_id=e.write_mutation_id;
    UPDATE public.executions SET github_remote=p_value WHERE id=p_id;
    PERFORM kordos_reviews.finish(e,p,'applied',NULL,effect);
    RETURN 'true';
  ELSIF p_step='refuse' THEN
    IF e.github_started_at IS NULL THEN
      PERFORM kordos_reviews.finish(e,p,'stale','destination_unavailable');
    ELSE
      PERFORM kordos_reviews.finish(e,p,'failed','provider_refused');
    END IF;
    RETURN 'true';
  ELSIF p_step='retry' THEN
    UPDATE public.executions SET github_lease=NULL,github_next_at=clock_timestamp()
      + interval '3 seconds'*power(2,least(e.github_attempts-1,4)) WHERE id=p_id;
    RETURN 'true';
  END IF;
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_github FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_github.receive(uuid,text,text,text,text,jsonb),kordos_github.invalidate(uuid,text,jsonb),
  kordos_github.activity(uuid,uuid,uuid),kordos_github.link_work(uuid,uuid,uuid,uuid,boolean) TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_github.pending(),kordos_github.execute(uuid,text,uuid,jsonb) TO kordos_brief_worker;

CREATE FUNCTION kordos_github.audit_allowed(a public.audit_events) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE
    WHEN a.action='github.work_link_changed' THEN EXISTS (
      SELECT FROM public.source_objects s WHERE s.id=a.target_id AND kordos_connectors.mirror_allowed(s))
    WHEN a.action='github.comment_published' OR a.action LIKE 'proposal.%' THEN NOT EXISTS (
      SELECT FROM public.proposals p WHERE p.workspace_id=a.workspace_id AND p.github_source_id IS NOT NULL
        AND CASE WHEN a.action='github.comment_published' THEN p.id=(a.details->'after'->>'proposalId')::uuid
          ELSE p.id=a.target_id END
        AND NOT kordos_reviews.can_read(p))
    ELSE true END
$$;
REVOKE EXECUTE ON FUNCTION kordos_github.audit_allowed(public.audit_events) FROM PUBLIC;

CREATE OR REPLACE FUNCTION kordos_reviews.audit(p_filter jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH cursor_row AS (
    SELECT a.created_at, a.id FROM public.audit_events a
    WHERE a.workspace_id = kordos_identity.workspace_id() AND a.id = (p_filter->>'cursor')::uuid
      AND CASE WHEN a.project_id IS NULL THEN kordos_identity.current_role() = 'admin'
        ELSE kordos_planning.project_access(a.project_id) IS NOT NULL END
      AND kordos_github.audit_allowed(a)
  ), entries AS (
    SELECT a.*, project.name AS project_name
    FROM public.audit_events a
    LEFT JOIN public.projects project ON (project.workspace_id, project.id) = (a.workspace_id, a.project_id)
    WHERE a.workspace_id = kordos_identity.workspace_id()
      AND CASE WHEN a.project_id IS NULL THEN kordos_identity.current_role() = 'admin'
        ELSE kordos_planning.project_access(a.project_id) IS NOT NULL END
      AND kordos_github.audit_allowed(a)
      AND (p_filter->>'eventId' IS NULL OR a.id = (p_filter->>'eventId')::uuid)
      AND (p_filter->>'githubCommentUrl' IS NULL OR (a.action='github.comment_published' AND EXISTS (
        SELECT FROM public.executions e WHERE e.effect_event_id=a.id AND e.workspace_id=a.workspace_id
          AND e.github_remote->>'url'=lower(p_filter->>'githubCommentUrl'))))
      AND (p_filter->>'projectId' IS NULL OR a.project_id = (p_filter->>'projectId')::uuid)
      AND (p_filter->>'actorId' IS NULL OR a.actor_id = (p_filter->>'actorId')::uuid)
      AND (p_filter->>'targetId' IS NULL OR a.target_id = (p_filter->>'targetId')::uuid
        OR (a.action LIKE 'proposal.%' AND a.details->'after'->>'workId' = p_filter->>'targetId'))
      AND (p_filter->>'from' IS NULL OR a.created_at >= ((p_filter->>'from')::date::timestamp AT TIME ZONE 'UTC'))
      AND (p_filter->>'to' IS NULL OR a.created_at < (((p_filter->>'to')::date + 1)::timestamp AT TIME ZONE 'UTC'))
      AND (p_filter->>'cursor' IS NULL OR (a.created_at, a.id) < (SELECT created_at, id FROM cursor_row))
    ORDER BY a.created_at DESC, a.id DESC LIMIT 41
  ), page AS (
    SELECT * FROM entries ORDER BY created_at DESC, id DESC LIMIT 40
  )
  SELECT jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', a.id, 'targetId', a.target_id, 'action', a.action, 'occurredAt', a.created_at,
      'projectId', a.project_id, 'projectName', a.project_name,
      'actor', kordos_collaboration.person(a.actor_id),
      'actorType', CASE WHEN e.id IS NOT NULL OR (CASE WHEN a.action LIKE 'brief.%' OR a.action LIKE 'risk.%' OR a.action LIKE 'meeting.%' THEN a.details->'after' ELSE meta END)->>'executor' = 'true' THEN 'service' ELSE 'user' END,
      'workId', CASE WHEN a.action LIKE 'work.%' THEN a.target_id ELSE (meta->>'workId')::uuid END,
      'proposalId', CASE WHEN kordos_reviews.can_read(p) THEN p.id END,
      'revision', CASE WHEN kordos_reviews.can_read(p) THEN coalesce(e.revision, (meta->>'revision')::int) END,
      'receiptId', coalesce(e.id, (meta->>'receiptId')::uuid),
      'before', CASE WHEN a.action LIKE 'work.%' THEN a.details->'before' END,
      'after', CASE WHEN a.action LIKE 'work.%' THEN a.details->'after' END
    ) ORDER BY a.created_at DESC, a.id DESC)
    FROM page a
    LEFT JOIN public.executions e ON e.effect_event_id = a.id AND e.workspace_id = a.workspace_id
    CROSS JOIN LATERAL (SELECT CASE WHEN a.action LIKE 'proposal.%' THEN a.details->'after' END AS meta) m
    LEFT JOIN public.proposals p ON p.workspace_id = a.workspace_id
      AND p.id = coalesce(e.proposal_id, CASE WHEN meta IS NOT NULL THEN a.target_id END)
  ), '[]'), 'nextCursor', CASE WHEN (SELECT count(*) FROM entries) > 40 THEN
    (SELECT id FROM page ORDER BY created_at, id LIMIT 1) END)
  WHERE kordos_identity.current_role() IS NOT NULL
$$;
