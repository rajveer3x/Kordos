ALTER TABLE "connector_installations" DROP CONSTRAINT "connector_installations_provider";--> statement-breakpoint
ALTER TABLE "connector_installations" ADD COLUMN "google_subject" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "calendar_source_id" uuid;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "calendar_revision" integer;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "calendar_canceled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD COLUMN "calendar_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_calendar_source_fk" FOREIGN KEY ("workspace_id","project_id","calendar_source_id") REFERENCES "public"."source_objects"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_calendar_source_unique" UNIQUE("calendar_source_id");--> statement-breakpoint
ALTER TABLE "connector_installations" ADD CONSTRAINT "connector_installations_provider" CHECK (("connector_installations"."provider" = 'fixture' AND "connector_installations"."github_installation" IS NULL AND "connector_installations"."google_subject" IS NULL)
        OR ("connector_installations"."provider" = 'github' AND "connector_installations"."github_installation" ~ '^[1-9][0-9]{0,15}$' AND "connector_installations"."github_installation" IS NOT NULL AND "connector_installations"."google_subject" IS NULL)
        OR ("connector_installations"."provider" IN ('calendar','gmail') AND "connector_installations"."github_installation" IS NULL AND "connector_installations"."google_subject" ~ '^[A-Za-z0-9_-]{1,255}$' AND "connector_installations"."google_subject" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_calendar_source_state" CHECK (("meetings"."calendar_source_id" IS NULL AND "meetings"."calendar_revision" IS NULL AND NOT "meetings"."calendar_canceled")
      OR ("meetings"."calendar_source_id" IS NOT NULL AND "meetings"."calendar_revision" IS NOT NULL AND "meetings"."calendar_revision" > 0));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION kordos_connectors.manage(p_id uuid, p_input jsonb, p_credential text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  action text := p_input->>'action';
  mutation uuid := (p_input->>'mutationId')::uuid;
  project uuid := (p_input->>'projectId')::uuid;
  input_provider text := p_input->>'provider';
  subject text := p_input->>'googleSubject';
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
    IF input_provider IN ('calendar','gmail') THEN
      IF NOT coalesce(subject ~ '^[A-Za-z0-9_-]{1,255}$' AND length(p_input->>'scope') BETWEEN 1 AND 512
        AND p_input->>'scope' !~ '[[:space:][:cntrl:]]' AND p_input->>'audience'='private',false) THEN
        RETURN jsonb_build_object('result','invalid');
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('kordos.google:' || jsonb_build_array(
        tenant,actor,input_provider,subject,project,p_input->>'scope')::text,0));
      IF EXISTS (SELECT FROM public.connector_installations i JOIN public.connector_mappings m
        ON (m.workspace_id,m.installation_id)=(i.workspace_id,i.id)
        WHERE (i.workspace_id,i.owner_id,i.provider,i.google_subject,m.project_id,m.scope)
          = (tenant,actor,input_provider,subject,project,p_input->>'scope')
          AND i.state<>'disconnected' AND m.revoked_at IS NULL)
        THEN RETURN jsonb_build_object('result','scope_exists'); END IF;
    END IF;
    IF p_id <> mutation OR NOT coalesce(
      (p_input->>'provider' = 'fixture' AND p_credential IS NOT NULL AND p_input->>'installationId' IS NULL)
      OR (input_provider = 'github' AND p_credential IS NULL AND p_input->>'installationId' ~ '^[1-9][0-9]{0,15}$')
      OR (input_provider IN ('calendar','gmail') AND p_credential IS NOT NULL AND p_input->>'installationId' IS NULL),false)
      THEN RETURN jsonb_build_object('result','invalid'); END IF;
    INSERT INTO public.connector_installations (id, workspace_id, owner_id, label, provider, credential, github_installation, google_subject)
    VALUES (p_id,tenant,actor,p_input->>'label',p_input->>'provider',p_credential,p_input->>'installationId',subject)
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
    IF installation.owner_id <> actor OR (action = 'map' AND installation.provider IN ('calendar','gmail'))
      THEN RETURN NULL; END IF;
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
      IF installation.provider IN ('calendar','gmail') AND installation.google_subject IS DISTINCT FROM subject
        THEN RETURN jsonb_build_object('result','google_account_changed'); END IF;
      UPDATE public.connector_mappings SET verified_until = NULL,
        checkpoint = CASE WHEN installation.provider IN ('calendar','gmail') THEN NULL ELSE checkpoint END
      WHERE installation_id = p_id;
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

CREATE OR REPLACE FUNCTION kordos_connectors.health(i public.connector_installations) RETURNS jsonb
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
      'scope', CASE WHEN visible.allowed AND (i.provider NOT IN ('calendar','gmail') OR i.owner_id=kordos_identity.actor_id())
        THEN m.scope END,
      'audience', CASE WHEN m.provider_audience = 'private' THEN 'private' ELSE m.audience END,
      'lastSuccess', m.last_success) ORDER BY m.id)
      FROM public.connector_mappings m
      JOIN public.projects p ON (p.workspace_id,p.id) = (m.workspace_id,m.project_id)
      CROSS JOIN LATERAL (SELECT kordos_planning.project_access(p.id) IS NOT NULL AS allowed) visible
      WHERE m.installation_id = i.id AND m.revoked_at IS NULL), '[]'))
