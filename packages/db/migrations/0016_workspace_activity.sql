CREATE INDEX "audit_events_project_activity_idx" ON "audit_events" USING btree ("workspace_id","project_id","created_at","id");
--> statement-breakpoint
CREATE FUNCTION kordos_inbox.priorities(p_sort text, p_project uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH accessible AS MATERIALIZED (
    SELECT p.*, kordos_planning.project_access(p.id) AS access
    FROM public.projects p
    WHERE p.workspace_id = kordos_identity.workspace_id()
      AND (p_project IS NULL OR p.id = p_project)
      AND kordos_planning.project_access(p.id) IS NOT NULL
  ), active AS (
    SELECT * FROM accessible WHERE archived_at IS NULL
  ), reviews AS (
    SELECT p.id, p.revision, project.id AS project_id, project.name AS project_name,
      view->>'title' AS title, coalesce(w.deadline,w.commitment) AS deadline,
      coalesce(p.submitted_at,r.created_at) AS submitted_at, kordos_inbox.review_milestone(w) AS milestone
    FROM public.proposals p JOIN active project ON (project.workspace_id,project.id) = (p.workspace_id,p.project_id)
    JOIN public.proposal_revisions r ON (r.workspace_id,r.project_id,r.proposal_id,r.revision)
      = (p.workspace_id,p.project_id,p.id,p.revision)
    LEFT JOIN public.work_items w ON (w.workspace_id,w.project_id,w.id) = (p.workspace_id,p.project_id,p.work_id)
    CROSS JOIN LATERAL kordos_reviews.detail(p.id,p.revision) AS detail(view)
    WHERE p.status = 'pending' AND project.access = 'lead' AND kordos_inbox.review_ready(p,r,w)
      AND view->'canReview' = 'true' AND view->'evidenceRestricted' = 'false'
  ), due AS (
    SELECT w.id, project.id AS project_id, project.name AS project_name, w.title,
      coalesce(w.deadline,w.commitment) AS deadline
    FROM public.work_items w
    JOIN active project ON (project.workspace_id,project.id) = (w.workspace_id,w.project_id)
    WHERE w.owner_id = kordos_identity.actor_id() AND w.status <> 'done' AND w.archived_at IS NULL
      AND coalesce(w.deadline,w.commitment) <= (statement_timestamp() AT TIME ZONE project.time_zone)::date + 7
      AND kordos_planning.owner_eligible(project.id,w.owner_id)
    ORDER BY deadline,w.id LIMIT 5
  ), risks AS (
    SELECT f.id, project.id AS project_id, project.name AS project_name,
      coalesce(f.assessment->'task'->>'title', 'Schedule risk') AS title,
      f.created_at, f.assessment->>'severity' AS severity
    FROM public.risk_findings f
    JOIN active project ON (project.workspace_id,project.id) = (f.workspace_id,f.project_id)
    JOIN public.comments c ON (c.workspace_id,c.project_id,c.id) = (f.workspace_id,f.project_id,f.comment_id)
    WHERE f.status IN ('open','acknowledged') AND f.assessment->>'severity' IN ('at_risk','watch')
      AND kordos_risks.comment_at(c) = f.source_at
      AND kordos_collaboration.subject_open(project.id,c.subject_kind,c.subject_id)
    ORDER BY severity,f.created_at DESC,f.id LIMIT 5
  ), decisions AS (
    SELECT d.id, project.id AS project_id, project.name AS project_name, d.question, d.effective_date,
      d.confirmed_at, kordos_collaboration.person(d.accountable_id) AS accountable
    FROM public.decisions d JOIN active project ON (project.workspace_id,project.id) = (d.workspace_id,d.project_id)
    WHERE (d.confirmed_at IS NULL AND project.access = 'lead' OR d.confirmed_at >= statement_timestamp() - interval '7 days')
      AND NOT EXISTS (SELECT FROM public.decisions newer
        WHERE (newer.workspace_id,newer.project_id,newer.supersedes_id) = (d.workspace_id,d.project_id,d.id)
          AND newer.confirmed_at IS NOT NULL)
      AND (d.confirmed_at IS NOT NULL OR NOT EXISTS (
        SELECT FROM jsonb_array_elements(d.evidence) AS source(value) WHERE kordos_knowledge.citation(value) IS NULL))
    ORDER BY d.confirmed_at DESC NULLS FIRST,d.effective_date,d.id LIMIT 5
  ), mentions AS (
    SELECT e.id, e.subject_id, project.id AS project_id, project.name AS project_name, target.title, e.delivered_at
    FROM public.inbox_entries e
    JOIN active project ON (project.workspace_id,project.id) = (e.workspace_id,e.project_id)
    CROSS JOIN LATERAL kordos_inbox.target(e) target
    WHERE e.recipient_id = kordos_identity.actor_id() AND e.reason = 'mention'
      AND e.delivered_at IS NOT NULL AND e.read_at IS NULL AND e.canceled_at IS NULL AND target.active
    ORDER BY e.delivered_at DESC,e.id LIMIT 5
  )
  SELECT jsonb_build_object(
    'pendingCount', (SELECT count(*) FROM reviews),
    'reviews', coalesce((SELECT jsonb_agg(value ORDER BY sort_milestone NULLS LAST,submitted_at,id)
      FROM (SELECT id,submitted_at,CASE WHEN p_sort = 'milestone' THEN milestone END AS sort_milestone,
        jsonb_build_object('subjectId',id,'projectId',project_id,'projectName',project_name,'title',title,
          'deadline',deadline,'requestedAt',submitted_at,'milestone',milestone,'revision',revision) AS value
        FROM reviews ORDER BY sort_milestone NULLS LAST,submitted_at,id LIMIT 5) listed), '[]'),
    'due', coalesce((SELECT jsonb_agg(jsonb_build_object('subjectId',id,'projectId',project_id,
      'projectName',project_name,'title',title,'deadline',deadline) ORDER BY deadline,id) FROM due), '[]'),
    'risks', coalesce((SELECT jsonb_agg(jsonb_build_object('subjectId',id,'projectId',project_id,
      'projectName',project_name,'title',title,'deadline',NULL,'severity',severity)
      ORDER BY severity,created_at DESC,id) FROM risks), '[]'),
    'decisions', coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'projectId',project_id,
      'projectName',project_name,'question',question,'effectiveDate',effective_date,'confirmedAt',confirmed_at,
      'accountable',accountable) ORDER BY confirmed_at DESC NULLS FIRST,effective_date,id) FROM decisions), '[]'),
    'mentions', coalesce((SELECT jsonb_agg(jsonb_build_object('subjectId',subject_id,'projectId',project_id,
      'projectName',project_name,'title',title,'deadline',NULL,'receivedAt',delivered_at)
      ORDER BY delivered_at DESC,id) FROM mentions), '[]'))
  WHERE kordos_identity.current_role() IS NOT NULL
    AND (p_project IS NULL OR EXISTS (SELECT FROM accessible))
