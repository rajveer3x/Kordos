CREATE TABLE "brief_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_revision" integer DEFAULT 1 NOT NULL,
	"requester_id" uuid NOT NULL,
	"time_zone" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"candidates" jsonb,
	"failure" text,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brief_jobs_source_unique" UNIQUE("workspace_id","project_id","document_id","source_revision"),
	CONSTRAINT "brief_jobs_scope_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "brief_jobs_attempt" CHECK ("brief_jobs"."attempt" BETWEEN 1 AND 3 AND "brief_jobs"."version" > 0),
	CONSTRAINT "brief_jobs_status" CHECK ("brief_jobs"."status" IN ('queued', 'running', 'ready', 'failed')
      AND ("brief_jobs"."status" = 'running') = ("brief_jobs"."lease_id" IS NOT NULL AND "brief_jobs"."lease_until" IS NOT NULL)
      AND ("brief_jobs"."status" = 'ready') = ("brief_jobs"."candidates" IS NOT NULL)
      AND ("brief_jobs"."status" = 'failed') = ("brief_jobs"."failure" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "plan_work_items" (
	"work_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"candidate_id" uuid NOT NULL,
	CONSTRAINT "plan_work_items_candidate_unique" UNIQUE("workspace_id","project_id","proposal_id","revision","candidate_id")
);
--> statement-breakpoint
ALTER TABLE "proposal_revisions" DROP CONSTRAINT "proposal_revisions_command";--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "work_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "brief_id" uuid;--> statement-breakpoint
ALTER TABLE "brief_jobs" ADD CONSTRAINT "brief_jobs_source_fk" FOREIGN KEY ("workspace_id","project_id","document_id","source_revision") REFERENCES "public"."document_versions"("workspace_id","project_id","document_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_jobs" ADD CONSTRAINT "brief_jobs_requester_fk" FOREIGN KEY ("workspace_id","requester_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_work_items" ADD CONSTRAINT "plan_work_items_work_fk" FOREIGN KEY ("workspace_id","project_id","work_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_work_items" ADD CONSTRAINT "plan_work_items_revision_fk" FOREIGN KEY ("workspace_id","project_id","proposal_id","revision") REFERENCES "public"."proposal_revisions"("workspace_id","project_id","proposal_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brief_jobs_project_date_idx" ON "brief_jobs" USING btree ("workspace_id","project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "brief_jobs_pending_idx" ON "brief_jobs" USING btree ("created_at","id") WHERE "brief_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_brief_fk" FOREIGN KEY ("workspace_id","project_id","brief_id") REFERENCES "public"."brief_jobs"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_brief_unique" UNIQUE("brief_id");--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_command" CHECK (coalesce("proposal_revisions"."command"->>'kind' IN ('work.edit', 'plan.create'), false));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_one_target" CHECK (num_nonnulls("proposals"."work_id", "proposals"."brief_id") = 1);
--> statement-breakpoint
CREATE SCHEMA kordos_briefs;
REVOKE ALL ON SCHEMA kordos_briefs FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_briefs TO kordos_app;
ALTER TABLE public.brief_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_work_items ENABLE ROW LEVEL SECURITY;

-- Fresh local databases provision a login at initialization. Existing databases
-- can grant this role to a dedicated worker login after migrating.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kordos_brief_worker') THEN
    CREATE ROLE kordos_brief_worker NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA kordos_briefs TO kordos_brief_worker;

CREATE FUNCTION kordos_briefs.create_job(p_project uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  request jsonb := jsonb_build_object('_command', 'brief.create', 'mutationId', mutation,
    'hash', encode(sha256(convert_to(p_input::text, 'UTF8')), 'hex'));
  problem text;
  repeated jsonb;
  brief_id uuid;
  source_id uuid := (p_input->>'documentId')::uuid;
  wanted_revision integer := coalesce((p_input->>'sourceRevision')::int, 1);
  source_content text;
BEGIN
  problem := kordos_knowledge.open_write(p_project, mutation);
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('result', problem); END IF;
  repeated := kordos_planning.replay(request, p_project, NULL);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;
  IF source_id IS NULL THEN
    IF NOT coalesce(char_length(btrim(p_input->>'title')) BETWEEN 1 AND 160
      AND char_length(p_input->>'content') BETWEEN 1 AND 16000
      AND btrim(p_input->>'content') <> '' AND wanted_revision = 1, false) THEN
      RETURN jsonb_build_object('result', 'invalid_input');
    END IF;
    INSERT INTO public.documents (workspace_id, project_id)
      VALUES (tenant, p_project) RETURNING id INTO source_id;
    INSERT INTO public.document_versions (workspace_id, project_id, document_id, revision, title, content, author_id)
      VALUES (tenant, p_project, source_id, wanted_revision, p_input->>'title', p_input->>'content', actor);
  ELSE
    SELECT content INTO source_content FROM public.document_versions
      WHERE (workspace_id, project_id, document_id, revision) = (tenant, p_project, source_id, wanted_revision);
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
    IF NOT coalesce(char_length(source_content) BETWEEN 1 AND 16000 AND btrim(source_content) <> '', false) THEN
      RETURN jsonb_build_object('result', 'invalid_input');
    END IF;
    SELECT id INTO brief_id FROM public.brief_jobs
      WHERE (workspace_id, project_id, document_id, brief_jobs.source_revision) = (tenant, p_project, source_id, wanted_revision);
    IF FOUND THEN
      PERFORM kordos_planning.emit(p_project, brief_id, 'brief.reused', request, NULL,
        jsonb_build_object('documentId', source_id, 'sourceRevision', wanted_revision));
      RETURN jsonb_build_object('result', 'saved', 'id', brief_id);
    END IF;
  END IF;

  INSERT INTO public.brief_jobs (document_id, source_revision, workspace_id, project_id, requester_id, time_zone)
    SELECT source_id, wanted_revision, tenant, p_project, actor, time_zone FROM public.projects
    WHERE id = p_project AND workspace_id = tenant RETURNING id INTO brief_id;
  PERFORM kordos_planning.emit(p_project, brief_id, 'brief.queued', request, NULL,
    jsonb_build_object('attempt', 1, 'documentId', source_id, 'sourceRevision', wanted_revision));
  RETURN jsonb_build_object('result', 'saved', 'id', brief_id);
END
$$;

CREATE FUNCTION kordos_briefs.editable(b public.brief_jobs) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(kordos_planning.project_access(b.project_id) = 'lead' OR
    (kordos_planning.project_access(b.project_id) = 'contributor' AND b.requester_id = kordos_identity.actor_id()), false)
$$;

CREATE FUNCTION kordos_briefs.summary(b public.brief_jobs, v public.document_versions, p public.proposals)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', b.id, 'title', v.title, 'status', b.status,
    'proposalId', CASE WHEN kordos_reviews.can_read(p) THEN p.id END)
$$;

CREATE FUNCTION kordos_briefs.directory(p_project uuid, p_cursor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH entries AS (
    SELECT b.id, b.created_at, kordos_briefs.summary(b, v, p) AS value
    FROM public.brief_jobs b
    JOIN public.document_versions v ON (v.workspace_id, v.project_id, v.document_id, v.revision)
      = (b.workspace_id, b.project_id, b.document_id, b.source_revision)
    LEFT JOIN public.proposals p ON p.brief_id = b.id
    WHERE (b.workspace_id, b.project_id) = (kordos_identity.workspace_id(), p_project)
      AND (p_cursor IS NULL OR (b.created_at, b.id) < (SELECT created_at, id FROM public.brief_jobs
        WHERE (workspace_id, project_id, id) = (b.workspace_id, b.project_id, p_cursor)))
    ORDER BY b.created_at DESC, b.id DESC LIMIT 31
  ), page AS (
    SELECT * FROM entries ORDER BY created_at DESC, id DESC LIMIT 30
  )
  SELECT jsonb_build_object('items', coalesce((SELECT jsonb_agg(value ORDER BY created_at DESC, id DESC) FROM page), '[]'),
    'nextCursor', CASE WHEN (SELECT count(*) FROM entries) > 30 THEN (SELECT id FROM page ORDER BY created_at, id LIMIT 1) END)
  WHERE kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE FUNCTION kordos_briefs.detail(p_project uuid, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_briefs.summary(b, v, p) || jsonb_build_object('content', v.content, 'capturedAt', v.created_at,
    'author', kordos_collaboration.person(v.author_id), 'documentId', b.document_id, 'sourceRevision', b.source_revision, 'timeZone', b.time_zone, 'attempt', b.attempt, 'version', b.version, 'failure', b.failure,
    'candidates', CASE WHEN can_edit THEN b.candidates END, 'canEdit', can_edit)
  FROM public.brief_jobs b
  JOIN public.projects project ON (project.workspace_id, project.id) = (b.workspace_id, b.project_id)
  JOIN public.document_versions v ON (v.workspace_id, v.project_id, v.document_id, v.revision)
    = (b.workspace_id, b.project_id, b.document_id, b.source_revision)
  LEFT JOIN public.proposals p ON p.brief_id = b.id
  CROSS JOIN LATERAL (SELECT project.archived_at IS NULL AND kordos_briefs.editable(b) AS can_edit) permissions
  WHERE (b.workspace_id, b.project_id, b.id) = (kordos_identity.workspace_id(), p_project, p_id)
    AND kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE FUNCTION kordos_briefs.retry(p_project uuid, p_id uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  mutation uuid := (p_input->>'mutationId')::uuid;
  request jsonb := p_input || jsonb_build_object('_command', 'brief.retry');
  problem text;
  repeated jsonb;
  b public.brief_jobs;
BEGIN
  problem := kordos_knowledge.open_write(p_project, mutation);
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('result', problem); END IF;
  SELECT * INTO b FROM public.brief_jobs WHERE (workspace_id, project_id, id)
    = (kordos_identity.workspace_id(), p_project, p_id) FOR UPDATE;
  IF NOT FOUND OR NOT kordos_briefs.editable(b) THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  repeated := kordos_planning.replay(request, p_project, p_id);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;
  IF b.version IS DISTINCT FROM (p_input->>'expectedVersion')::int THEN RETURN jsonb_build_object('result', 'conflict'); END IF;
  IF b.status <> 'failed' OR b.attempt >= 3 OR EXISTS (SELECT 1 FROM public.proposals WHERE brief_id = b.id) THEN
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;

  UPDATE public.brief_jobs SET status = 'queued', failure = NULL, attempt = attempt + 1, version = version + 1 WHERE id = b.id;
  PERFORM kordos_planning.emit(p_project, p_id, 'brief.queued', request, NULL, jsonb_build_object('attempt', b.attempt + 1));
  RETURN jsonb_build_object('result', 'saved', 'id', b.id);
END
$$;

CREATE FUNCTION kordos_briefs.pending() RETURNS TABLE(id uuid, attempt int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT b.id, b.attempt FROM public.brief_jobs b
  WHERE b.status = 'queued' OR (b.status = 'running' AND b.lease_until <= statement_timestamp())
  ORDER BY b.created_at, b.id LIMIT 50
$$;

CREATE FUNCTION kordos_briefs.claim(p_id uuid, p_attempt int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE b public.brief_jobs;
BEGIN
  SELECT * INTO b FROM public.brief_jobs WHERE id = p_id AND attempt = p_attempt;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM set_config('kordos.workspace_id', b.workspace_id::text, true);
  PERFORM set_config('kordos.actor_id', b.requester_id::text, true);
  PERFORM kordos_planning.lock_workspace(gen_random_uuid());
  PERFORM kordos_reviews.lock_projects(b.project_id, '[]');
  SELECT * INTO b FROM public.brief_jobs WHERE id = p_id AND attempt = p_attempt
    AND (status = 'queued' OR (status = 'running' AND lease_until <= clock_timestamp())) FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF b.status = 'running' OR NOT coalesce(kordos_planning.project_access(b.project_id) IN ('contributor', 'lead'), false)
    OR EXISTS (SELECT 1 FROM public.projects WHERE id = b.project_id AND archived_at IS NOT NULL) THEN
    UPDATE public.brief_jobs SET status = 'failed', version = version + 1,
      failure = CASE WHEN b.status = 'running' THEN 'interrupted' ELSE 'access_changed' END,
      lease_id = NULL, lease_until = NULL WHERE id = b.id;
    PERFORM kordos_planning.emit(b.project_id, b.id, 'brief.failed', jsonb_build_object('mutationId', gen_random_uuid()),
      NULL, jsonb_build_object('attempt', b.attempt, 'executor', true));
    RETURN NULL;
  END IF;
  UPDATE public.brief_jobs SET status = 'running', version = version + 1, lease_id = gen_random_uuid(),
    lease_until = clock_timestamp() + interval '60 seconds' WHERE id = b.id RETURNING * INTO b;
  PERFORM kordos_planning.emit(b.project_id, b.id, 'brief.running', jsonb_build_object('mutationId', gen_random_uuid()),
    NULL, jsonb_build_object('attempt', b.attempt, 'executor', true));
  RETURN (
    SELECT jsonb_build_object('leaseId', b.lease_id, 'title', v.title, 'content', v.content,
      'capturedAt', v.created_at, 'timeZone', b.time_zone, 'sourceRevision', b.source_revision,
      'owners', kordos_planning.people(b.project_id)->'owners')
    FROM public.document_versions v WHERE (v.workspace_id, v.project_id, v.document_id, v.revision)
      = (b.workspace_id, b.project_id, b.document_id, b.source_revision)
  );
END
$$;

CREATE FUNCTION kordos_briefs.finish(p_id uuid, p_lease uuid, p_plan jsonb, p_failure text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE b public.brief_jobs;
BEGIN
  SELECT * INTO b FROM public.brief_jobs WHERE id = p_id AND lease_id = p_lease AND status = 'running';
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM set_config('kordos.workspace_id', b.workspace_id::text, true);
  PERFORM set_config('kordos.actor_id', b.requester_id::text, true);
  PERFORM kordos_planning.lock_workspace(gen_random_uuid());
  PERFORM kordos_reviews.lock_projects(b.project_id, '[]');
  SELECT * INTO b FROM public.brief_jobs WHERE id = p_id AND lease_id = p_lease AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT coalesce(kordos_planning.project_access(b.project_id) IN ('contributor', 'lead'), false)
    OR EXISTS (SELECT 1 FROM public.projects WHERE id = b.project_id AND archived_at IS NOT NULL) THEN
    p_plan := NULL;
    p_failure := 'access_changed';
  END IF;
  UPDATE public.brief_jobs SET status = CASE WHEN p_plan IS NULL THEN 'failed' ELSE 'ready' END, version = version + 1,
    candidates = p_plan, failure = p_failure, lease_id = NULL, lease_until = NULL WHERE id = b.id;
  PERFORM kordos_planning.emit(b.project_id, b.id, CASE WHEN p_plan IS NULL THEN 'brief.failed' ELSE 'brief.ready' END,
    jsonb_build_object('mutationId', gen_random_uuid()), NULL,
    jsonb_build_object('attempt', b.attempt, 'failure', p_failure, 'executor', true));
END
$$;

-- All dependencies in a brief join new tasks. The batch can be validated
-- independently from the current graph, then applied under its project lock.
CREATE FUNCTION kordos_briefs.plan_issue(p_project uuid, plan jsonb) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF jsonb_typeof(plan->'tasks') IS DISTINCT FROM 'array' OR jsonb_typeof(plan->'edges') IS DISTINCT FROM 'array' THEN
    RETURN 'invalid_plan';
  END IF;
  IF jsonb_array_length(plan->'tasks') NOT BETWEEN 1 AND 24 OR jsonb_array_length(plan->'edges') > 60 THEN
    RETURN 'invalid_plan';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(plan->'tasks') t GROUP BY (t->>'id')::uuid HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(plan->'edges') e GROUP BY (e->>'predecessorId')::uuid,
      (e->>'successorId')::uuid HAVING count(*) > 1)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(plan->'tasks') t
      WHERE (t->>'id') IS NULL OR NOT coalesce(char_length(btrim(t->>'title')) BETWEEN 1 AND 180, false)
        OR coalesce(char_length(t->>'description'), 0) > 2000
        OR (t->>'estimateDays')::int NOT BETWEEN 1 AND 3650
        OR jsonb_typeof(t->'passages') IS DISTINCT FROM 'array'
        OR jsonb_array_length(t->'passages') > 3
    ) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(plan->'edges') e
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(plan->'tasks') t
          WHERE (t->>'id')::uuid = (e->>'predecessorId')::uuid)
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(plan->'tasks') t
          WHERE (t->>'id')::uuid = (e->>'successorId')::uuid)
    ) THEN RETURN 'invalid_plan'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(plan->'tasks') t
    WHERE t->>'ownerId' IS NOT NULL AND NOT kordos_planning.owner_eligible(p_project, (t->>'ownerId')::uuid)
  ) THEN RETURN 'invalid_owner'; END IF;
  IF EXISTS (
    WITH RECURSIVE edges AS (
      SELECT (entry->>'predecessorId')::uuid AS predecessor, (entry->>'successorId')::uuid AS successor
      FROM jsonb_array_elements(plan->'edges') entry
    ), reach(first, last) AS (
      SELECT predecessor, successor FROM edges
      UNION
      SELECT reach.first, edges.successor FROM reach JOIN edges ON edges.predecessor = reach.last
    )
    SELECT 1 FROM reach WHERE first = last
  ) THEN RETURN 'cycle'; END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION kordos_briefs.sources(b public.brief_jobs, plan jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  -- A manual plan also binds the original brief as evidence.
  SELECT jsonb_build_array(jsonb_build_object('kind', 'document', 'projectId', b.project_id, 'id', b.document_id,
    'anchor', jsonb_build_object('revision', b.source_revision, 'start', 0, 'end', least(char_length(v.content), 2000))))
    || coalesce((
      SELECT jsonb_agg(jsonb_build_object('kind', 'document', 'projectId', b.project_id, 'id', b.document_id, 'anchor', anchor)
        ORDER BY task_index, span_index)
      FROM jsonb_array_elements(plan->'tasks') WITH ORDINALITY t(task, task_index)
      CROSS JOIN LATERAL jsonb_array_elements(task->'passages') WITH ORDINALITY a(anchor, span_index)
    ), '[]'::jsonb)
  FROM public.document_versions v WHERE (v.workspace_id, v.project_id, v.document_id, v.revision)
    = (b.workspace_id, b.project_id, b.document_id, b.source_revision)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(plan->'tasks') t CROSS JOIN LATERAL jsonb_array_elements(t->'passages') anchor
      WHERE (anchor->>'revision')::int IS DISTINCT FROM b.source_revision
    )
$$;

CREATE FUNCTION kordos_briefs.apply_plan(p public.proposals, plan jsonb, p_mutation uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  entry jsonb;
  saved jsonb;
  ids jsonb := '{}';
  graph_version int;
  effect uuid;
BEGIN
  IF kordos_briefs.plan_issue(p.project_id, plan) IS NOT NULL THEN RETURN NULL; END IF;
  SELECT projects.graph_version INTO STRICT graph_version FROM public.projects
    WHERE (workspace_id, id) = (p.workspace_id, p.project_id);
  -- A subtransaction rolls back every work item and edge if any command fails.
  BEGIN
    FOR entry IN SELECT value FROM jsonb_array_elements(plan->'tasks') LOOP
      saved := kordos_planning.save_work(p.project_id, NULL, jsonb_build_object(
        'title', entry->'title', 'description', entry->'description', 'ownerId', entry->'ownerId',
        'estimateDays', entry->'estimateDays', 'deadline', entry->'deadline',
        'kind', 'task', 'status', 'backlog', 'mutationId', gen_random_uuid()));
      IF saved->>'result' IS DISTINCT FROM 'saved' THEN RAISE SQLSTATE 'KDP01'; END IF;
      ids := ids || jsonb_build_object(entry->>'id', saved->'id');
      INSERT INTO public.plan_work_items (workspace_id, project_id, proposal_id, revision, candidate_id, work_id)
        VALUES (p.workspace_id, p.project_id, p.id, p.revision, (entry->>'id')::uuid, (saved->>'id')::uuid);
    END LOOP;
    FOR entry IN SELECT value FROM jsonb_array_elements(plan->'edges') LOOP
      saved := kordos_planning.save_dependency(p.project_id, jsonb_build_object('action', 'add',
        'predecessorId', ids->(entry->>'predecessorId'), 'successorId', ids->(entry->>'successorId'),
        'expectedVersion', graph_version, 'mutationId', gen_random_uuid()));
      IF saved->>'result' IS DISTINCT FROM 'saved' THEN RAISE SQLSTATE 'KDP01'; END IF;
      graph_version := graph_version + 1;
    END LOOP;
    PERFORM kordos_planning.emit(p.project_id, p.id, 'proposal.plan_created',
      jsonb_build_object('mutationId', p_mutation), NULL,
      jsonb_build_object('revision', p.revision, 'executor', true, 'workIds', ids));
    SELECT id INTO STRICT effect FROM public.outbox WHERE workspace_id = p.workspace_id
      AND actor_id = kordos_identity.actor_id() AND mutation_id = p_mutation;
    RETURN effect;
  EXCEPTION WHEN SQLSTATE 'KDP01' THEN
    RETURN NULL;
  END;
END
$$;

CREATE FUNCTION kordos_briefs.work_origin(p_project uuid, p_work uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('origin', (
    SELECT jsonb_build_object('briefId', b.id, 'proposalId', p.id, 'revision', r.revision,
      'title', r.before->>'title', 'evidence', kordos_reviews.citations(coalesce((
        SELECT jsonb_agg(jsonb_build_object('source', jsonb_build_object(
          'kind', 'document', 'projectId', p_project, 'id', b.document_id, 'anchor', anchor
        ))) FROM jsonb_array_elements(task->'passages') anchor
      ), jsonb_build_array(r.evidence->0))))
    FROM public.plan_work_items pw
    JOIN public.proposals p ON (p.workspace_id, p.project_id, p.id) = (pw.workspace_id, pw.project_id, pw.proposal_id)
    JOIN public.brief_jobs b ON b.id = p.brief_id
    JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision)
      = (pw.workspace_id, pw.project_id, pw.proposal_id, pw.revision)
    CROSS JOIN LATERAL jsonb_array_elements(r.command->'plan'->'tasks') task
    WHERE (pw.workspace_id, pw.project_id, pw.work_id) = (kordos_identity.workspace_id(), p_project, p_work)
      AND (task->>'id')::uuid = pw.candidate_id AND kordos_reviews.can_read(p)
  ))
  WHERE kordos_planning.project_access(p_project) IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.work_items WHERE (workspace_id, project_id, id)
      = (kordos_identity.workspace_id(), p_project, p_work)
  )
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_briefs FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_briefs.create_job(uuid, jsonb), kordos_briefs.directory(uuid, uuid),
  kordos_briefs.detail(uuid, uuid), kordos_briefs.retry(uuid, uuid, jsonb),
  kordos_briefs.work_origin(uuid, uuid) TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_briefs.pending(), kordos_briefs.claim(uuid, int),
  kordos_briefs.finish(uuid, uuid, jsonb, text) TO kordos_brief_worker;

CREATE OR REPLACE FUNCTION kordos_reviews.summary(
  p public.proposals, project public.projects, w public.work_items, r public.proposal_revisions
) RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', p.id, 'projectId', p.project_id, 'projectName', project.name,
    'workId', w.id, 'briefId', p.brief_id,
    'title', coalesce(w.title, r.before->>'title'), 'kind', coalesce(w.kind::text, 'plan'), 'revision', r.revision,
    'status', kordos_reviews.effective_status(p, r), 'requester', kordos_collaboration.person(p.requester_id),
    'requestedAt', CASE WHEN p.status = 'draft' THEN r.created_at ELSE coalesce(p.submitted_at, r.created_at) END)
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.directory(p_before uuid, p_pending boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH cursor_row AS (
    SELECT p.id, p.created_at FROM public.proposals p
    WHERE p.id = p_before AND kordos_reviews.can_read(p)
  ), entries AS (
    SELECT p.id, p.created_at, kordos_reviews.summary(p, project, w, r) AS value
    FROM public.proposals p
    JOIN public.projects project ON (project.workspace_id, project.id) = (p.workspace_id, p.project_id)
    LEFT JOIN public.work_items w ON (w.workspace_id, w.project_id, w.id) = (p.workspace_id, p.project_id, p.work_id)
    JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision)
      = (p.workspace_id, p.project_id, p.id, p.revision)
    WHERE p.workspace_id = kordos_identity.workspace_id() AND kordos_reviews.can_read(p)
      AND (NOT p_pending OR (p.status = 'pending' AND r.expires_at > statement_timestamp()))
      AND (p_before IS NULL OR (p.created_at, p.id) < (SELECT created_at, id FROM cursor_row))
    ORDER BY p.created_at DESC, p.id DESC LIMIT 41
  ), page AS (
    SELECT * FROM entries ORDER BY created_at DESC, id DESC LIMIT 40
  )
  SELECT jsonb_build_object('items', coalesce((SELECT jsonb_agg(value ORDER BY created_at DESC, id DESC) FROM page), '[]'),
    'pendingCount', (SELECT count(*) FROM public.proposals p JOIN public.proposal_revisions r
      ON (r.workspace_id, r.project_id, r.proposal_id, r.revision) = (p.workspace_id, p.project_id, p.id, p.revision)
      WHERE p.workspace_id = kordos_identity.workspace_id() AND p.status = 'pending'
        AND r.expires_at > statement_timestamp() AND kordos_reviews.can_read(p)),
    'nextCursor', CASE WHEN (SELECT count(*) FROM entries) > 40 THEN
      (SELECT id FROM page ORDER BY created_at, id LIMIT 1) END)
  WHERE kordos_identity.current_role() IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.detail(p_id uuid, p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_reviews.summary(p, project, w, r) || jsonb_build_object(
    'version', p.version, 'revisionHead', p.revision, 'targetVersion', r.target_version, 'currentTargetVersion', coalesce(w.version, r.target_version),
    'expiresAt', r.expires_at, 'author', kordos_collaboration.person(r.author_id),
    'status', CASE WHEN current_revision THEN current_status ELSE coalesce(e.status, 'stale') END,
    'reviewer', kordos_collaboration.person(coalesce(e.reviewer_id, CASE WHEN current_revision THEN p.reviewer_id END)),
    'reviewedAt', coalesce(e.approved_at, CASE WHEN current_revision THEN p.reviewed_at END),
    'reason', CASE WHEN current_revision AND all_visible THEN p.reason END,
    'evidence', visibility.evidence, 'evidenceRestricted', NOT all_visible,
    'before', CASE WHEN all_visible AND p.work_id IS NOT NULL THEN r.before END,
    'plan', CASE WHEN all_visible THEN r.command->'plan' END,
    'createdWork', CASE WHEN p.brief_id IS NOT NULL AND all_visible THEN coalesce(effect.details->'after'->'workIds', '{}') END,
    'after', CASE WHEN all_visible THEN r.command->'values' END,
    'owners', CASE WHEN all_visible THEN (
      SELECT coalesce(jsonb_agg(kordos_collaboration.person(u.id) ORDER BY u.id), '[]')
      FROM (SELECT DISTINCT id::uuid FROM unnest(ARRAY[
        r.before->>'ownerId', r.before->>'blockerOwnerId',
        r.command->'values'->>'ownerId', r.command->'values'->>'blockerOwnerId']) id WHERE id IS NOT NULL
      UNION SELECT (task->>'ownerId')::uuid AS id FROM jsonb_array_elements(r.command->'plan'->'tasks') task
      WHERE task->>'ownerId' IS NOT NULL) u
    ) ELSE '[]'::jsonb END,
    'canEdit', editable AND current_status NOT IN ('applied', 'rejected', 'reconciliation_required'),
    'canSubmit', editable AND current_status = 'draft' AND p.reviewer_id IS NULL AND (p.brief_id IS NOT NULL OR w.version = r.target_version) AND all_visible,
    'canReview', writable AND access = 'lead' AND current_status = 'pending' AND current_revision
      AND all_visible,
    'receipt', CASE WHEN e.id IS NOT NULL THEN jsonb_build_object(
      'id', e.id, 'status', e.status, 'reviewer', kordos_collaboration.person(e.reviewer_id),
      'approvedAt', e.approved_at, 'finishedAt', e.finished_at, 'issue', e.issue,
      'effectEventId', e.effect_event_id, 'auditId', coalesce(e.outcome_audit_id, e.approval_audit_id)) END)
  FROM public.proposals p
  JOIN public.projects project ON (project.workspace_id, project.id) = (p.workspace_id, p.project_id)
  LEFT JOIN public.work_items w ON (w.workspace_id, w.project_id, w.id) = (p.workspace_id, p.project_id, p.work_id)
  JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision)
    = (p.workspace_id, p.project_id, p.id, coalesce(p_revision, p.revision))
  LEFT JOIN public.executions e ON (e.workspace_id, e.project_id, e.proposal_id, e.revision)
    = (r.workspace_id, r.project_id, r.proposal_id, r.revision)
  LEFT JOIN public.audit_events effect ON effect.id = e.effect_event_id
  CROSS JOIN LATERAL (SELECT kordos_planning.project_access(p.project_id) AS access,
    kordos_reviews.effective_status(p, r) AS current_status, p.revision = r.revision AS current_revision,
    project.archived_at IS NULL AND w.archived_at IS NULL AS writable,
    kordos_reviews.citations(r.evidence) AS evidence) visibility
  CROSS JOIN LATERAL (SELECT jsonb_array_length(visibility.evidence) = jsonb_array_length(r.evidence) AS all_visible,
    writable AND current_revision AND (access = 'lead' OR
      (access = 'contributor' AND p.requester_id = kordos_identity.actor_id())) AS editable) permissions
  WHERE p.id = p_id AND kordos_reviews.can_read(p)
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.mutate(p_project uuid, p_id uuid, p_action text, p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  wanted_revision int := (p_input->>'revision')::int;
  target_version int := (p_input->>'targetVersion')::int;
  p public.proposals;
  r public.proposal_revisions;
  e public.executions;
  w public.work_items;
  b public.brief_jobs;
  target_brief uuid;
  problem text;
  project uuid := p_project;
  access public.project_role;
  writable boolean;
  expires timestamptz;
  sources jsonb;
  links jsonb;
  request jsonb;
  existing public.outbox;
  receipt_id uuid;
  approval_event uuid;
BEGIN
  IF p_action NOT IN ('create', 'revise', 'submit', 'approve', 'request_edit', 'reject') THEN
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;
  IF p_action <> 'create' THEN
    SELECT * INTO p FROM public.proposals WHERE id = p_id AND workspace_id = tenant;
    project := p.project_id;
  END IF;
  access := kordos_planning.project_access(project);
  IF access IS NULL OR access = 'viewer' THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  IF p_action IN ('approve', 'reject', 'request_edit') AND access <> 'lead' THEN
    RETURN jsonb_build_object('result', 'forbidden');
  END IF;

  PERFORM kordos_planning.lock_workspace(mutation);
  IF p_action IN ('create', 'revise') THEN
    sources := coalesce(p_input->'evidence', '[]');
  ELSE
    SELECT coalesce(jsonb_agg(entry->'source'), '[]') INTO sources
    FROM public.proposal_revisions previous, jsonb_array_elements(previous.evidence) entry
    WHERE (previous.workspace_id, previous.project_id, previous.proposal_id, previous.revision)
      = (tenant, project, p_id, wanted_revision);
  END IF;
  PERFORM kordos_reviews.lock_projects(project, sources);
  access := kordos_planning.project_access(project);
  IF access IS NULL OR access = 'viewer' THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  IF p_action IN ('approve', 'reject', 'request_edit') AND access <> 'lead' THEN
    RETURN jsonb_build_object('result', 'forbidden');
  END IF;

  request := jsonb_build_object('mutationId', mutation, '_command', 'proposal.' || p_action,
    'hash', encode(sha256(convert_to(jsonb_build_array(p_id, p_input)::text, 'UTF8')), 'hex'));
  SELECT * INTO existing FROM public.outbox WHERE workspace_id = tenant AND actor_id = actor AND mutation_id = mutation;
  IF FOUND THEN
    IF existing.project_id <> project OR (existing.request - 'revision') <> request THEN
      RETURN jsonb_build_object('result', 'mutation_conflict');
    END IF;
    SELECT id INTO receipt_id FROM public.executions WHERE approval_audit_id = existing.id;
    RETURN jsonb_strip_nulls(jsonb_build_object('result', 'saved', 'id', existing.target_id,
      'revision', existing.request->'revision', 'receiptId', receipt_id));
  END IF;

  IF p_action <> 'create' THEN
    SELECT * INTO STRICT p FROM public.proposals WHERE id = p_id AND workspace_id = tenant FOR UPDATE;
    IF NOT kordos_reviews.can_read(p) THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
    IF p_action IN ('revise', 'submit') AND actor <> p.requester_id AND access <> 'lead' THEN
      RETURN jsonb_build_object('result', 'forbidden');
    END IF;
    IF p_action = 'approve' THEN
      SELECT id INTO receipt_id FROM public.executions WHERE workspace_id = tenant
        AND project_id = project AND proposal_id = p.id AND revision = wanted_revision;
      IF FOUND THEN
        RETURN jsonb_build_object('result', 'saved', 'id', p.id, 'revision', wanted_revision, 'receiptId', receipt_id);
      END IF;
    END IF;
    IF p.revision <> wanted_revision OR p.version <> (p_input->>'expectedVersion')::int THEN
      RETURN jsonb_build_object('result', 'conflict');
    END IF;
    SELECT * INTO STRICT r FROM public.proposal_revisions WHERE (workspace_id, project_id, proposal_id, revision)
      = (tenant, project, p.id, p.revision);
  END IF;

  target_brief := coalesce(p.brief_id, CASE WHEN p_action = 'create' THEN (p_input->>'briefId')::uuid END);
  IF target_brief IS NOT NULL THEN
    SELECT * INTO b FROM public.brief_jobs WHERE (workspace_id, project_id, id) = (tenant, project, target_brief);
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
    IF p_action = 'create' AND NOT kordos_briefs.editable(b) THEN RETURN jsonb_build_object('result', 'forbidden'); END IF;
    IF p_action = 'create' AND EXISTS (SELECT 1 FROM public.proposals WHERE proposals.brief_id = b.id) THEN
      RETURN jsonb_build_object('result', 'conflict');
    END IF;
    target_version := b.source_revision;
  ELSE
    SELECT * INTO w FROM public.work_items WHERE (workspace_id, project_id, id)
      = (tenant, project, coalesce(p.work_id, (p_input->>'workId')::uuid));
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  END IF;
  SELECT archived_at IS NULL AND w.archived_at IS NULL INTO STRICT writable
    FROM public.projects WHERE id = project AND workspace_id = tenant;
  IF NOT writable THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;

  IF p_action IN ('create', 'revise') THEN
    IF p.status IN ('applied', 'rejected', 'reconciliation_required') THEN
      RETURN jsonb_build_object('result', 'invalid_state');
    END IF;
    IF b.id IS NOT NULL THEN
      problem := kordos_briefs.plan_issue(project, p_input->'plan');
      IF problem IS NOT NULL THEN RETURN jsonb_build_object('result', problem); END IF;
      sources := kordos_briefs.sources(b, p_input->'plan');
      IF sources IS NULL THEN RETURN jsonb_build_object('result', 'evidence_changed'); END IF;
    ELSE
      IF w.version IS DISTINCT FROM target_version THEN RETURN jsonb_build_object('result', 'target_changed'); END IF;
      IF p_input->'command'->>'kind' IS DISTINCT FROM 'work.edit'
        OR p_input->'command'->'values'->>'kind' IS DISTINCT FROM w.kind::text THEN
        RETURN jsonb_build_object('result', 'invalid_state');
      END IF;
    END IF;
    expires := coalesce((p_input->>'expiresAt')::timestamptz, clock_timestamp() + interval '7 days');
    IF NOT (expires > clock_timestamp() AND expires <= clock_timestamp() + interval '30 days') THEN
      RETURN jsonb_build_object('result', 'invalid_expiry');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('source', source, 'version', c.version) ORDER BY position), '[]')
    INTO links FROM jsonb_array_elements(sources) WITH ORDINALITY s(source, position)
    LEFT JOIN public.comments c ON source->>'kind' = 'comment'
      AND (c.workspace_id, c.project_id, c.id) = (tenant, (source->>'projectId')::uuid, (source->>'id')::uuid);
    IF jsonb_array_length(kordos_reviews.citations(links)) <> jsonb_array_length(links) THEN
      RETURN jsonb_build_object('result', 'evidence_changed');
    END IF;

    IF p_action = 'create' THEN
      INSERT INTO public.proposals (workspace_id, project_id, work_id, brief_id, requester_id)
        VALUES (tenant, project, w.id, b.id, actor) RETURNING * INTO p;
    ELSE
      SELECT * INTO e FROM public.executions WHERE (workspace_id, project_id, proposal_id, revision)
        = (tenant, project, p.id, p.revision) AND status IN ('approved', 'applying') FOR UPDATE;
      IF FOUND THEN PERFORM kordos_reviews.finish(e, p, 'stale', 'superseded'); END IF;
      UPDATE public.proposals SET revision = revision + 1, version = version + 1, status = 'draft',
        reviewed_at = NULL, reviewer_id = NULL, reason = NULL WHERE id = p.id RETURNING * INTO p;
    END IF;
    INSERT INTO public.proposal_revisions (workspace_id, project_id, proposal_id, revision, author_id,
      target_version, command, before, evidence, expires_at)
    VALUES (tenant, project, p.id, p.revision, actor, target_version,
      CASE WHEN b.id IS NULL THEN p_input->'command' ELSE jsonb_build_object('kind', 'plan.create', 'plan', p_input->'plan') END,
      CASE WHEN b.id IS NULL THEN kordos_planning.work_snapshot(w) ELSE (
        SELECT jsonb_build_object('title', title) FROM public.document_versions
        WHERE (workspace_id, project_id, document_id, revision) = (tenant, project, b.document_id, b.source_revision)
      ) END, links, expires);

  ELSIF (p_action = 'submit' AND p.status = 'draft' AND p.reviewer_id IS NULL) OR
      (p_action IN ('approve', 'request_edit', 'reject') AND p.status = 'pending') THEN
    IF r.expires_at <= clock_timestamp() THEN RETURN jsonb_build_object('result', 'expired'); END IF;
    IF p_action IN ('approve', 'submit') THEN
      IF b.id IS NULL AND w.version <> r.target_version THEN RETURN jsonb_build_object('result', 'target_changed'); END IF;
      IF b.id IS NOT NULL THEN
        problem := kordos_briefs.plan_issue(project, r.command->'plan');
        IF problem IS NOT NULL THEN RETURN jsonb_build_object('result', problem); END IF;
      END IF;
    END IF;
    IF jsonb_array_length(kordos_reviews.citations(r.evidence)) <> jsonb_array_length(r.evidence) THEN
      RETURN jsonb_build_object('result', 'evidence_changed');
    END IF;
    UPDATE public.proposals SET status = CASE p_action
        WHEN 'submit' THEN 'pending' WHEN 'approve' THEN 'approved'
        WHEN 'reject' THEN 'rejected' ELSE 'draft' END::public.proposal_status,
      version = version + 1, submitted_at = CASE WHEN p_action = 'submit' THEN clock_timestamp() ELSE submitted_at END,
      reviewer_id = CASE WHEN p_action <> 'submit' THEN actor END,
      reviewed_at = CASE WHEN p_action <> 'submit' THEN clock_timestamp() END,
      reason = p_input->>'reason' WHERE id = p.id RETURNING * INTO p;
  ELSE
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;

  request := request || jsonb_build_object('revision', p.revision);
  IF p_action = 'approve' THEN
    receipt_id := gen_random_uuid();
    approval_event := kordos_reviews.event(p, 'proposal.approved', request, receipt_id);
    INSERT INTO public.executions
      (id, workspace_id, project_id, proposal_id, revision, reviewer_id, authority, approval_audit_id)
    VALUES (receipt_id, tenant, project, p.id, p.revision, actor, jsonb_build_object(
      'requester', kordos_reviews.authority(p.requester_id, project, r.evidence),
      'reviewer', kordos_reviews.authority(actor, project, r.evidence)), approval_event);
  ELSE
    PERFORM kordos_reviews.event(p, CASE p_action WHEN 'create' THEN 'proposal.drafted'
      WHEN 'revise' THEN 'proposal.revised' WHEN 'submit' THEN 'proposal.submitted'
      WHEN 'reject' THEN 'proposal.rejected' ELSE 'proposal.edits_requested' END, request);
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('result', 'saved', 'id', p.id, 'revision', p.revision, 'receiptId', receipt_id));
END
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.run(p_execution uuid, p_step text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  e public.executions;
  p public.proposals;
  r public.proposal_revisions;
  w public.work_items;
  saved jsonb;
  effect_id uuid;
  requester_access public.project_role;
  requester_evidence boolean;
  requester_authority jsonb;
  reviewer_authority jsonb;
BEGIN
  IF p_step NOT IN ('claim', 'apply', 'fail') THEN RETURN false; END IF;
  SELECT * INTO e FROM public.executions WHERE id = p_execution AND status IN ('approved', 'applying');
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM set_config('kordos.workspace_id', e.workspace_id::text, true);
  PERFORM set_config('kordos.actor_id', e.reviewer_id::text, true);
  SELECT * INTO STRICT r FROM public.proposal_revisions WHERE (workspace_id, project_id, proposal_id, revision)
    = (e.workspace_id, e.project_id, e.proposal_id, e.revision);

  -- Hold the same workspace and project locks as membership and work edits.
  -- Lock cited projects in the same order as review commands before checking access.
  PERFORM kordos_planning.lock_workspace(e.write_mutation_id);
  PERFORM kordos_reviews.lock_projects(e.project_id,
    (SELECT coalesce(jsonb_agg(source->'source'), '[]') FROM jsonb_array_elements(r.evidence) source));
  SELECT * INTO STRICT p FROM public.proposals WHERE id = e.proposal_id FOR UPDATE;
  SELECT * INTO STRICT e FROM public.executions WHERE id = p_execution FOR UPDATE;
  IF p.revision <> e.revision OR e.status NOT IN ('approved', 'applying') THEN RETURN false; END IF;

  IF p_step = 'claim' THEN
    IF e.status = 'approved' THEN
      UPDATE public.executions SET status = 'applying' WHERE id = e.id;
      UPDATE public.proposals SET status = 'applying', version = version + 1 WHERE id = p.id;
      PERFORM kordos_reviews.event(p, 'proposal.applying', jsonb_build_object('mutationId', gen_random_uuid()), e.id, NULL, true);
    END IF;
    RETURN true;
  END IF;
  -- A prior effect and an unfinished receipt cannot result from our atomic
  -- write. Stop if the stored mutation key is already associated with an event.
  IF EXISTS (SELECT 1 FROM public.outbox WHERE workspace_id = e.workspace_id
    AND actor_id = e.reviewer_id AND mutation_id = e.write_mutation_id) THEN
    PERFORM kordos_reviews.finish(e, p, 'reconciliation_required', 'ambiguous_effect');
    RETURN false;
  END IF;

  IF p_step = 'fail' THEN
    PERFORM kordos_reviews.finish(e, p, 'failed', 'worker_failed');
    RETURN false;
  END IF;
  IF e.status <> 'applying' THEN RETURN false; END IF;
  IF r.expires_at <= clock_timestamp() THEN
    PERFORM kordos_reviews.finish(e, p, 'expired', 'expired');
    RETURN false;
  END IF;

  PERFORM set_config('kordos.actor_id', p.requester_id::text, true);
  requester_access := kordos_planning.project_access(p.project_id);
  requester_evidence := jsonb_array_length(kordos_reviews.citations(r.evidence)) = jsonb_array_length(r.evidence);
  PERFORM set_config('kordos.actor_id', e.reviewer_id::text, true);
  requester_authority := kordos_reviews.authority(p.requester_id, p.project_id, r.evidence);
  reviewer_authority := kordos_reviews.authority(e.reviewer_id, p.project_id, r.evidence);
  IF requester_access IS NULL OR requester_access = 'viewer'
    OR kordos_planning.project_access(p.project_id) IS DISTINCT FROM 'lead'
    OR requester_authority->'target' IS DISTINCT FROM e.authority->'requester'->'target'
    OR reviewer_authority->'target' IS DISTINCT FROM e.authority->'reviewer'->'target' THEN
    PERFORM kordos_reviews.finish(e, p, 'stale', 'access_changed');
    RETURN false;
  END IF;
  IF NOT requester_evidence OR jsonb_array_length(kordos_reviews.citations(r.evidence)) <> jsonb_array_length(r.evidence)
    OR requester_authority->'sources' IS DISTINCT FROM e.authority->'requester'->'sources'
    OR reviewer_authority->'sources' IS DISTINCT FROM e.authority->'reviewer'->'sources' THEN
    PERFORM kordos_reviews.finish(e, p, 'stale', 'evidence_changed');
    RETURN false;
  END IF;

  IF p.brief_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.projects WHERE workspace_id = p.workspace_id AND id = p.project_id AND archived_at IS NOT NULL) THEN
      PERFORM kordos_reviews.finish(e, p, 'stale', 'target_unavailable');
      RETURN false;
    END IF;
    effect_id := kordos_briefs.apply_plan(p, r.command->'plan', e.write_mutation_id);
    IF effect_id IS NULL THEN
      PERFORM kordos_reviews.finish(e, p, 'failed', 'invalid_change');
      RETURN false;
    END IF;
    PERFORM kordos_reviews.finish(e, p, 'applied', NULL, effect_id);
    RETURN true;
  END IF;

  SELECT * INTO STRICT w FROM public.work_items WHERE (workspace_id, project_id, id) = (p.workspace_id, p.project_id, p.work_id);
  IF w.version <> r.target_version THEN
    PERFORM kordos_reviews.finish(e, p, 'stale', 'target_changed');
    RETURN false;
  END IF;
  IF w.archived_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.projects WHERE workspace_id = p.workspace_id AND id = p.project_id AND archived_at IS NOT NULL
  ) THEN
    PERFORM kordos_reviews.finish(e, p, 'stale', 'target_unavailable');
    RETURN false;
  END IF;

  saved := kordos_planning.save_work(p.project_id, p.work_id, r.command->'values' ||
    jsonb_build_object('action', 'edit', 'expectedVersion', r.target_version, 'mutationId', e.write_mutation_id));
  IF saved->>'result' IS DISTINCT FROM 'saved' THEN
    PERFORM kordos_reviews.finish(e, p, 'failed', 'invalid_change');
    RETURN false;
  END IF;

  SELECT id INTO STRICT effect_id FROM public.outbox WHERE workspace_id = p.workspace_id
    AND actor_id = e.reviewer_id AND mutation_id = e.write_mutation_id;
  PERFORM kordos_reviews.finish(e, p, 'applied', NULL, effect_id);
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.audit(p_filter jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH cursor_row AS (
    SELECT a.created_at, a.id FROM public.audit_events a
    WHERE a.workspace_id = kordos_identity.workspace_id() AND a.id = (p_filter->>'cursor')::uuid
      AND CASE WHEN a.project_id IS NULL THEN kordos_identity.current_role() = 'admin'
        ELSE kordos_planning.project_access(a.project_id) IS NOT NULL END
  ), entries AS (
    SELECT a.*, project.name AS project_name
    FROM public.audit_events a
    LEFT JOIN public.projects project ON (project.workspace_id, project.id) = (a.workspace_id, a.project_id)
    WHERE a.workspace_id = kordos_identity.workspace_id()
      AND CASE WHEN a.project_id IS NULL THEN kordos_identity.current_role() = 'admin'
        ELSE kordos_planning.project_access(a.project_id) IS NOT NULL END
      AND (p_filter->>'eventId' IS NULL OR a.id = (p_filter->>'eventId')::uuid)
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
      'actorType', CASE WHEN e.id IS NOT NULL OR (CASE WHEN a.action LIKE 'brief.%' THEN a.details->'after' ELSE meta END)->>'executor' = 'true' THEN 'service' ELSE 'user' END,
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