$$;

CREATE OR REPLACE FUNCTION kordos_connectors.mirror_allowed(s public.source_objects) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(s.withdrawn_at IS NULL AND EXISTS (
    SELECT FROM public.connector_mappings m
    JOIN public.connector_installations i ON (i.workspace_id,i.id) = (m.workspace_id,m.installation_id)
    WHERE (m.workspace_id,m.installation_id,m.id,m.project_id) = (s.workspace_id,s.installation_id,s.mapping_id,s.project_id)
      AND m.revoked_at IS NULL AND m.verified_until > statement_timestamp()
      AND i.state <> 'disconnected' AND i.issue IS DISTINCT FROM 'credential_revoked'
      AND kordos_connectors.owner_authorized(i,m)
      AND ((i.provider NOT IN ('calendar','gmail') AND m.audience = 'project' AND m.provider_audience = 'project') OR i.owner_id = kordos_identity.actor_id())
  ),false)
  AND s.workspace_id = kordos_identity.workspace_id() AND kordos_planning.project_access(s.project_id) IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION kordos_connectors.share(p_project uuid, p_source uuid, p_input jsonb) RETURNS jsonb
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
  VALUES (mutation,tenant,p_project,p_source,revision,actor,CASE WHEN source_record->>'gmail'='true' THEN 'Shared email' ELSE source_record->>'title' END,excerpt,
    CASE WHEN source_record->>'gmail' IS DISTINCT FROM 'true' THEN source_record->>'url' END)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','mutation_conflict'); END IF;
  PERFORM kordos_connectors.audit(p_project,mutation,'share_created',mutation,NULL);
  RETURN jsonb_build_object('result','saved','id',mutation);
END
$$;