$$;

CREATE OR REPLACE FUNCTION kordos_inbox.home(p_sort text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_inbox.priorities(p_sort,NULL)
$$;
REVOKE EXECUTE ON FUNCTION kordos_inbox.priorities(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_inbox.priorities(text,uuid) TO kordos_app;

CREATE FUNCTION kordos_reviews.activity_type(p_action text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE split_part(p_action,'.',1)
    WHEN 'work' THEN 'work' WHEN 'duplicate' THEN 'work'
    WHEN 'comment' THEN 'discussion'
    WHEN 'proposal' THEN 'review'
    WHEN 'github' THEN CASE WHEN p_action = 'github.comment_published' THEN 'review' ELSE 'connector' END
    WHEN 'dependency' THEN 'dependency'
    WHEN 'document' THEN 'document'
    WHEN 'decision' THEN 'decision'
    WHEN 'meeting' THEN 'meeting'
    WHEN 'risk' THEN 'risk'
    WHEN 'brief' THEN 'brief'
    WHEN 'project' THEN 'project'
    WHEN 'connector' THEN 'connector'
    ELSE 'other' END
$$;

CREATE FUNCTION kordos_reviews.activity_allowed(a public.audit_events) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN a.project_id IS NULL THEN kordos_identity.current_role() = 'admin'
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

CREATE FUNCTION kordos_reviews.activity_entity(a public.audit_events, p_work uuid, p_proposal uuid, p_revision int)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN ref.id IS NOT NULL THEN jsonb_build_object('kind',ref.kind,'id',ref.id,'revision',ref.revision) END
  FROM LATERAL (
    SELECT CASE
      WHEN p_proposal IS NOT NULL THEN 'review'
      WHEN p_work IS NOT NULL THEN 'work'
      WHEN a.action LIKE 'comment.%' THEN 'comment'
      WHEN a.action LIKE 'document.%' THEN 'document'
      WHEN a.action LIKE 'decision.%' THEN 'decision'
      WHEN a.action LIKE 'meeting.%' THEN 'meeting'
      WHEN a.action LIKE 'risk.%' THEN 'risk'
      WHEN a.action LIKE 'brief.%' THEN 'brief'
      WHEN a.action LIKE 'github.%' THEN 'github'
    END AS kind,
    coalesce(p_proposal,p_work, CASE
      WHEN a.action = 'document.attachment_added' THEN (a.details->'after'->>'documentId')::uuid
      WHEN a.action LIKE 'meeting.item_%' THEN (a.details->'after'->>'meetingId')::uuid
      ELSE a.target_id END) AS id,
    CASE WHEN p_proposal IS NOT NULL THEN p_revision
      WHEN a.action LIKE 'document.%' THEN (a.details->'after'->>'revision')::int END AS revision
  ) ref
  WHERE ref.kind IS NOT NULL AND (ref.kind <> 'github' OR EXISTS (
    SELECT FROM public.source_objects s WHERE (s.workspace_id,s.project_id,s.id) = (a.workspace_id,a.project_id,ref.id)
      AND kordos_connectors.mirror_allowed(s)))
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.audit(p_filter jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH visible AS NOT MATERIALIZED (
    SELECT a.*, a AS event, project.name AS project_name,
      kind AS activity_type, origin AS activity_source
    FROM public.audit_events a
    LEFT JOIN public.projects project ON (project.workspace_id,project.id) = (a.workspace_id,a.project_id)
    CROSS JOIN LATERAL (SELECT kordos_reviews.activity_type(a.action) AS kind,
      CASE WHEN a.action LIKE 'github.%' OR (a.action LIKE 'proposal.%' AND EXISTS (
        SELECT FROM public.proposals p WHERE p.workspace_id = a.workspace_id AND p.id = a.target_id
          AND p.github_source_id IS NOT NULL
      )) THEN 'github' ELSE 'workspace' END AS origin) classification
    WHERE a.workspace_id = kordos_identity.workspace_id()
      AND kordos_reviews.activity_allowed(a)
      AND (p_filter->>'eventId' IS NULL OR a.id = (p_filter->>'eventId')::uuid)
      AND (p_filter->>'githubCommentUrl' IS NULL OR (a.action = 'github.comment_published' AND EXISTS (
        SELECT FROM public.executions e WHERE e.effect_event_id = a.id AND e.workspace_id = a.workspace_id
          AND e.github_remote->>'url' = lower(p_filter->>'githubCommentUrl'))))
      AND (p_filter->>'projectId' IS NULL OR a.project_id = (p_filter->>'projectId')::uuid)
      AND (p_filter->>'actorId' IS NULL OR a.actor_id = (p_filter->>'actorId')::uuid)
      AND (p_filter->>'source' IS NULL OR origin = p_filter->>'source')
      AND (p_filter->>'type' IS NULL OR kind = p_filter->>'type')
      AND (p_filter->>'targetId' IS NULL OR a.target_id = (p_filter->>'targetId')::uuid
        OR (a.action LIKE 'proposal.%' AND a.details->'after'->>'workId' = p_filter->>'targetId'))
      AND (p_filter->>'from' IS NULL OR a.created_at >= ((p_filter->>'from')::date::timestamp AT TIME ZONE 'UTC'))
      AND (p_filter->>'to' IS NULL OR a.created_at < (((p_filter->>'to')::date + 1)::timestamp AT TIME ZONE 'UTC'))
  ), entries AS (
    SELECT * FROM visible v WHERE p_filter->>'cursor' IS NULL
      OR (v.created_at,v.id) < (SELECT created_at,id FROM visible WHERE id = (p_filter->>'cursor')::uuid)
    ORDER BY v.created_at DESC,v.id DESC LIMIT 41
  ), page AS (
    SELECT * FROM entries ORDER BY created_at DESC,id DESC LIMIT 40
  )
  SELECT jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'type', a.activity_type, 'source', a.activity_source,
      'entity', kordos_reviews.activity_entity(a.event, ids.work_id, ids.proposal_id, ids.revision),
      'id', a.id, 'targetId', a.target_id, 'action', a.action, 'occurredAt', a.created_at,
      'projectId', a.project_id, 'projectName', a.project_name,
      'actor', kordos_collaboration.person(a.actor_id),
      'actorType', CASE WHEN e.id IS NOT NULL OR (CASE WHEN a.action LIKE 'brief.%' OR a.action LIKE 'risk.%' OR a.action LIKE 'meeting.%' THEN a.details->'after' ELSE meta END)->>'executor' = 'true' THEN 'service' ELSE 'user' END,
      'workId', ids.work_id,
      'proposalId', ids.proposal_id,
      'revision', ids.revision,
      'receiptId', coalesce(e.id, (meta->>'receiptId')::uuid),
      'before', CASE WHEN a.action LIKE 'work.%' THEN a.details->'before' END,
      'after', CASE WHEN a.action LIKE 'work.%' THEN a.details->'after' END
    ) ORDER BY a.created_at DESC, a.id DESC)
    FROM page a
    LEFT JOIN public.executions e ON e.effect_event_id = a.id AND e.workspace_id = a.workspace_id
    CROSS JOIN LATERAL (SELECT CASE WHEN a.action LIKE 'proposal.%' OR a.action = 'duplicate.proposal_reused' THEN a.details->'after' END AS meta) m
    LEFT JOIN public.proposals p ON p.workspace_id = a.workspace_id
      AND p.id = coalesce(e.proposal_id, CASE WHEN meta IS NOT NULL THEN a.target_id END)
    CROSS JOIN LATERAL (SELECT
      CASE WHEN a.action LIKE 'work.%' OR a.action = 'duplicate.consolidated' THEN a.target_id
        ELSE (meta->>'workId')::uuid END AS work_id,
      CASE WHEN kordos_reviews.can_read(p) THEN p.id END AS proposal_id,
      CASE WHEN kordos_reviews.can_read(p) THEN coalesce(e.revision,(meta->>'revision')::int) END AS revision
    ) ids
  ), '[]'), 'nextCursor', CASE WHEN (SELECT count(*) FROM entries) > 40 THEN
    (SELECT id FROM page ORDER BY created_at, id LIMIT 1) END)
  WHERE kordos_identity.current_role() IS NOT NULL
$$;
REVOKE EXECUTE ON FUNCTION kordos_reviews.activity_type(text),
  kordos_reviews.activity_allowed(public.audit_events),
  kordos_reviews.activity_entity(public.audit_events,uuid,uuid,int) FROM PUBLIC;
