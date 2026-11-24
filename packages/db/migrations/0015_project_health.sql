CREATE TABLE "duplicate_dismissals" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"first_id" uuid NOT NULL,
	"second_id" uuid NOT NULL,
	"first_version" integer NOT NULL,
	"second_version" integer NOT NULL,
	CONSTRAINT "duplicate_dismissals_pk" PRIMARY KEY("workspace_id","project_id","first_id","second_id","first_version","second_version"),
	CONSTRAINT "duplicate_dismissals_ordered" CHECK ("duplicate_dismissals"."first_id" < "duplicate_dismissals"."second_id")
);
--> statement-breakpoint
CREATE TABLE "project_weeklies" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"period" date NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "project_weeklies_workspace_id_project_id_period_pk" PRIMARY KEY("workspace_id","project_id","period")
);
--> statement-breakpoint
CREATE TABLE "work_relations" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"first_id" uuid NOT NULL,
	"second_id" uuid NOT NULL,
	"consolidated_into" uuid,
	CONSTRAINT "work_relations_workspace_id_project_id_first_id_second_id_pk" PRIMARY KEY("workspace_id","project_id","first_id","second_id"),
	CONSTRAINT "work_relations_ordered" CHECK ("work_relations"."first_id" < "work_relations"."second_id"),
	CONSTRAINT "work_relations_target" CHECK ("work_relations"."consolidated_into" IN ("work_relations"."first_id", "work_relations"."second_id"))
);
--> statement-breakpoint
ALTER TABLE "proposal_revisions" DROP CONSTRAINT "proposal_revisions_command";--> statement-breakpoint
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_first_fk" FOREIGN KEY ("workspace_id","project_id","first_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_second_fk" FOREIGN KEY ("workspace_id","project_id","second_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_weeklies" ADD CONSTRAINT "project_weeklies_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_relations" ADD CONSTRAINT "work_relations_first_fk" FOREIGN KEY ("workspace_id","project_id","first_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_relations" ADD CONSTRAINT "work_relations_second_fk" FOREIGN KEY ("workspace_id","project_id","second_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_relations_second_idx" ON "work_relations" USING btree ("workspace_id","project_id","second_id");--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_command" CHECK (coalesce("proposal_revisions"."command"->>'kind' IN ('work.edit', 'plan.create', 'meeting.accept', 'github.comment', 'work.consolidate'), false));
--> statement-breakpoint
CREATE SCHEMA kordos_health;
GRANT USAGE ON SCHEMA kordos_health TO kordos_app, kordos_brief_worker;
ALTER TABLE public.project_weeklies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duplicate_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_relations ENABLE ROW LEVEL SECURITY;

-- Reuse the same authorized schedule for forecasts and weekly snapshots.
CREATE FUNCTION kordos_planning.read_schedule(p_workspace uuid, p_project uuid)
RETURNS TABLE ("graphVersion" int, archived boolean, "readAtMillis" float8,
  "inputRevision" text, calendar jsonb, items jsonb, edges jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    WITH items AS MATERIALIZED (
      SELECT id, title, kind, status, version, estimate_days, commitment, completed_at, owner_id
      FROM public.work_items
      WHERE workspace_id = kordos_identity.workspace_id() AND project_id = p_project AND archived_at IS NULL
    )
    SELECT p.graph_version AS "graphVersion", p.archived_at IS NOT NULL AS archived,
      (extract(epoch FROM statement_timestamp()) * 1000)::float8 AS "readAtMillis",
      kordos_planning.schedule_fingerprint(p.id, p.version, p.graph_version, work.revisions)
        AS "inputRevision",
      jsonb_build_object(
        'timeZone', p.time_zone, 'workdays', p.workdays, 'nonworkingDates', p.nonworking_dates
      ) AS calendar,
      coalesce(work.items, '[]'::jsonb) AS items,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object('predecessorId', e.predecessor_id, 'successorId', e.successor_id)
          ORDER BY e.predecessor_id, e.successor_id)
        FROM public.dependency_edges e JOIN items a ON a.id = e.predecessor_id JOIN items b ON b.id = e.successor_id
        WHERE e.workspace_id = p.workspace_id AND e.project_id = p.id
      ), '[]'::jsonb) AS edges
    FROM public.projects p
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'title', i.title, 'kind', i.kind, 'status', i.status, 'version', i.version,
        'estimateDays', i.estimate_days, 'commitment', i.commitment,
        'completedAt', to_char(i.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'owner', kordos_planning.person(p.id, i.owner_id)
      ) ORDER BY i.title, i.id) AS items,
      jsonb_agg(jsonb_build_array(i.id, i.version) ORDER BY i.id) AS revisions
      FROM items i
    ) work
    WHERE p.workspace_id = p_workspace AND p_workspace = kordos_identity.workspace_id() AND p.id = p_project AND kordos_planning.project_access(p_project) IS NOT NULL