-- Each Google batch reads the current canonical state under the connector lease.
-- The hash covers the normalized content, and a repeated read adds no revision.
CREATE FUNCTION kordos_connectors.apply_google_change(m public.connector_mappings, provider text, change jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  source public.source_objects;
  current_revision public.source_revisions;
  provider_id text := change->>'externalId';
  revision_key text := change->>'revisionKey';
  gone boolean := change->>'kind'='delete';
  starts_at timestamptz := (change->>'calendarStart')::timestamptz;
BEGIN
  IF NOT coalesce(length(provider_id) BETWEEN 1 AND 512 AND (
    (gone AND revision_key='removed' AND starts_at IS NULL)
    OR (change->>'kind'='upsert' AND revision_key ~ '^[0-9a-f]{64}$'
      AND length(change->>'title') BETWEEN 1 AND (CASE WHEN provider='calendar' THEN 160 ELSE 240 END)
      AND length(change->>'body')<=16000 AND (provider='calendar')=(starts_at IS NOT NULL))
  ),false) THEN RAISE EXCEPTION 'Invalid Google source' USING ERRCODE='22023'; END IF;
  IF NOT gone THEN
    INSERT INTO public.source_objects (workspace_id,installation_id,mapping_id,project_id,external_id)
    VALUES (m.workspace_id,m.installation_id,m.id,m.project_id,provider_id)
    ON CONFLICT (mapping_id,external_id) DO NOTHING;
  END IF;
  SELECT * INTO source FROM public.source_objects s WHERE (s.mapping_id,s.external_id)=(m.id,provider_id);
  IF NOT FOUND OR (gone AND source.withdrawn_at IS NOT NULL) THEN RETURN; END IF;
  SELECT * INTO current_revision FROM public.source_revisions r
    WHERE r.source_id=source.id AND r.revision=source.revision;
  IF NOT gone AND split_part(current_revision.revision_key,':',1)=revision_key THEN
    UPDATE public.source_objects SET withdrawn_at=NULL WHERE id=source.id AND withdrawn_at IS NOT NULL;
    RETURN;
  END IF;
  INSERT INTO public.source_revisions (workspace_id,project_id,source_id,revision,revision_key,observed_at,title,body,calendar_start)
  VALUES (m.workspace_id,m.project_id,source.id,source.revision+1,revision_key||':'||(source.revision+1)::text,
    (change->>'observedAt')::timestamptz,change->>'title',change->>'body',starts_at);
  UPDATE public.source_objects SET revision=revision+1,withdrawn_at=CASE WHEN gone THEN clock_timestamp() END
    WHERE id=source.id;
END
$$;

CREATE FUNCTION kordos_connectors.refresh_calendar_meetings(mapping public.connector_mappings, owner_id uuid)
RETURNS void LANGUAGE sql SET search_path=pg_catalog AS $$
  WITH changed AS (
    UPDATE public.meetings m
    SET calendar_revision=s.revision,calendar_canceled=s.withdrawn_at IS NOT NULL,version=m.version+1,
      title=CASE WHEN s.withdrawn_at IS NULL AND m.calendar_revision<>s.revision THEN r.title ELSE m.title END,
      starts_at=CASE WHEN s.withdrawn_at IS NULL AND m.calendar_revision<>s.revision THEN r.calendar_start ELSE m.starts_at END
    FROM public.source_objects s JOIN public.source_revisions r ON r.source_id=s.id AND r.revision=s.revision
    WHERE (m.workspace_id,m.project_id,m.calendar_source_id)=(s.workspace_id,s.project_id,s.id)
      AND (s.workspace_id,s.project_id,s.mapping_id)=(mapping.workspace_id,mapping.project_id,mapping.id)
      AND (m.calendar_revision,m.calendar_canceled) IS DISTINCT FROM (s.revision,s.withdrawn_at IS NOT NULL)
    RETURNING m.workspace_id,m.project_id,m.id,m.calendar_canceled
  )
  INSERT INTO public.audit_events (workspace_id,project_id,actor_id,target_id,action,details)
  SELECT workspace_id,project_id,owner_id,id,
    CASE WHEN calendar_canceled THEN 'meeting.calendar_canceled' ELSE 'meeting.calendar_updated' END,
    jsonb_build_object('after',jsonb_build_object('executor',true))
  FROM changed
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
  calendar_project uuid;
  calendar_workspace uuid;
BEGIN
  -- Calendar writes share the project lock used by meeting commands.
  SELECT m.workspace_id,m.project_id INTO calendar_workspace,calendar_project
  FROM public.connector_jobs j JOIN public.connector_installations i
    ON (j.workspace_id,j.installation_id)=(i.workspace_id,i.id)
  JOIN public.connector_mappings m ON (j.workspace_id,j.installation_id,j.mapping_id)=(m.workspace_id,m.installation_id,m.id)
  WHERE j.id=p_job AND j.kind='sync' AND i.provider='calendar';
  IF FOUND THEN
    PERFORM FROM public.workspaces WHERE id=calendar_workspace FOR SHARE;
    PERFORM FROM public.projects WHERE (workspace_id,id)=(calendar_workspace,calendar_project) FOR UPDATE;
  END IF;

  SELECT * INTO installation FROM public.connector_installations
  WHERE id = (SELECT installation_id FROM public.connector_jobs WHERE id = p_job) FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO job FROM public.connector_jobs WHERE id = p_job AND state = 'running'
    AND lease = p_lease AND lease_until > now_at FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF job.kind = 'cleanup' THEN
    -- Keep IDs and the revision key while removing mirrored text and raw payloads.
    UPDATE public.source_revisions r SET title = NULL, body = NULL, url = NULL, github = NULL, calendar_start = NULL
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
      IF installation.provider IN ('calendar','gmail') THEN
        PERFORM kordos_connectors.apply_google_change(mapping,installation.provider,change);
      ELSE
        PERFORM kordos_connectors.apply_change(mapping,change,rebuild);
      END IF;
    END LOOP;
    IF rebuild THEN
      UPDATE public.source_objects s SET withdrawn_at = now_at
      WHERE s.mapping_id = mapping.id AND s.withdrawn_at IS NULL AND NOT EXISTS (
        SELECT FROM jsonb_array_elements(p_batch->'changes') entry
        WHERE entry->>'externalId' = s.external_id AND entry->>'kind' = 'upsert');
    END IF;
    IF installation.provider='calendar' THEN
      PERFORM kordos_connectors.refresh_calendar_meetings(mapping,installation.owner_id);
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

ALTER FUNCTION kordos_connectors.source(uuid,uuid,int) RENAME TO source_before_google;
REVOKE EXECUTE ON FUNCTION kordos_connectors.source_before_google(uuid,uuid,int) FROM kordos_app;

CREATE FUNCTION kordos_connectors.source(p_project uuid,p_id uuid,p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT original || CASE
    WHEN i.provider='calendar' THEN jsonb_build_object('canShare',false,'calendar',jsonb_build_object(
      'startsAt',r.calendar_start,'meetingId',m.id,
      'canAttach',m.id IS NULL AND r.revision=s.revision AND p.archived_at IS NULL
        AND kordos_planning.project_access(p_project) IN ('lead','contributor')))
    WHEN i.provider='gmail' THEN jsonb_build_object('gmail',true,'canShare',
      p.archived_at IS NULL AND (original->>'canShare')::boolean)
    ELSE '{}' END
  FROM kordos_connectors.source_before_google(p_project,p_id,p_revision) original
  LEFT JOIN public.source_objects s ON (s.workspace_id,s.project_id,s.id)=(kordos_identity.workspace_id(),p_project,p_id)
    AND original->>'kind'='mirror'
  LEFT JOIN public.source_revisions r ON r.source_id=s.id AND r.revision=coalesce(p_revision,s.revision)
  LEFT JOIN public.connector_installations i ON (i.workspace_id,i.id)=(s.workspace_id,s.installation_id)
  LEFT JOIN public.projects p ON (p.workspace_id,p.id)=(s.workspace_id,s.project_id)
  LEFT JOIN public.meetings m ON (m.workspace_id,m.project_id,m.calendar_source_id)=(s.workspace_id,s.project_id,s.id)
  WHERE original IS NOT NULL
$$;

CREATE FUNCTION kordos_connectors.attach_calendar(p_project uuid,p_source uuid,p_revision int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  source_record jsonb;
  existing uuid;
  project public.projects;
BEGIN
  IF kordos_planning.project_access(p_project) IS NULL THEN RETURN NULL; END IF;
  PERFORM kordos_planning.lock_workspace(p_source);
  SELECT * INTO project FROM public.projects WHERE (workspace_id,id)=(tenant,p_project)
    AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND OR NOT coalesce(kordos_planning.project_access(p_project) IN ('lead','contributor'),false)
    THEN RETURN NULL; END IF;
  PERFORM FROM public.connector_installations i JOIN public.source_objects s
    ON (s.workspace_id,s.installation_id)=(i.workspace_id,i.id)
    WHERE (s.workspace_id,s.project_id,s.id)=(tenant,p_project,p_source)
      AND i.provider='calendar' AND i.owner_id=actor FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN NULL; END IF;

  source_record := kordos_connectors.source(p_project,p_source,p_revision);
  IF source_record->'calendar' IS NULL THEN RETURN NULL; END IF;
  existing := (source_record->'calendar'->>'meetingId')::uuid;
  IF existing IS NOT NULL THEN RETURN jsonb_build_object('result','saved','id',existing); END IF;
  IF NOT coalesce((source_record->'calendar'->>'canAttach')::boolean,false) THEN
    RETURN jsonb_build_object('result','source_changed');
  END IF;

  INSERT INTO public.meetings (workspace_id,project_id,organizer_id,job_actor_id,title,starts_at,time_zone,retention_days,
    calendar_source_id,calendar_revision)
  VALUES (tenant,p_project,actor,actor,source_record->>'title',(source_record->'calendar'->>'startsAt')::timestamptz,
    project.time_zone,30,p_source,p_revision)
  RETURNING id INTO existing;
  INSERT INTO public.audit_events (workspace_id,project_id,actor_id,target_id,action,details)
  VALUES (tenant,p_project,actor,existing,'meeting.calendar_attached','{}');
  RETURN jsonb_build_object('result','saved','id',existing);
END
$$;

CREATE OR REPLACE FUNCTION kordos_meetings.summary(m public.meetings) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',m.id,'title',m.title,'startsAt',m.starts_at,'status',m.status,
    'organizer',kordos_collaboration.person(m.organizer_id),'calendarStatus',
    CASE WHEN m.calendar_canceled THEN 'canceled' WHEN m.calendar_source_id IS NOT NULL THEN 'scheduled' END)
$$;

REVOKE EXECUTE ON FUNCTION kordos_connectors.source(uuid,uuid,int),
  kordos_connectors.attach_calendar(uuid,uuid,int),
  kordos_connectors.apply_google_change(public.connector_mappings,text,jsonb),
  kordos_connectors.refresh_calendar_meetings(public.connector_mappings,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_connectors.source(uuid,uuid,int),
  kordos_connectors.attach_calendar(uuid,uuid,int) TO kordos_app;
