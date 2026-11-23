CREATE TABLE "risk_comment_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "risk_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"source_at" timestamp with time zone NOT NULL,
	"input_revision" text NOT NULL,
	"as_of" date NOT NULL,
	"calendar" jsonb NOT NULL,
	"assessment" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"previous_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_findings_scope_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "risk_findings_successor_unique" UNIQUE("previous_id"),
	CONSTRAINT "risk_findings_status" CHECK ("risk_findings"."status" IN ('open', 'acknowledged', 'resolved', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "risk_replans" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_comment_jobs" ADD CONSTRAINT "risk_comment_jobs_id_outbox_id_fk" FOREIGN KEY ("id") REFERENCES "public"."outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_project_id_unique" UNIQUE("workspace_id","project_id","id");
--> statement-breakpoint
ALTER TABLE "risk_findings" ADD CONSTRAINT "risk_findings_comment_fk" FOREIGN KEY ("workspace_id","project_id","comment_id") REFERENCES "public"."comments"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_findings" ADD CONSTRAINT "risk_findings_previous_fk" FOREIGN KEY ("workspace_id","project_id","previous_id") REFERENCES "public"."risk_findings"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_replans" ADD CONSTRAINT "risk_replans_proposal_fk" FOREIGN KEY ("workspace_id","project_id","proposal_id") REFERENCES "public"."proposals"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_replans" ADD CONSTRAINT "risk_replans_finding_fk" FOREIGN KEY ("workspace_id","project_id","finding_id") REFERENCES "public"."risk_findings"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_comment_jobs_pending_idx" ON "risk_comment_jobs" USING btree ("created_at","id") WHERE "risk_comment_jobs"."processed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_findings_current_comment_idx" ON "risk_findings" USING btree ("workspace_id","project_id","comment_id") WHERE "risk_findings"."status" <> 'superseded';--> statement-breakpoint
CREATE INDEX "risk_findings_project_date_idx" ON "risk_findings" USING btree ("workspace_id","project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "risk_replans_finding_idx" ON "risk_replans" USING btree ("workspace_id","project_id","finding_id");--> statement-breakpoint

CREATE SCHEMA kordos_risks;
REVOKE ALL ON SCHEMA kordos_risks FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_risks TO kordos_app;
ALTER TABLE public.risk_comment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_replans ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION kordos_planning.schedule_fingerprint(p_project uuid, p_version int, p_graph int, p_work jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(p_project, p_version, p_graph, p_work)::text, 'UTF8')), 'hex')
$$;
REVOKE EXECUTE ON FUNCTION kordos_planning.schedule_fingerprint(uuid, int, int, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_planning.schedule_fingerprint(uuid, int, int, jsonb) TO kordos_app;

CREATE FUNCTION kordos_risks.fingerprint(p_workspace uuid, p_project uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT kordos_planning.schedule_fingerprint(p.id, p.version, p.graph_version, (
    SELECT jsonb_agg(jsonb_build_array(w.id, w.version) ORDER BY w.id) FROM public.work_items w
    WHERE (w.workspace_id, w.project_id) = (p.workspace_id, p.id) AND w.archived_at IS NULL
  ))
  FROM public.projects p WHERE (p.workspace_id, p.id) = (p_workspace, p_project) AND p.archived_at IS NULL
$$;

CREATE FUNCTION kordos_risks.enqueue_comment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.risk_comment_jobs(id, created_at) VALUES (NEW.id, NEW.created_at);
  RETURN NEW;
END
$$;
CREATE TRIGGER risk_enqueue_comment AFTER INSERT ON public.outbox
FOR EACH ROW WHEN (NEW.kind IN ('comment.posted', 'comment.edited')
  AND NEW.request->'subject'->>'kind' IN ('task', 'project'))
EXECUTE FUNCTION kordos_risks.enqueue_comment();

-- Evaluate the current text of comments that already exist on upgrade.
INSERT INTO public.risk_comment_jobs(id, created_at)
SELECT DISTINCT ON (o.workspace_id, o.project_id, o.target_id) o.id, o.created_at
FROM public.outbox o WHERE o.kind IN ('comment.posted', 'comment.edited')
  AND o.request->'subject'->>'kind' IN ('task', 'project')
ORDER BY o.workspace_id, o.project_id, o.target_id, o.created_at DESC, o.id DESC;

CREATE FUNCTION kordos_risks.pending() RETURNS TABLE(id uuid, actor uuid, workspace uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT j.id, o.actor_id, o.workspace_id FROM public.risk_comment_jobs j JOIN public.outbox o USING (id)
  WHERE j.processed_at IS NULL ORDER BY j.created_at, j.id LIMIT 50
$$;

CREATE FUNCTION kordos_risks.comment_at(c public.comments) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(c.edited_at, c.created_at)
$$;

CREATE FUNCTION kordos_risks.comment_source(c public.comments, p_version int) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('projectId', c.project_id, 'commentId', c.id, 'sourceVersion', p_version,
    'capturedAt', kordos_risks.comment_at(c), 'body', c.body,
    'subject', jsonb_build_object('kind', c.subject_kind, 'id', c.subject_id))
$$;

CREATE FUNCTION kordos_risks.lock_job(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  o public.outbox;
  c public.comments;
  recorded public.audit_events;
BEGIN
  SELECT * INTO o FROM public.outbox WHERE id = p_id AND
    (workspace_id, actor_id) = (kordos_identity.workspace_id(), kordos_identity.actor_id());
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM kordos_planning.lock_workspace(p_id);
  PERFORM kordos_reviews.lock_projects(o.project_id, '[]');
  PERFORM 1 FROM public.risk_comment_jobs WHERE id = p_id AND processed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO recorded FROM public.audit_events WHERE id = p_id;
  SELECT * INTO c FROM public.comments
    WHERE (workspace_id, project_id, id) = (o.workspace_id, o.project_id, o.target_id);
  IF NOT FOUND OR kordos_risks.comment_at(c) IS DISTINCT FROM
    coalesce((recorded.details->'after'->>'edited_at')::timestamptz, (recorded.details->'after'->>'created_at')::timestamptz)
    OR kordos_collaboration.subject_open(c.project_id, c.subject_kind, c.subject_id) IS DISTINCT FROM true
    OR NOT coalesce(kordos_planning.project_access(c.project_id) IN ('contributor','lead'), false) THEN
    UPDATE public.risk_comment_jobs SET processed_at = clock_timestamp() WHERE id = p_id;
    RETURN NULL;
  END IF;
  RETURN kordos_risks.comment_source(c, (recorded.details->'after'->>'version')::int);
END
$$;

CREATE FUNCTION kordos_risks.replace_finding(c public.comments, p_version int, snapshot jsonb, assessment jsonb, automated boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  prior public.risk_findings;
  previous_severity text;
  next_severity text := assessment->>'severity';
  finding_id uuid;
BEGIN
  IF assessment IS NOT NULL AND (position(assessment->>'excerpt' IN c.body) < 1
    OR length(assessment->>'excerpt') NOT BETWEEN 1 AND 1000
    OR snapshot->>'inputRevision' IS DISTINCT FROM kordos_risks.fingerprint(c.workspace_id, c.project_id)) THEN
    RAISE EXCEPTION 'Invalid risk assessment' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO prior FROM public.risk_findings
    WHERE (workspace_id, project_id, comment_id) = (c.workspace_id,c.project_id,c.id)
    ORDER BY created_at DESC, id DESC LIMIT 1;

  IF prior.status <> 'superseded' THEN
    previous_severity := prior.assessment->>'severity';
    UPDATE public.risk_findings SET status = 'superseded', version = version + 1 WHERE id = prior.id;
  END IF;
  IF assessment IS NOT NULL THEN
    INSERT INTO public.risk_findings (workspace_id, project_id, comment_id, source_version, source_at,
      input_revision, as_of, calendar, assessment, previous_id)
    VALUES (c.workspace_id,c.project_id,c.id,p_version,kordos_risks.comment_at(c),
      snapshot->>'inputRevision',(snapshot->>'asOf')::date,snapshot->'calendar',assessment,prior.id)
    RETURNING id INTO finding_id;
  END IF;

  IF prior.id IS NOT NULL OR finding_id IS NOT NULL THEN
    PERFORM kordos_planning.emit(c.project_id, coalesce(finding_id, prior.id),
      CASE WHEN previous_severity IS DISTINCT FROM next_severity THEN 'risk.severity_changed' ELSE 'risk.assessed' END,
      jsonb_build_object('mutationId', gen_random_uuid()), jsonb_build_object('severity', previous_severity),
      jsonb_build_object('severity', next_severity, 'sourceVersion', p_version, 'commentId', c.id, 'executor', automated));
  END IF;
  RETURN finding_id;
END
$$;

CREATE FUNCTION kordos_risks.finish_job(p_id uuid, p_snapshot jsonb, p_assessment jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  source jsonb;
  c public.comments;
BEGIN
  source := kordos_risks.lock_job(p_id);
  IF source IS NULL THEN RETURN; END IF;
  SELECT * INTO STRICT c FROM public.comments WHERE id = (source->>'commentId')::uuid;
  PERFORM kordos_risks.replace_finding(c, (source->>'sourceVersion')::int, p_snapshot, p_assessment, true);
  UPDATE public.risk_comment_jobs SET processed_at = clock_timestamp() WHERE id = p_id;
END
$$;

CREATE FUNCTION kordos_risks.summary(f public.risk_findings, c public.comments) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', f.id, 'version', f.version,
    'status', CASE WHEN kordos_risks.comment_at(c) IS DISTINCT FROM f.source_at THEN 'superseded' ELSE f.status END,
    'severity', f.assessment->>'severity', 'title', coalesce(f.assessment->'task'->>'title', 'Unconfirmed delay report'),
    'capturedAt', f.source_at, 'author', kordos_collaboration.person(c.author_id),
    'superseded', f.status = 'superseded' OR kordos_risks.comment_at(c) IS DISTINCT FROM f.source_at)
$$;

CREATE FUNCTION kordos_risks.directory(p_project uuid, p_cursor uuid, p_history boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH visible AS (
    SELECT f.id, f.created_at, kordos_risks.summary(f, c) AS entry,
      CASE WHEN p_history THEN 0 ELSE CASE f.assessment->>'severity'
        WHEN 'at_risk' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END END AS rank
    FROM public.risk_findings f JOIN public.comments c ON (c.workspace_id,c.project_id,c.id) = (f.workspace_id,f.project_id,f.comment_id)
    WHERE (f.workspace_id,f.project_id) = (kordos_identity.workspace_id(),p_project)
      AND kordos_collaboration.subject_open(p_project,c.subject_kind,c.subject_id) IS NOT NULL
      AND (p_history OR (f.status IN ('open','acknowledged') AND kordos_risks.comment_at(c) = f.source_at
        AND f.assessment->>'severity' <> 'unchanged'))
  ), page AS (
    SELECT * FROM visible v WHERE p_cursor IS NULL OR
      (v.rank,-extract(epoch FROM v.created_at),v.id) >
        (SELECT prior.rank,-extract(epoch FROM prior.created_at),prior.id FROM visible prior WHERE prior.id = p_cursor)
    ORDER BY v.rank,v.created_at DESC,v.id LIMIT 21
  )
  SELECT jsonb_build_object('items', coalesce((SELECT jsonb_agg(entry ORDER BY rank,created_at DESC,id)
    FROM (SELECT * FROM page ORDER BY rank,created_at DESC,id LIMIT 20) limited), '[]'),
    'nextCursor', CASE WHEN (SELECT count(*) FROM page) > 20
      THEN (SELECT id FROM page ORDER BY rank,created_at DESC,id OFFSET 19 LIMIT 1) END)
  WHERE kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE FUNCTION kordos_risks.detail(p_project uuid, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT summary || jsonb_build_object('assessment', f.assessment, 'calendar', f.calendar,
    'inputRevision', f.input_revision, 'asOf', f.as_of, 'previousId', f.previous_id,
    'nextId', (SELECT id FROM public.risk_findings WHERE previous_id = f.id),
    'source', jsonb_build_object('id', c.id,'version',f.source_version,
      'subject',jsonb_build_object('kind',c.subject_kind,'id',c.subject_id)),
    'sourceChanged', kordos_risks.comment_at(c) IS DISTINCT FROM f.source_at,
    'review', (SELECT jsonb_build_object('actor', kordos_collaboration.person(a.actor_id),
        'occurredAt', a.created_at, 'reason', a.details->'after'->>'reason')
      FROM public.audit_events a WHERE (a.workspace_id,a.project_id,a.target_id) = (f.workspace_id,f.project_id,f.id)
        AND a.action IN ('risk.acknowledged','risk.resolved') ORDER BY a.created_at DESC,a.id DESC LIMIT 1),
    'staleSchedule', f.input_revision IS DISTINCT FROM kordos_risks.fingerprint(f.workspace_id,f.project_id),
    'proposalId', (SELECT p.id FROM public.risk_replans rp JOIN public.proposals p ON p.id = rp.proposal_id
      WHERE rp.finding_id = f.id AND kordos_reviews.can_read(p) ORDER BY p.created_at DESC,p.id LIMIT 1),
    'canClarify', writable AND c.author_id = kordos_identity.actor_id() AND coalesce((f.assessment->>'handoff')::date >= f.as_of, false)
      AND f.assessment->>'severity' = 'clarify' AND f.assessment->>'task' IS NULL
      AND kordos_planning.project_access(p_project) IN ('lead','contributor'),
    'canReview', writable AND kordos_planning.project_access(p_project) = 'lead')
  FROM public.risk_findings f
  JOIN public.comments c ON (c.workspace_id,c.project_id,c.id) = (f.workspace_id,f.project_id,f.comment_id)
  CROSS JOIN LATERAL (SELECT kordos_risks.summary(f,c) AS summary,
    f.status IN ('open','acknowledged') AND kordos_risks.comment_at(c) = f.source_at
    AND kordos_collaboration.subject_open(p_project,c.subject_kind,c.subject_id) AS writable) a
  WHERE (f.workspace_id,f.project_id,f.id) = (kordos_identity.workspace_id(),p_project,p_id)
    AND kordos_planning.project_access(p_project) IS NOT NULL
    AND kordos_collaboration.subject_open(p_project,c.subject_kind,c.subject_id) IS NOT NULL
$$;

CREATE FUNCTION kordos_risks.request(p_input jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('mutationId', p_input->'mutationId', '_command', 'risk.' || (p_input->>'action'),
    'hash', encode(sha256(convert_to(p_input::text, 'UTF8')), 'hex'))
$$;

CREATE FUNCTION kordos_risks.lock_finding(p_project uuid, p_id uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  action text := p_input->>'action';
  f public.risk_findings;
  c public.comments;
  access public.project_role;
  existing public.outbox;
BEGIN
  IF action NOT IN ('clarify','refresh','acknowledge','resolve','replan') THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
  IF NOT kordos_planning.lock_schedule(p_project, mutation) THEN RETURN jsonb_build_object('result','unavailable'); END IF;
  access := kordos_planning.project_access(p_project);
  SELECT * INTO f FROM public.risk_findings WHERE (workspace_id,project_id,id) = (tenant,p_project,p_id) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','unavailable'); END IF;
  SELECT * INTO STRICT c FROM public.comments WHERE (workspace_id,project_id,id) = (tenant,p_project,f.comment_id);
  IF kordos_collaboration.subject_open(p_project,c.subject_kind,c.subject_id) IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('result','unavailable');
  END IF;
  IF (action = 'clarify' AND actor <> c.author_id) OR (action <> 'clarify' AND access <> 'lead') THEN
    RETURN jsonb_build_object('result','forbidden');
  END IF;

  SELECT * INTO existing FROM public.outbox WHERE (workspace_id,actor_id,mutation_id) = (tenant,actor,mutation);
  IF FOUND THEN
    IF existing.project_id IS DISTINCT FROM p_project OR existing.target_id IS DISTINCT FROM p_id
      OR existing.request IS DISTINCT FROM kordos_risks.request(p_input) THEN
      RETURN jsonb_build_object('result','mutation_conflict');
    END IF;
    RETURN (SELECT details->'after'->'response' FROM public.audit_events WHERE id = existing.id)
      || jsonb_build_object('result','saved');
  END IF;

  IF f.version IS DISTINCT FROM (p_input->>'expectedVersion')::int
    OR f.status = 'superseded' OR f.source_at IS DISTINCT FROM kordos_risks.comment_at(c) THEN
    RETURN jsonb_build_object('result','stale');
  END IF;
  IF f.status = 'resolved' OR (action = 'acknowledge' AND f.status <> 'open') THEN
    RETURN jsonb_build_object('result','invalid_state');
  END IF;
  IF action = 'clarify' AND (f.assessment->>'severity' <> 'clarify' OR f.assessment->>'task' IS NOT NULL
    OR NOT coalesce((f.assessment->>'handoff')::date >= f.as_of, false)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.assessment->'candidates') candidate WHERE candidate->>'id' = p_input->>'taskId')) THEN
    RETURN jsonb_build_object('result','invalid_state');
  END IF;
  RETURN jsonb_build_object('result','ready','source',kordos_risks.comment_source(c,f.source_version),
    'priorTaskId', CASE WHEN (f.assessment->>'taskClarified')::boolean THEN f.assessment->'task'->>'id' END);
END
$$;

CREATE FUNCTION kordos_risks.current_finding(f public.risk_findings) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(f.status IN ('open','acknowledged') AND EXISTS (
    SELECT 1 FROM public.comments c WHERE (c.workspace_id,c.project_id,c.id) = (f.workspace_id,f.project_id,f.comment_id)
      AND kordos_risks.comment_at(c) = f.source_at
  ) AND f.input_revision = kordos_risks.fingerprint(f.workspace_id,f.project_id), false)
$$;

CREATE FUNCTION kordos_risks.change_finding(p_project uuid, p_id uuid, p_input jsonb, p_snapshot jsonb, p_assessment jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  action text := p_input->>'action';
  checked jsonb;
  f public.risk_findings;
  c public.comments;
  w public.work_items;
  saved jsonb;
  response jsonb;
  changed_id uuid;
  proposal_id uuid;
BEGIN
  checked := kordos_risks.lock_finding(p_project,p_id,p_input);
  IF checked->>'result' IS DISTINCT FROM 'ready' THEN RETURN checked; END IF;
  SELECT * INTO STRICT f FROM public.risk_findings WHERE id = p_id;
  SELECT * INTO STRICT c FROM public.comments WHERE id = f.comment_id;
  response := jsonb_build_object('id',p_id);
  IF action IN ('clarify','refresh') THEN
    IF p_assessment IS NULL OR (action = 'clarify' AND
      p_assessment->'task'->>'id' IS DISTINCT FROM p_input->>'taskId') THEN
      RETURN jsonb_build_object('result','invalid_state');
    END IF;
    changed_id := kordos_risks.replace_finding(c,f.source_version,p_snapshot,p_assessment);
    response := jsonb_build_object('id',changed_id);
  ELSIF action = 'replan' THEN
    IF NOT kordos_risks.current_finding(f) THEN RETURN jsonb_build_object('result','stale'); END IF;
    SELECT * INTO w FROM public.work_items WHERE (workspace_id,project_id,id) = (tenant,p_project,(p_input->>'milestoneId')::uuid)
      AND kind = 'milestone' AND status <> 'done' AND archived_at IS NULL;
    IF NOT FOUND OR w.commitment IS NOT DISTINCT FROM (p_input->>'commitment')::date OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(f.assessment->'milestones') milestone WHERE (milestone->>'id')::uuid = w.id
    ) THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
    IF EXISTS (SELECT 1 FROM public.risk_replans rp JOIN public.proposals p ON p.id = rp.proposal_id
      JOIN public.proposal_revisions r ON (r.workspace_id,r.project_id,r.proposal_id,r.revision)
        = (p.workspace_id,p.project_id,p.id,p.revision)
      WHERE rp.finding_id = f.id AND p.work_id = w.id AND p.status IN ('pending','approved','applying')
        AND r.expires_at > clock_timestamp()) THEN
      RETURN jsonb_build_object('result','invalid_state');
    END IF;
    BEGIN
      saved := kordos_reviews.mutate(p_project,NULL,'create',jsonb_build_object(
        'mutationId',gen_random_uuid(),'workId',w.id,'targetVersion',w.version,
        'command',jsonb_build_object('kind','work.edit','values',
          kordos_planning.work_snapshot(w) || jsonb_build_object('commitment',p_input->>'commitment')),
        'evidence',jsonb_build_array(jsonb_build_object('kind','comment','projectId',p_project,'id',c.id))));
      IF saved->>'result' IS DISTINCT FROM 'saved' THEN RAISE SQLSTATE 'KRP01'; END IF;
      proposal_id := (saved->>'id')::uuid;
      saved := kordos_reviews.mutate(NULL,proposal_id,'submit',jsonb_build_object(
        'mutationId',gen_random_uuid(),'expectedVersion',1,'revision',1));
      IF saved->>'result' IS DISTINCT FROM 'saved' THEN RAISE SQLSTATE 'KRP01'; END IF;
      INSERT INTO public.risk_replans (proposal_id,workspace_id,project_id,finding_id)
        VALUES (proposal_id,tenant,p_project,f.id);
    EXCEPTION WHEN SQLSTATE 'KRP01' THEN
      RETURN jsonb_build_object('result',saved->>'result');
    END;
    response := response || jsonb_build_object('proposalId',proposal_id);
  ELSE
    UPDATE public.risk_findings SET status = CASE action WHEN 'acknowledge' THEN 'acknowledged' ELSE 'resolved' END,
      version = version + 1 WHERE id = f.id;
  END IF;
  PERFORM kordos_planning.emit(p_project,p_id,
    CASE action WHEN 'acknowledge' THEN 'risk.acknowledged' WHEN 'resolve' THEN 'risk.resolved'
      WHEN 'replan' THEN 'risk.replan_submitted' WHEN 'clarify' THEN 'risk.clarified' ELSE 'risk.refreshed' END,
    kordos_risks.request(p_input),jsonb_build_object('status',f.status),
    jsonb_build_object('response',response,'reason',p_input->>'reason'));
  RETURN response || jsonb_build_object('result','saved');
END
$$;

-- A replan remains a normal work-edit proposal. Its finding binds the evidence
-- and full scheduling inputs before the review transitions and worker apply.
ALTER FUNCTION kordos_reviews.mutate(uuid,uuid,text,jsonb) RENAME TO mutate_before_risks;
REVOKE EXECUTE ON FUNCTION kordos_reviews.mutate_before_risks(uuid,uuid,text,jsonb) FROM kordos_app;
CREATE FUNCTION kordos_reviews.mutate(p_project uuid, p_id uuid, p_action text, p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  binding public.risk_replans;
  finding public.risk_findings;
BEGIN
  SELECT * INTO binding FROM public.risk_replans WHERE workspace_id = tenant AND proposal_id = p_id;
  IF FOUND AND p_action IN ('approve','revise','submit') AND
    kordos_planning.project_access(binding.project_id) = 'lead' THEN
    PERFORM kordos_planning.lock_workspace((p_input->>'mutationId')::uuid);
    PERFORM kordos_reviews.lock_projects(binding.project_id,'[]');
    IF kordos_planning.project_access(binding.project_id) = 'lead' THEN
      SELECT * INTO STRICT finding FROM public.risk_findings WHERE id = binding.finding_id;
      IF p_action = 'revise' OR (NOT kordos_risks.current_finding(finding) AND NOT (
        p_action = 'approve' AND EXISTS (SELECT 1 FROM public.executions WHERE proposal_id = p_id AND revision = (p_input->>'revision')::int)
      )) THEN RETURN jsonb_build_object('result','risk_stale'); END IF;
    END IF;
  ELSIF FOUND AND p_action IN ('revise','submit') AND kordos_planning.project_access(binding.project_id) = 'contributor' THEN
    RETURN jsonb_build_object('result','forbidden');
  END IF;
  RETURN kordos_reviews.mutate_before_risks(p_project,p_id,p_action,p_input);
END
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.mutate(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.mutate(uuid,uuid,text,jsonb) TO kordos_app;

ALTER FUNCTION kordos_reviews.run(uuid,text) RENAME TO run_before_risks;
REVOKE EXECUTE ON FUNCTION kordos_reviews.run_before_risks(uuid,text) FROM kordos_app;
CREATE FUNCTION kordos_reviews.run(p_execution uuid, p_step text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  e public.executions;
  p public.proposals;
  f public.risk_findings;
BEGIN
  IF p_step = 'apply' THEN
    SELECT execution.* INTO e FROM public.executions execution JOIN public.risk_replans rp ON rp.proposal_id = execution.proposal_id
      WHERE execution.id = p_execution AND execution.status = 'applying';
    IF FOUND THEN
      PERFORM set_config('kordos.workspace_id',e.workspace_id::text,true);
      PERFORM set_config('kordos.actor_id',e.reviewer_id::text,true);
      PERFORM kordos_planning.lock_workspace(e.write_mutation_id);
      PERFORM kordos_reviews.lock_projects(e.project_id,'[]');
      SELECT * INTO STRICT p FROM public.proposals WHERE id = e.proposal_id FOR UPDATE;
      SELECT * INTO STRICT e FROM public.executions WHERE id = p_execution FOR UPDATE;
      IF p.revision <> e.revision OR e.status <> 'applying' THEN RETURN false; END IF;
      SELECT finding.* INTO STRICT f FROM public.risk_findings finding JOIN public.risk_replans rp ON rp.finding_id = finding.id
        WHERE rp.proposal_id = p.id;
      IF NOT kordos_risks.current_finding(f) AND NOT EXISTS (SELECT 1 FROM public.outbox
        WHERE workspace_id = e.workspace_id AND actor_id = e.reviewer_id AND mutation_id = e.write_mutation_id) THEN
        PERFORM kordos_reviews.finish(e,p,'stale','risk_stale');
        RETURN false;
      END IF;
    END IF;
  END IF;
  RETURN kordos_reviews.run_before_risks(p_execution,p_step);
END
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.run(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.run(uuid,text) TO kordos_app;

CREATE OR REPLACE FUNCTION kordos_reviews.effective_status(p public.proposals, r public.proposal_revisions)
RETURNS public.proposal_status LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p.status IN ('draft','pending') AND r.expires_at <= statement_timestamp() THEN 'expired'::public.proposal_status
    WHEN p.status IN ('draft','pending','approved','applying') AND EXISTS (
      SELECT 1 FROM public.risk_replans binding JOIN public.risk_findings f ON f.id = binding.finding_id
      JOIN public.comments c ON (c.workspace_id,c.project_id,c.id) = (f.workspace_id,f.project_id,f.comment_id)
      WHERE binding.proposal_id = p.id AND (NOT kordos_risks.current_finding(f)
        OR (r.evidence->0->>'version')::int IS DISTINCT FROM c.version)
    ) THEN 'stale'::public.proposal_status
    ELSE p.status END
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
      AND (NOT p_pending OR (p.status = 'pending' AND kordos_reviews.effective_status(p,r) = 'pending'))
      AND (p_before IS NULL OR (p.created_at, p.id) < (SELECT created_at, id FROM cursor_row))
    ORDER BY p.created_at DESC, p.id DESC LIMIT 41
  ), page AS (
    SELECT * FROM entries ORDER BY created_at DESC, id DESC LIMIT 40
  )
  SELECT jsonb_build_object('items', coalesce((SELECT jsonb_agg(value ORDER BY created_at DESC, id DESC) FROM page), '[]'),
    'pendingCount', (SELECT count(*) FROM public.proposals p JOIN public.proposal_revisions r
      ON (r.workspace_id, r.project_id, r.proposal_id, r.revision) = (p.workspace_id, p.project_id, p.id, p.revision)
      WHERE p.workspace_id = kordos_identity.workspace_id() AND p.status = 'pending'
        AND kordos_reviews.effective_status(p,r) = 'pending' AND kordos_reviews.can_read(p)),
    'nextCursor', CASE WHEN (SELECT count(*) FROM entries) > 40 THEN
      (SELECT id FROM page ORDER BY created_at, id LIMIT 1) END)
  WHERE kordos_identity.current_role() IS NOT NULL
$$;

ALTER FUNCTION kordos_reviews.detail(uuid,int) RENAME TO detail_before_risks;
REVOKE EXECUTE ON FUNCTION kordos_reviews.detail_before_risks(uuid,int) FROM kordos_app;
CREATE FUNCTION kordos_reviews.detail(p_id uuid, p_revision int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  value jsonb := kordos_reviews.detail_before_risks(p_id,p_revision);
  f public.risk_findings;
  stale boolean;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  SELECT finding.* INTO f FROM public.risk_replans rp JOIN public.risk_findings finding ON finding.id = rp.finding_id
    WHERE rp.proposal_id = p_id AND rp.workspace_id = kordos_identity.workspace_id();
  IF NOT FOUND THEN RETURN value; END IF;
  stale := value->>'status' = 'stale' OR (value->>'status' IN ('draft','pending','approved','applying')
    AND NOT kordos_risks.current_finding(f));
  RETURN value || jsonb_build_object('canEdit',false,'canSubmit',false,
    'canReview', CASE WHEN stale THEN false ELSE (value->>'canReview')::boolean END,
    'status', CASE WHEN stale THEN 'stale' ELSE value->>'status' END,
    'riskContext',jsonb_build_object('id',f.id,'stale',stale));
END
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.detail(uuid,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.detail(uuid,int) TO kordos_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_risks FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_risks.pending(), kordos_risks.lock_job(uuid), kordos_risks.finish_job(uuid,jsonb,jsonb),
  kordos_risks.directory(uuid,uuid,boolean), kordos_risks.detail(uuid,uuid),
  kordos_risks.lock_finding(uuid,uuid,jsonb), kordos_risks.change_finding(uuid,uuid,jsonb,jsonb,jsonb) TO kordos_app;

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
      'actorType', CASE WHEN e.id IS NOT NULL OR (CASE WHEN a.action LIKE 'brief.%' OR a.action LIKE 'risk.%' THEN a.details->'after' ELSE meta END)->>'executor' = 'true' THEN 'service' ELSE 'user' END,
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