$$;
REVOKE EXECUTE ON FUNCTION kordos_planning.read_schedule(uuid,uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_planning TO kordos_brief_worker;
GRANT EXECUTE ON FUNCTION kordos_planning.read_schedule(uuid,uuid) TO kordos_app, kordos_brief_worker;

-- The worker holds the project row through capture. Competing workers skip it,
-- and ordinary work, graph and project commands serialize on the same row.
CREATE FUNCTION kordos_health.next_project() RETURNS TABLE (workspace uuid, project uuid, actor uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT p.workspace_id, p.id, lead.user_id
  FROM public.projects p
  JOIN LATERAL (
    SELECT m.user_id FROM public.project_members m
    JOIN public.memberships w ON (w.workspace_id, w.user_id) = (m.workspace_id, m.user_id)
    WHERE (m.workspace_id, m.project_id) = (p.workspace_id, p.id)
      AND m.role = 'lead' AND m.removed_at IS NULL AND w.removed_at IS NULL AND w.role <> 'viewer'
    ORDER BY m.joined_at, m.user_id LIMIT 1
  ) lead ON true
  LEFT JOIN public.project_weeklies r ON (r.workspace_id, r.project_id, r.period)
    = (p.workspace_id, p.id, date_trunc('week', transaction_timestamp() AT TIME ZONE p.time_zone)::date)
  WHERE p.archived_at IS NULL AND (r.generated_at IS NULL OR r.generated_at < transaction_timestamp() - interval '1 minute')
  ORDER BY r.generated_at NULLS FIRST, p.id
  LIMIT 1 FOR UPDATE OF p SKIP LOCKED
$$;

CREATE FUNCTION kordos_health.save_report(p_project uuid, p_snapshot jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  start_date date;
  local_zone text;
  captured timestamptz := transaction_timestamp();
  blockers jsonb;
  changes jsonb;
  decisions jsonb;
BEGIN
  IF kordos_planning.project_access(p_project) IS DISTINCT FROM 'lead' THEN RETURN; END IF;
  SELECT time_zone, date_trunc('week', captured AT TIME ZONE time_zone)::date
  INTO local_zone, start_date FROM public.projects
  WHERE (workspace_id, id) = (tenant, p_project) AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND OR local_zone IS DISTINCT FROM p_snapshot->>'timeZone'
    OR (captured AT TIME ZONE local_zone)::date IS DISTINCT FROM (p_snapshot->>'asOf')::date THEN RETURN; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'version', version) ORDER BY id), '[]')
  INTO blockers FROM public.work_items WHERE (workspace_id, project_id) = (tenant, p_project)
    AND archived_at IS NULL AND status <> 'done' AND blocker_reason IS NOT NULL AND blocker_resolution IS NULL;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', target_id, 'version', (details->'after'->>'version')::int, 'kind', details->'after'->>'kind',
    'title', details->'after'->>'title', 'eventId', id, 'action',
    CASE WHEN action = 'work.created' AND details->'after'->>'status' = 'done' THEN 'work.completed' ELSE action END,
    'occurredAt', created_at) ORDER BY created_at DESC, id DESC), '[]')
  INTO changes FROM public.audit_events
  WHERE (workspace_id, project_id) = (tenant, p_project)
    AND created_at >= (start_date::timestamp AT TIME ZONE local_zone)
    AND created_at < (start_date + 7)::timestamp AT TIME ZONE local_zone
    AND action IN ('work.created', 'work.edited', 'work.reopened', 'work.completed', 'work.archived', 'work.restored')
    AND details->'after'->>'version' IS NOT NULL;

  -- Save revision references for decision requests. Each reader must still
  -- resolve the proposal and its complete evidence under their own authority.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'version', p.revision) ORDER BY p.submitted_at, p.id), '[]')
  INTO decisions FROM public.proposals p JOIN public.proposal_revisions r
    ON (r.workspace_id, r.project_id, r.proposal_id, r.revision) = (p.workspace_id, p.project_id, p.id, p.revision)
  WHERE (p.workspace_id, p.project_id) = (tenant, p_project)
    AND p.status = 'pending' AND kordos_reviews.effective_status(p, r) = 'pending';

  INSERT INTO public.project_weeklies (workspace_id, project_id, period, generated_at, snapshot)
    VALUES (tenant, p_project, start_date, captured, p_snapshot || jsonb_build_object(
      'blockers', blockers, 'changes', changes, 'decisions', decisions))
    ON CONFLICT (workspace_id, project_id, period) DO UPDATE
    SET generated_at = excluded.generated_at, snapshot = excluded.snapshot
    WHERE excluded.generated_at > project_weeklies.generated_at;
