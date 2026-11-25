-- Store operational evidence as metadata-only audit events in the same
-- transaction as the outcome. Keep diagnostics out of workspace activity.
CREATE POLICY audit_operations_read ON public.audit_events AS RESTRICTIVE
FOR SELECT TO kordos_app USING (action NOT LIKE 'ops.%');

CREATE FUNCTION kordos_risks.record_run(
  p_job uuid, p_outcome text, p_revision text, p_finding uuid
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  source public.audit_events;
BEGIN
  SELECT * INTO source FROM public.audit_events
  WHERE id = p_job AND (workspace_id,actor_id) =
    (kordos_identity.workspace_id(),kordos_identity.actor_id());
  IF NOT FOUND THEN RETURN; END IF;

  IF p_outcome <> 'failed' THEN
    UPDATE public.risk_comment_jobs SET processed_at = clock_timestamp()
    WHERE id = p_job AND processed_at IS NULL;
  ELSE
    PERFORM 1 FROM public.risk_comment_jobs WHERE id = p_job AND processed_at IS NULL FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.audit_events (workspace_id,project_id,actor_id,target_id,action,details)
  VALUES (source.workspace_id,source.project_id,source.actor_id,p_job,'ops.risk_evaluated',
    jsonb_build_object('after',jsonb_build_object(
      'sourceEventId',source.id,'sourceId',source.target_id,'sourceVersion',source.details->'after'->'version',
      'inputRevision',p_revision,'findingId',p_finding,'outcome',p_outcome,'executor',true)));
END
$$;
REVOKE ALL ON FUNCTION kordos_risks.record_run(uuid,text,text,uuid) FROM PUBLIC;

CREATE FUNCTION kordos_risks.fail_job(p_job uuid, p_revision text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_risks.record_run(p_job, 'failed', p_revision, NULL)
$$;
REVOKE ALL ON FUNCTION kordos_risks.fail_job(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_risks.fail_job(uuid,text) TO kordos_app;

CREATE FUNCTION kordos_health.record_run(p_project uuid, p_outcome text, p_snapshot jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  INSERT INTO public.audit_events (workspace_id,project_id,actor_id,target_id,action,details)
  SELECT p.workspace_id,p.id,kordos_identity.actor_id(),p.id,'ops.weekly_report',
    jsonb_build_object('after',jsonb_build_object(
      'period',date_trunc('week',transaction_timestamp() AT TIME ZONE p.time_zone)::date,
      'capturedAt',transaction_timestamp(),'inputRevision',p_snapshot->>'inputRevision',
      'graphVersion',p_snapshot->'graphVersion','outcome',p_outcome,'executor',true))
  FROM public.projects p
  JOIN public.memberships m ON (m.workspace_id,m.user_id) = (p.workspace_id,kordos_identity.actor_id())
  WHERE (p.workspace_id,p.id) = (kordos_identity.workspace_id(),p_project)
    AND p_outcome IN ('saved','skipped','unchanged','failed')
$$;
REVOKE ALL ON FUNCTION kordos_health.record_run(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_health.record_run(uuid,text,jsonb) TO kordos_brief_worker;

CREATE OR REPLACE FUNCTION kordos_risks.lock_job(p_id uuid) RETURNS jsonb
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
    coalesce((recorded.details->'after'->>'edited_at')::timestamptz, (recorded.details->'after'->>'created_at')::timestamptz) THEN
    PERFORM kordos_risks.record_run(p_id, 'source_changed', NULL, NULL);
    RETURN NULL;
  END IF;
  IF kordos_collaboration.subject_open(c.project_id, c.subject_kind, c.subject_id) IS DISTINCT FROM true
    OR NOT coalesce(kordos_planning.project_access(c.project_id) IN ('contributor','lead'), false) THEN
    PERFORM kordos_risks.record_run(p_id, 'unavailable', NULL, NULL);
    RETURN NULL;
  END IF;
  RETURN kordos_risks.comment_source(c, (recorded.details->'after'->>'version')::int);
END
$$;

CREATE OR REPLACE FUNCTION kordos_risks.finish_job(p_id uuid, p_snapshot jsonb, p_assessment jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  source jsonb;
  c public.comments;
  finding uuid;
BEGIN
  source := kordos_risks.lock_job(p_id);
  IF source IS NULL THEN RETURN; END IF;
  SELECT * INTO STRICT c FROM public.comments WHERE id = (source->>'commentId')::uuid;
  finding := kordos_risks.replace_finding(c, (source->>'sourceVersion')::int, p_snapshot, p_assessment, true);
  PERFORM kordos_risks.record_run(p_id,
    CASE WHEN finding IS NULL THEN 'no_finding' ELSE 'finding_recorded' END,
    p_snapshot->>'inputRevision', finding);
END
$$;

CREATE OR REPLACE FUNCTION kordos_health.save_report(p_project uuid, p_snapshot jsonb) RETURNS void
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
  IF kordos_planning.project_access(p_project) IS DISTINCT FROM 'lead' THEN
    PERFORM kordos_health.record_run(p_project, 'skipped', p_snapshot);
    RETURN;
  END IF;
  SELECT time_zone, date_trunc('week', captured AT TIME ZONE time_zone)::date
  INTO local_zone, start_date FROM public.projects
  WHERE (workspace_id, id) = (tenant, p_project) AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND OR local_zone IS DISTINCT FROM p_snapshot->>'timeZone'
    OR (captured AT TIME ZONE local_zone)::date IS DISTINCT FROM (p_snapshot->>'asOf')::date THEN
    PERFORM kordos_health.record_run(p_project, 'skipped', p_snapshot);
    RETURN;
  END IF;

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
  PERFORM kordos_health.record_run(p_project, CASE WHEN FOUND THEN 'saved' ELSE 'unchanged' END, p_snapshot);
END
$$;

-- A replacement lease closes an interrupted attempt before recording the
-- next one. Other finish paths can close an attempt from outside the executor.
CREATE FUNCTION kordos_github.audit_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  evidence jsonb;
BEGIN
  IF NEW.github_attempts = OLD.github_attempts AND OLD.github_lease IS NULL THEN RETURN NULL; END IF;
  IF NEW.github_attempts = OLD.github_attempts AND NEW.github_lease IS NOT DISTINCT FROM OLD.github_lease
    AND (NEW.status IN ('approved','applying') OR NEW.status = OLD.status) THEN RETURN NULL; END IF;

  SELECT jsonb_build_object('sourceId',p.github_source_id,'sourceVersion',r.target_version,
    'revision',NEW.revision,'receiptId',NEW.id,'executor',true)
  INTO evidence FROM public.proposals p
  JOIN public.proposal_revisions r ON (r.workspace_id,r.project_id,r.proposal_id,r.revision) =
    (p.workspace_id,p.project_id,p.id,NEW.revision)
  WHERE (p.workspace_id,p.project_id,p.id) = (NEW.workspace_id,NEW.project_id,NEW.proposal_id)
    AND p.github_source_id IS NOT NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF OLD.github_lease IS NOT NULL AND OLD.status IN ('approved','applying') THEN
    INSERT INTO public.audit_events (workspace_id,project_id,actor_id,target_id,action,details)
    VALUES (NEW.workspace_id,NEW.project_id,NEW.reviewer_id,NEW.proposal_id,'ops.github_attempt_finished',
      jsonb_build_object('after',evidence || jsonb_build_object('attempt',OLD.github_attempts,
        'outcome',CASE WHEN NEW.status NOT IN ('approved','applying') THEN NEW.status::text
          WHEN NEW.github_attempts > OLD.github_attempts THEN 'interrupted' ELSE 'retry_scheduled' END,
        'outcomeAuditId',NEW.outcome_audit_id)));
  END IF;

  IF NEW.github_attempts > OLD.github_attempts THEN
    INSERT INTO public.audit_events (workspace_id,project_id,actor_id,target_id,action,details)
    VALUES (NEW.workspace_id,NEW.project_id,NEW.reviewer_id,NEW.proposal_id,'ops.github_attempt_started',
      jsonb_build_object('after',evidence || jsonb_build_object('attempt',NEW.github_attempts,'outcome','claimed')));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION kordos_github.audit_attempt() FROM PUBLIC;

CREATE TRIGGER github_audit_attempt AFTER UPDATE OF github_attempts,github_lease,status ON public.executions
FOR EACH ROW EXECUTE FUNCTION kordos_github.audit_attempt();

CREATE OR REPLACE FUNCTION kordos_reviews.activity_allowed(a public.audit_events) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT a.action NOT LIKE 'ops.%' AND CASE WHEN a.project_id IS NULL THEN kordos_identity.current_role() = 'admin'
    ELSE kordos_planning.project_access(a.project_id) IS NOT NULL END
    AND kordos_github.audit_allowed(a)
    AND CASE
      WHEN a.action LIKE 'proposal.%' OR a.action = 'duplicate.proposal_reused' THEN EXISTS (
        SELECT FROM public.proposals p
        WHERE (p.workspace_id,p.project_id,p.id) = (a.workspace_id,a.project_id,a.target_id)
          AND kordos_reviews.can_read(p)
      )
      WHEN a.action IN ('decision.draft','decision.edit') THEN
        kordos_planning.project_access(a.project_id) IN ('lead','contributor')
      WHEN a.action LIKE 'comment.%' THEN EXISTS (
        SELECT FROM public.comments c
        WHERE (c.workspace_id,c.project_id,c.id) = (a.workspace_id,a.project_id,a.target_id)
          AND kordos_collaboration.subject_open(c.project_id,c.subject_kind,c.subject_id) IS NOT NULL
      )
      WHEN a.action LIKE 'risk.%' THEN EXISTS (
        SELECT FROM public.risk_findings f
        JOIN public.comments c ON (c.workspace_id,c.project_id,c.id) = (f.workspace_id,f.project_id,f.comment_id)
        WHERE (f.workspace_id,f.project_id,f.id) = (a.workspace_id,a.project_id,a.target_id)
          AND kordos_collaboration.subject_open(c.project_id,c.subject_kind,c.subject_id) IS NOT NULL
      )
      ELSE true END
$$;

CREATE OR REPLACE FUNCTION kordos_retention.audit_facts(p_value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(p_value)='object' THEN coalesce((
    SELECT jsonb_object_agg(key,value) FROM jsonb_each(p_value)
    WHERE key IN ('mutationId','fingerprint','response','id','workId','workIds','proposalId','revision',
      'documentId','meetingId','decisionId','receiptId','mediaId','executor','version','transcriptRevision',
      'kind','status','archived','completedAt','graphVersion','outcome','audioDays','transcriptDays',
      'importedDays','logDays','sourceId','sourceVersion','sourceEventId','inputRevision',
      'findingId','period','capturedAt','attempt','outcomeAuditId')
  ),'{}'::jsonb) ELSE p_value END
$$;