END
$$;

CREATE FUNCTION kordos_health.reports(p_project uuid, p_period date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH project AS (
    SELECT p.* FROM public.projects p WHERE (p.workspace_id, p.id) = (kordos_identity.workspace_id(), p_project)
      AND kordos_planning.project_access(p_project) IS NOT NULL
  ), available AS (
    SELECT r.* FROM public.project_weeklies r JOIN project p ON (r.workspace_id, r.project_id) = (p.workspace_id, p.id)
  ), selected AS (
    SELECT r.* FROM available r WHERE p_period IS NULL OR r.period = p_period ORDER BY r.period DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'periods', coalesce((SELECT jsonb_agg(period ORDER BY period DESC) FROM available), '[]'),
    'report', (
      SELECT (r.snapshot - ARRAY['active','milestones','blockers','missingEstimates','changes','decisions'])
        || (
          SELECT jsonb_object_agg(section, refs)
          FROM unnest(ARRAY['active','milestones','blockers','missingEstimates']) AS keys(section)
          CROSS JOIN LATERAL (
            SELECT coalesce(jsonb_agg(ref ORDER BY position), '[]') AS refs
            FROM jsonb_array_elements(r.snapshot->section) WITH ORDINALITY AS work(ref, position)
            JOIN public.work_items w ON (w.workspace_id,w.project_id,w.id) = (p.workspace_id,p.id,(ref->>'id')::uuid)
          ) visible
        )
        || jsonb_build_object(
        'period', r.period, 'endExclusive', r.period + 7, 'generatedAt', r.generated_at,
        'stale', r.period = date_trunc('week', statement_timestamp() AT TIME ZONE p.time_zone)::date
          AND (r.snapshot->>'inputRevision' IS DISTINCT FROM kordos_risks.fingerprint(p.workspace_id, p.id)
            OR r.generated_at < statement_timestamp() - interval '2 minutes'),
        'changes', coalesce((
          SELECT jsonb_agg(ref ORDER BY position)
          FROM jsonb_array_elements(r.snapshot->'changes') WITH ORDINALITY AS refs(ref, position)
          JOIN public.audit_events a ON (a.workspace_id,a.project_id,a.id) = (p.workspace_id,p.id,(ref->>'eventId')::uuid)
        ), '[]'),
        'decisions', coalesce((
          SELECT jsonb_agg(ref || jsonb_build_object('title', view->>'title') ORDER BY position)
          FROM jsonb_array_elements(r.snapshot->'decisions') WITH ORDINALITY AS refs(ref, position)
          CROSS JOIN LATERAL kordos_reviews.detail((ref->>'id')::uuid, (ref->>'version')::int) AS detail(view)
          WHERE view IS NOT NULL AND view->>'evidenceRestricted' = 'false' AND view->>'title' IS NOT NULL
        ), '[]'))
      FROM selected r
    )
  ) FROM project p
$$;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE FUNCTION kordos_health.task_preview(w public.work_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id', w.id, 'version', w.version, 'title', w.title, 'description', w.description,
    'status', w.status, 'owner', kordos_planning.person(w.project_id, w.owner_id),
    'predecessors', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title) ORDER BY t.title, t.id)
      FROM public.dependency_edges e JOIN public.work_items t
        ON (t.workspace_id,t.project_id,t.id) = (e.workspace_id,e.project_id,e.predecessor_id)
      WHERE (e.workspace_id,e.project_id,e.successor_id) = (w.workspace_id,w.project_id,w.id)
        AND t.archived_at IS NULL
    ), '[]'),
    'successors', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title) ORDER BY t.title, t.id)
      FROM public.dependency_edges e JOIN public.work_items t
        ON (t.workspace_id,t.project_id,t.id) = (e.workspace_id,e.project_id,e.successor_id)
      WHERE (e.workspace_id,e.project_id,e.predecessor_id) = (w.workspace_id,w.project_id,w.id)
        AND t.archived_at IS NULL
    ), '[]'))
$$;

CREATE FUNCTION kordos_health.duplicates(p_project uuid, p_work uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'task', kordos_health.task_preview(w),
    'graphVersion', p.graph_version,
    'canAct', w.archived_at IS NULL AND w.status <> 'done' AND p.archived_at IS NULL
      AND kordos_planning.project_access(p_project) IN ('lead', 'contributor'),
    'links', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', other.id, 'title', other.title,
        'relation', CASE WHEN l.consolidated_into = w.id THEN 'consolidated_from'
          WHEN l.consolidated_into = other.id THEN 'consolidated_into' ELSE 'related' END)
        ORDER BY other.title, other.id)
      FROM public.work_relations l JOIN public.work_items other
        ON (other.workspace_id,other.project_id,other.id) = (l.workspace_id,l.project_id,
          CASE WHEN l.first_id = w.id THEN l.second_id ELSE l.first_id END)
      WHERE (l.workspace_id,l.project_id) = (w.workspace_id,w.project_id)
        AND w.id IN (l.first_id,l.second_id)
    ), '[]'),
    'candidates', coalesce((
      SELECT jsonb_agg(kordos_health.task_preview(candidate) ORDER BY score DESC,ranked.id)
      FROM (
        SELECT t AS candidate, t.id, score
        FROM public.work_items t
        CROSS JOIN LATERAL (
          SELECT greatest(
            public.similarity(w.title,t.title),
            0.85 * greatest(public.word_similarity(w.title,t.title),public.word_similarity(t.title,w.title)),
            0.75 * greatest(public.similarity(left(w.description,2000),left(t.description,2000)),
              public.word_similarity(w.title,left(t.description,2000)),
              public.word_similarity(t.title,left(w.description,2000)))
          ) AS score
        ) ranking
        WHERE (t.workspace_id,t.project_id) = (w.workspace_id,w.project_id)
          AND w.archived_at IS NULL AND w.status <> 'done' AND p.archived_at IS NULL
          AND t.id <> w.id AND t.kind = 'task' AND t.archived_at IS NULL AND t.status <> 'done'
          AND score >= 0.36
          AND NOT EXISTS (SELECT FROM public.duplicate_dismissals d
            WHERE (d.workspace_id,d.project_id,d.first_id,d.second_id,d.first_version,d.second_version) =
              (w.workspace_id,w.project_id,least(w.id,t.id),greatest(w.id,t.id),
               CASE WHEN w.id < t.id THEN w.version ELSE t.version END,
               CASE WHEN w.id < t.id THEN t.version ELSE w.version END))
          AND NOT EXISTS (SELECT FROM public.work_relations l
            WHERE (l.workspace_id,l.project_id,l.first_id,l.second_id) =
              (w.workspace_id,w.project_id,least(w.id,t.id),greatest(w.id,t.id)))
        ORDER BY score DESC,t.id LIMIT 12
      ) ranked
    ), '[]'))
  FROM public.work_items w JOIN public.projects p ON (p.workspace_id,p.id) = (w.workspace_id,w.project_id)
  WHERE (w.workspace_id,w.project_id,w.id) = (kordos_identity.workspace_id(),p_project,p_work)
    AND w.kind = 'task' AND kordos_planning.project_access(p_project) IS NOT NULL
$$;

-- The proposal binds the archive target, both revisions and the exact graph
-- additions. The original edges remain attached to the historical task.
CREATE FUNCTION kordos_health.redirects(p_workspace uuid, p_project uuid, p_keep uuid, p_archive uuid)
RETURNS TABLE (predecessor uuid, successor uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN e.predecessor_id = p_archive THEN p_keep ELSE e.predecessor_id END,
    CASE WHEN e.successor_id = p_archive THEN p_keep ELSE e.successor_id END
  FROM public.dependency_edges e
  WHERE (e.workspace_id,e.project_id) = (p_workspace,p_project)
    AND p_archive IN (e.predecessor_id,e.successor_id) AND p_keep NOT IN (e.predecessor_id,e.successor_id)
  EXCEPT
  SELECT e.predecessor_id,e.successor_id FROM public.dependency_edges e
  WHERE (e.workspace_id,e.project_id) = (p_workspace,p_project)
$$;

CREATE FUNCTION kordos_health.would_cycle(p_workspace uuid, p_project uuid, p_keep uuid, p_archive uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  WITH RECURSIVE additions AS MATERIALIZED (
    SELECT * FROM kordos_health.redirects(p_workspace,p_project,p_keep,p_archive)
  ), edges AS (
    SELECT e.predecessor_id AS predecessor,e.successor_id AS successor
    FROM public.dependency_edges e WHERE (e.workspace_id,e.project_id) = (p_workspace,p_project)
    UNION ALL SELECT * FROM additions
  ), reach(origin, node) AS (
    SELECT predecessor, successor FROM additions
    UNION
    SELECT r.origin, e.successor FROM reach r JOIN edges e ON e.predecessor = r.node
  )
  SELECT EXISTS (SELECT FROM reach WHERE origin = node)
$$;

CREATE FUNCTION kordos_health.pair_action(p_project uuid, p_work uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  other_id uuid := (p_input->'other'->>'id')::uuid;
  first_id uuid := least(p_work,other_id);
  second_id uuid := greatest(p_work,other_id);
  action text := p_input->>'action';
  request jsonb := p_input || jsonb_build_object('_command','duplicate.' || action, 'workId', p_work);
  keep public.work_items;
  discard public.work_items;
  project public.projects;
  proposal public.proposals;
  proposed_change jsonb;
  replay jsonb;
BEGIN
  IF kordos_planning.project_access(p_project) IS NULL THEN RETURN jsonb_build_object('result','unavailable'); END IF;
  IF NOT kordos_planning.lock_schedule(p_project,(p_input->>'mutationId')::uuid) THEN
    RETURN jsonb_build_object('result','forbidden');
  END IF;
  replay := kordos_planning.replay(request,p_project,NULL);
  IF replay IS NOT NULL THEN RETURN replay; END IF;

  SELECT * INTO project FROM public.projects WHERE (workspace_id,id) = (tenant,p_project);
  SELECT * INTO keep FROM public.work_items WHERE (workspace_id,project_id,id) = (tenant,p_project,p_work) AND kind = 'task';
  SELECT * INTO discard FROM public.work_items WHERE (workspace_id,project_id,id) = (tenant,p_project,other_id) AND kind = 'task';
  IF keep.id IS NULL OR discard.id IS NULL OR keep.id = discard.id THEN
    RETURN jsonb_build_object('result','unavailable');
  END IF;
  IF project.archived_at IS NOT NULL OR keep.archived_at IS NOT NULL OR discard.archived_at IS NOT NULL
    OR keep.status = 'done' OR discard.status = 'done' OR action IS NULL
    OR action NOT IN ('dismiss','relate','consolidate') THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
  IF keep.version IS DISTINCT FROM (p_input->>'taskVersion')::int
    OR discard.version IS DISTINCT FROM (p_input->'other'->>'version')::int
    OR (action = 'consolidate' AND project.graph_version IS DISTINCT FROM (p_input->>'graphVersion')::int)
  THEN RETURN jsonb_build_object('result','conflict'); END IF;

  IF action = 'dismiss' THEN
    INSERT INTO public.duplicate_dismissals VALUES (tenant,p_project,first_id,second_id,
      CASE WHEN keep.id = first_id THEN keep.version ELSE discard.version END,
      CASE WHEN keep.id = first_id THEN discard.version ELSE keep.version END)
      ON CONFLICT ON CONSTRAINT duplicate_dismissals_pk DO NOTHING;
  ELSIF action = 'relate' THEN
    INSERT INTO public.work_relations VALUES (tenant,p_project,first_id,second_id,NULL)
      ON CONFLICT ON CONSTRAINT work_relations_workspace_id_project_id_first_id_second_id_pk DO NOTHING;
  ELSE
    IF kordos_health.would_cycle(tenant,p_project,keep.id,discard.id) THEN
      RETURN jsonb_build_object('result','cycle');
    END IF;
    SELECT jsonb_build_object('kind','work.consolidate','graphVersion',project.graph_version,
      'keep',jsonb_build_object('id',keep.id,'title',keep.title,'version',keep.version),
      'archive',jsonb_build_object('id',discard.id,'title',discard.title,'version',discard.version),
      'dependencies',coalesce(jsonb_agg(jsonb_build_object('predecessorId', d.predecessor,
        'successorId',d.successor,'predecessorTitle',a.title,'successorTitle',b.title)
        ORDER BY d.predecessor,d.successor), '[]')) INTO proposed_change
    FROM kordos_health.redirects(tenant,p_project,keep.id,discard.id) d
    JOIN public.work_items a ON (a.workspace_id,a.project_id,a.id) = (tenant,p_project,d.predecessor)
    JOIN public.work_items b ON (b.workspace_id,b.project_id,b.id) = (tenant,p_project,d.successor);

    SELECT p.* INTO proposal FROM public.proposals p JOIN public.proposal_revisions r
      ON (r.workspace_id,r.project_id,r.proposal_id,r.revision) = (p.workspace_id,p.project_id,p.id,p.revision)
    WHERE (p.workspace_id,p.project_id,p.work_id,p.requester_id) = (tenant,p_project,keep.id,actor)
      AND p.status IN ('pending','approved','applying') AND r.expires_at > statement_timestamp()
      AND r.command = proposed_change ORDER BY p.created_at,p.id LIMIT 1;
    IF FOUND THEN
      PERFORM kordos_reviews.event(proposal,'duplicate.proposal_reused',request);
      RETURN jsonb_build_object('result','saved','id',proposal.id);
    END IF;

    INSERT INTO public.proposals (workspace_id, project_id, work_id, requester_id, status, submitted_at)
      VALUES (tenant,p_project,keep.id,actor,'pending',clock_timestamp()) RETURNING * INTO proposal;
    INSERT INTO public.proposal_revisions (workspace_id,project_id,proposal_id,revision,author_id,target_version,command,before,evidence,expires_at)
      VALUES (tenant,p_project,proposal.id,proposal.revision,actor,keep.version,proposed_change,
        kordos_planning.work_snapshot(keep),'[]',clock_timestamp() + interval '7 days');
    PERFORM kordos_reviews.event(proposal,'proposal.submitted',request);
    RETURN jsonb_build_object('result','saved','id',proposal.id);
  END IF;

  PERFORM kordos_planning.emit(p_project,keep.id,'duplicate.' || action,request,NULL,
    jsonb_build_object('workId',keep.id,'otherId',discard.id,'workVersion',keep.version,'otherVersion',discard.version));
  RETURN jsonb_build_object('result','saved','id',keep.id);
END
$$;

CREATE FUNCTION kordos_health.consolidation_current(p public.proposals, r public.proposal_revisions)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT FROM public.projects project JOIN public.work_items a
      ON (a.workspace_id,a.project_id,a.id) = (p.workspace_id,p.project_id,p.work_id)
    JOIN public.work_items b ON (b.workspace_id,b.project_id,b.id) =
      (p.workspace_id,p.project_id,(r.command->'archive'->>'id')::uuid)
    WHERE (project.workspace_id,project.id) = (p.workspace_id,p.project_id)
      AND project.archived_at IS NULL AND a.archived_at IS NULL AND b.archived_at IS NULL
      AND a.status <> 'done' AND b.status <> 'done' AND a.version = r.target_version
      AND b.version = (r.command->'archive'->>'version')::int
      AND project.graph_version = (r.command->>'graphVersion')::int
  )
$$;

ALTER FUNCTION kordos_reviews.effective_status(public.proposals,public.proposal_revisions) RENAME TO effective_status_before_health;
CREATE FUNCTION kordos_reviews.effective_status(p public.proposals, r public.proposal_revisions)
RETURNS public.proposal_status LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN r.command->>'kind' = 'work.consolidate'
    AND p.status IN ('pending','approved','applying') AND NOT kordos_health.consolidation_current(p,r)
    THEN 'stale'::public.proposal_status ELSE kordos_reviews.effective_status_before_health(p,r) END
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.effective_status(public.proposals,public.proposal_revisions) FROM PUBLIC;

ALTER FUNCTION kordos_reviews.summary(public.proposals,public.projects,public.work_items,public.proposal_revisions) RENAME TO summary_before_health;
CREATE FUNCTION kordos_reviews.summary(p public.proposals, project public.projects, w public.work_items, r public.proposal_revisions)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT kordos_reviews.summary_before_health(p,project,w,r) ||
    CASE WHEN r.command->>'kind' = 'work.consolidate' THEN jsonb_build_object(
      'title', 'Consolidate into ' || (r.command->'keep'->>'title'),
      'status', kordos_reviews.effective_status(p,r))
    ELSE '{}'::jsonb END
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.summary(public.proposals,public.projects,public.work_items,public.proposal_revisions) FROM PUBLIC;

ALTER FUNCTION kordos_reviews.detail(uuid,int) RENAME TO detail_before_health;
REVOKE EXECUTE ON FUNCTION kordos_reviews.detail_before_health(uuid,int) FROM kordos_app;
CREATE FUNCTION kordos_reviews.detail(p_id uuid,p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT view || CASE WHEN r.command->>'kind' = 'work.consolidate' THEN jsonb_build_object(
    'consolidation', r.command,
    'canEdit', false,
    'canSubmit', false,
    'canReview', view->'canReview' = 'true' AND kordos_health.consolidation_current(p,r),
    'status', CASE WHEN p.revision = r.revision THEN to_jsonb(kordos_reviews.effective_status(p,r)) ELSE view->'status' END)
  ELSE '{}'::jsonb END
  FROM kordos_reviews.detail_before_health(p_id,p_revision) AS detail(view)
  LEFT JOIN public.proposals p ON p.id = p_id AND view IS NOT NULL
  LEFT JOIN public.proposal_revisions r ON (r.workspace_id,r.project_id,r.proposal_id,r.revision)
    = (p.workspace_id,p.project_id,p.id,coalesce(p_revision,p.revision))
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.detail(uuid,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.detail(uuid,int) TO kordos_app;

ALTER FUNCTION kordos_reviews.mutate(uuid,uuid,text,jsonb) RENAME TO mutate_before_health;
REVOKE EXECUTE ON FUNCTION kordos_reviews.mutate_before_health(uuid,uuid,text,jsonb) FROM kordos_app;
CREATE FUNCTION kordos_reviews.mutate(p_project uuid,p_id uuid,p_action text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  p public.proposals;
  r public.proposal_revisions;
BEGIN
  SELECT candidate.* INTO p FROM public.proposals candidate JOIN public.proposal_revisions rev
    ON (rev.workspace_id,rev.project_id,rev.proposal_id,rev.revision) =
      (candidate.workspace_id,candidate.project_id,candidate.id,candidate.revision)
  WHERE candidate.workspace_id = kordos_identity.workspace_id() AND candidate.id = p_id
    AND rev.command->>'kind' = 'work.consolidate';

  IF FOUND THEN
    IF NOT kordos_reviews.can_read(p) THEN RETURN jsonb_build_object('result','unavailable'); END IF;
    IF p_action IN ('revise','submit') THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
    IF p_action = 'approve' AND kordos_planning.project_access(p.project_id) = 'lead' THEN
      PERFORM kordos_planning.lock_workspace((p_input->>'mutationId')::uuid);
      PERFORM kordos_reviews.lock_projects(p.project_id,'[]');
      IF kordos_planning.project_access(p.project_id) = 'lead' AND NOT EXISTS (
        SELECT FROM public.executions WHERE proposal_id = p_id AND revision = (p_input->>'revision')::int
      ) THEN
        SELECT * INTO STRICT r FROM public.proposal_revisions
        WHERE (workspace_id,project_id,proposal_id,revision) = (p.workspace_id,p.project_id,p.id,p.revision);
        IF NOT kordos_health.consolidation_current(p,r) THEN
          RETURN jsonb_build_object('result','consolidation_stale');
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN kordos_reviews.mutate_before_health(p_project,p_id,p_action,p_input);
END
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.mutate(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.mutate(uuid,uuid,text,jsonb) TO kordos_app;

ALTER FUNCTION kordos_planning.save_work(uuid,uuid,jsonb) RENAME TO save_work_before_health;
REVOKE EXECUTE ON FUNCTION kordos_planning.save_work_before_health(uuid,uuid,jsonb) FROM kordos_app;
CREATE FUNCTION kordos_planning.save_work(p_project uuid,p_work uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  repeated jsonb;
BEGIN
  IF p_input->>'action' = 'restore' THEN
    IF NOT kordos_planning.lock_schedule(p_project,(p_input->>'mutationId')::uuid) THEN
      RETURN jsonb_build_object('result','unavailable');
    END IF;
    repeated := kordos_planning.replay(p_input || jsonb_build_object('_command','work.update'),p_project,p_work);
    IF repeated IS NOT NULL THEN RETURN repeated; END IF;
    IF EXISTS (SELECT FROM public.work_relations l
      WHERE (l.workspace_id,l.project_id) = (kordos_identity.workspace_id(),p_project)
        AND p_work IN (l.first_id,l.second_id) AND l.consolidated_into <> p_work)
    THEN RETURN jsonb_build_object('result','consolidated'); END IF;
  END IF;
  RETURN kordos_planning.save_work_before_health(p_project,p_work,p_input);
END
$$;
REVOKE EXECUTE ON FUNCTION kordos_planning.save_work(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_planning.save_work(uuid,uuid,jsonb) TO kordos_app;

CREATE FUNCTION kordos_health.apply_consolidation(p_execution uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  e public.executions;
  p public.proposals;
  r public.proposal_revisions;
  archive_id uuid;
  requester_access public.project_role;
  saved jsonb;
  request jsonb;
  effect_id uuid;
BEGIN
  SELECT * INTO e FROM public.executions WHERE id = p_execution AND status = 'applying';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM set_config('kordos.workspace_id', e.workspace_id::text, true);
  PERFORM set_config('kordos.actor_id', e.reviewer_id::text, true);
  PERFORM kordos_planning.lock_workspace(e.write_mutation_id);
  PERFORM kordos_reviews.lock_projects(e.project_id,'[]');
  SELECT * INTO STRICT p FROM public.proposals WHERE id = e.proposal_id FOR UPDATE;
  SELECT * INTO STRICT e FROM public.executions WHERE id = p_execution FOR UPDATE;
  IF p.revision <> e.revision OR e.status <> 'applying' THEN RETURN false; END IF;
  SELECT * INTO STRICT r FROM public.proposal_revisions WHERE (workspace_id,project_id,proposal_id,revision)
    = (e.workspace_id,e.project_id,p.id,p.revision) AND command->>'kind' = 'work.consolidate';
  archive_id := (r.command->'archive'->>'id')::uuid;

  IF EXISTS (SELECT FROM public.outbox WHERE workspace_id = e.workspace_id
    AND actor_id = e.reviewer_id AND mutation_id = e.write_mutation_id) THEN
    PERFORM kordos_reviews.finish(e,p,'reconciliation_required','ambiguous_effect');
    RETURN false;
  END IF;
  IF r.expires_at <= clock_timestamp() THEN
    PERFORM kordos_reviews.finish(e,p,'expired','expired');
    RETURN false;
  END IF;
  PERFORM set_config('kordos.actor_id', p.requester_id::text, true);
  requester_access := kordos_planning.project_access(p.project_id);
  PERFORM set_config('kordos.actor_id', e.reviewer_id::text, true);
  IF requester_access IS NULL OR requester_access = 'viewer'
    OR kordos_planning.project_access(p.project_id) IS DISTINCT FROM 'lead'
    OR kordos_reviews.authority(p.requester_id,p.project_id,'[]')->'target' IS DISTINCT FROM e.authority->'requester'->'target'
    OR kordos_reviews.authority(e.reviewer_id,p.project_id,'[]')->'target' IS DISTINCT FROM e.authority->'reviewer'->'target' THEN
    PERFORM kordos_reviews.finish(e,p,'stale','access_changed');
    RETURN false;
  END IF;
  IF NOT kordos_health.consolidation_current(p,r) THEN
    PERFORM kordos_reviews.finish(e,p,'stale','target_changed');
    RETURN false;
  END IF;
  IF kordos_health.would_cycle(p.workspace_id,p.project_id,p.work_id,archive_id) THEN
    PERFORM kordos_reviews.finish(e,p,'failed','invalid_change');
    RETURN false;
  END IF;

  saved := kordos_planning.save_work(p.project_id,archive_id,jsonb_build_object(
    'action','archive','expectedVersion',r.command->'archive'->'version','mutationId',gen_random_uuid()));
  IF saved->>'result' IS DISTINCT FROM 'saved' THEN
    PERFORM kordos_reviews.finish(e,p,'failed','invalid_change');
    RETURN false;
  END IF;

  INSERT INTO public.dependency_edges (workspace_id,project_id,predecessor_id,successor_id)
    SELECT p.workspace_id,p.project_id,(d->>'predecessorId')::uuid,(d->>'successorId')::uuid
    FROM jsonb_array_elements(r.command->'dependencies') d;
  UPDATE public.projects SET graph_version = graph_version + 1 WHERE (workspace_id,id) = (p.workspace_id,p.project_id);
  INSERT INTO public.work_relations (workspace_id,project_id,first_id,second_id,consolidated_into)
    VALUES (p.workspace_id,p.project_id,least(p.work_id,archive_id),greatest(p.work_id,archive_id),p.work_id)
    ON CONFLICT ON CONSTRAINT work_relations_workspace_id_project_id_first_id_second_id_pk
      DO UPDATE SET consolidated_into = excluded.consolidated_into;
  request := jsonb_build_object('mutationId',e.write_mutation_id);
  PERFORM kordos_planning.emit(p.project_id,p.work_id,'duplicate.consolidated',request,NULL,
    jsonb_build_object('workId',p.work_id,'archivedWorkId',archive_id,'graphVersion',(r.command->>'graphVersion')::int + 1));
  SELECT id INTO STRICT effect_id FROM public.outbox WHERE workspace_id = p.workspace_id
    AND actor_id = e.reviewer_id AND mutation_id = e.write_mutation_id;
  PERFORM kordos_reviews.finish(e,p,'applied',NULL,effect_id);
  RETURN true;
END
$$;

ALTER FUNCTION kordos_reviews.run(uuid,text) RENAME TO run_before_health;
REVOKE EXECUTE ON FUNCTION kordos_reviews.run_before_health(uuid,text) FROM kordos_app;
CREATE FUNCTION kordos_reviews.run(p_execution uuid,p_step text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p_step = 'apply' AND EXISTS (
    SELECT FROM public.executions e JOIN public.proposal_revisions r
      ON (r.workspace_id,r.project_id,r.proposal_id,r.revision) = (e.workspace_id,e.project_id,e.proposal_id,e.revision)
    WHERE e.id = p_execution AND r.command->>'kind' = 'work.consolidate'
  ) THEN kordos_health.apply_consolidation(p_execution)
    ELSE kordos_reviews.run_before_health(p_execution,p_step) END
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.run(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.run(uuid,text) TO kordos_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_health FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_health.reports(uuid,date), kordos_health.duplicates(uuid,uuid),
  kordos_health.pair_action(uuid,uuid,jsonb) TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_health.next_project(), kordos_health.save_report(uuid,jsonb) TO kordos_brief_worker;
