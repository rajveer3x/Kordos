-- Run on the isolated database after the Chromium journey suite.
-- Return identifiers and states only. The attempt sets start from durable jobs,
-- queue entries, snapshots and receipts instead of counting audit rows alone.
BEGIN READ ONLY;
WITH meeting_queue AS (
  SELECT o.*, lead(o.created_at) OVER (
    PARTITION BY o.workspace_id, o.project_id, o.target_id ORDER BY o.created_at, o.id
  ) AS next_at
  FROM public.outbox o
  WHERE o.kind IN ('meeting.queued', 'meeting.audio_queued')
), weekly_runs AS (
  SELECT a.*, a.details->'after' AS evidence
  FROM public.audit_events a WHERE a.action = 'ops.weekly_report'
), checks AS (
  SELECT 'brief attempt' AS operation, b.id::text || ':' || attempts.n AS ref,
    EXISTS (
      SELECT FROM public.audit_events a
      WHERE (a.workspace_id, a.project_id, a.target_id, a.actor_id) =
        (b.workspace_id, b.project_id, b.id, b.requester_id)
        AND a.action IN ('brief.ready', 'brief.failed')
        AND (a.details->'after'->>'attempt')::int = attempts.n
        AND (attempts.n <> b.attempt OR a.action = 'brief.' || b.status)
    ) AND EXISTS (
      SELECT FROM public.document_versions v
      WHERE (v.workspace_id, v.project_id, v.document_id, v.revision) =
        (b.workspace_id, b.project_id, b.document_id, b.source_revision)
    ) AS linked
  FROM public.brief_jobs b CROSS JOIN LATERAL generate_series(1, b.attempt) AS attempts(n)
  UNION ALL
  SELECT 'meeting attempt', q.id::text,
    EXISTS (
      SELECT FROM public.audit_events a
      WHERE (a.workspace_id, a.project_id, a.target_id, a.actor_id) =
        (q.workspace_id, q.project_id, q.target_id, q.actor_id)
        AND a.action IN ('meeting.ready', 'meeting.processing_failed')
        AND a.created_at >= q.created_at AND (q.next_at IS NULL OR a.created_at < q.next_at)
        AND CASE a.action WHEN 'meeting.ready' THEN
          EXISTS (
            SELECT FROM public.meeting_transcripts t
            WHERE (t.workspace_id, t.project_id, t.meeting_id, t.revision) =
              (a.workspace_id, a.project_id, a.target_id, (a.details->'after'->>'revision')::int)
          )
        ELSE a.details->'after'->>'failure' IS NOT NULL AND (
          q.request->>'_command' = 'meeting.paste' OR EXISTS (
            SELECT FROM public.meeting_media m
            WHERE (m.workspace_id, m.project_id, m.meeting_id) =
              (q.workspace_id, q.project_id, q.target_id)
              AND m.id::text = coalesce(q.request->>'mediaId', (
                SELECT queued.details->'after'->>'mediaId' FROM public.audit_events queued WHERE queued.id = q.id
              ))
          )
        ) END
    )
  FROM meeting_queue q
  UNION ALL
  SELECT 'approved command', e.id::text,
    r.author_id IS NOT NULL AND coalesce(jsonb_typeof(r.evidence) = 'array', false)
      AND (jsonb_array_length(r.evidence) > 0 OR p.work_id IS NOT NULL OR EXISTS (
        SELECT FROM public.source_revisions s
        WHERE (s.workspace_id, s.project_id, s.source_id, s.revision) =
          (p.workspace_id, p.project_id, p.github_source_id, r.target_version)
      ))
      AND coalesce(a.actor_id = e.reviewer_id
        AND a.action = 'proposal.approved'
        AND a.details->'after'->>'receiptId' = e.id::text
        AND a.details->'after'->>'revision' = e.revision::text, false)
      AND coalesce(o.actor_id = e.reviewer_id
        AND o.action = 'proposal.' || e.status::text
        AND o.details->'after'->>'receiptId' = e.id::text
        AND o.details->'after'->>'revision' = e.revision::text, false)
      AND CASE WHEN e.status = 'applied'
        THEN coalesce(effect.actor_id = e.reviewer_id, false)
          AND (p.github_source_id IS NULL OR
            (effect.target_id = p.github_source_id AND e.github_remote->>'url' IS NOT NULL
              AND effect.details->'after'->>'receiptId' = e.id::text))
        ELSE e.issue IS NOT NULL AND e.effect_event_id IS NULL END
  FROM public.executions e
  JOIN public.proposals p ON (p.workspace_id, p.project_id, p.id) = (e.workspace_id, e.project_id, e.proposal_id)
  LEFT JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision) =
    (e.workspace_id, e.project_id, e.proposal_id, e.revision)
  LEFT JOIN public.audit_events a ON a.id = e.approval_audit_id
    AND (a.workspace_id, a.project_id, a.target_id) = (e.workspace_id, e.project_id, e.proposal_id)
  LEFT JOIN public.audit_events o ON o.id = e.outcome_audit_id
    AND (o.workspace_id, o.project_id, o.target_id) = (e.workspace_id, e.project_id, e.proposal_id)
  LEFT JOIN public.audit_events effect ON effect.id = e.effect_event_id
    AND (effect.workspace_id, effect.project_id) = (e.workspace_id, e.project_id)
  UNION ALL
  SELECT 'GitHub execution attempt', e.id::text || ':' || attempts.n,
    (SELECT count(DISTINCT a.action) = 2 FROM public.audit_events a
      WHERE (a.workspace_id, a.project_id, a.target_id, a.actor_id) =
        (e.workspace_id, e.project_id, e.proposal_id, e.reviewer_id)
        AND a.action IN ('ops.github_attempt_started', 'ops.github_attempt_finished')
        AND a.details->'after'->>'receiptId' = e.id::text
        AND a.details->'after'->>'revision' = e.revision::text
        AND a.details->'after'->>'attempt' = attempts.n::text
        AND a.details->'after'->>'sourceId' = p.github_source_id::text
        AND a.details->'after'->>'sourceVersion' = r.target_version::text
        AND a.details->'after'->>'outcome' IS NOT NULL)
  FROM public.executions e
  JOIN public.proposals p ON p.id = e.proposal_id
  JOIN public.proposal_revisions r ON (r.proposal_id,r.revision) = (e.proposal_id,e.revision)
  CROSS JOIN LATERAL generate_series(1, e.github_attempts) AS attempts(n)
  UNION ALL
  SELECT 'risk evaluation', j.id::text,
    j.processed_at IS NOT NULL AND EXISTS (
      SELECT FROM public.audit_events a
      WHERE (a.workspace_id, a.project_id, a.target_id, a.actor_id) =
        (source.workspace_id, source.project_id, j.id, source.actor_id)
        AND a.action = 'ops.risk_evaluated'
        AND a.details->'after'->>'sourceEventId' = source.id::text
        AND a.details->'after'->>'sourceId' = source.target_id::text
        AND a.details->'after'->>'sourceVersion' = source.details->'after'->>'version'
        AND a.details->'after'->>'outcome' IN ('finding_recorded','no_finding','source_changed','unavailable')
    )
  FROM public.risk_comment_jobs j LEFT JOIN public.audit_events source USING (id)
  UNION ALL
  SELECT 'risk evaluation', a.id::text,
    (a.workspace_id,a.project_id,a.actor_id,a.target_id) =
      (source.workspace_id,source.project_id,source.actor_id,source.id)
      AND a.details->'after'->>'sourceId' = source.target_id::text
      AND a.details->'after'->>'sourceVersion' = source.details->'after'->>'version'
  FROM public.audit_events a
  LEFT JOIN public.audit_events source ON source.id = (a.details->'after'->>'sourceEventId')::uuid
  WHERE a.action = 'ops.risk_evaluated' AND a.details->'after'->>'outcome' = 'failed'
  UNION ALL
  SELECT 'weekly report capture', a.id::text,
    a.target_id = a.project_id AND a.evidence->>'capturedAt' IS NOT NULL
      AND a.evidence->>'period' IS NOT NULL AND a.actor_id IS NOT NULL
      AND CASE WHEN a.evidence->>'outcome' = 'saved'
        THEN a.evidence->>'inputRevision' IS NOT NULL
        ELSE a.evidence->>'outcome' IN ('failed','skipped','unchanged') END
  FROM weekly_runs a
  UNION ALL
  SELECT 'weekly report capture', w.project_id::text || ':' || w.period, false
  FROM public.project_weeklies w
  -- The browser history test inserts a copy into the preceding week.
  WHERE w.period = date_trunc('week', (w.snapshot->>'asOf')::date)::date
    AND NOT EXISTS (
      SELECT FROM weekly_runs a
      WHERE (a.workspace_id,a.project_id) = (w.workspace_id,w.project_id)
        AND a.evidence->>'outcome' = 'saved' AND a.evidence->>'period' = w.period::text
        AND (a.evidence->>'capturedAt')::timestamptz = w.generated_at
        AND a.evidence->>'inputRevision' = w.snapshot->>'inputRevision'
    )
), summary AS (
  SELECT operation, count(*) AS attempts, count(*) FILTER (WHERE linked IS TRUE) AS linked,
    coalesce(jsonb_agg(ref ORDER BY ref) FILTER (WHERE linked IS DISTINCT FROM true), '[]') AS missing
  FROM checks GROUP BY operation
)
SELECT jsonb_pretty(jsonb_build_object(
  'audit_classes', (SELECT jsonb_agg(to_jsonb(summary) ORDER BY operation) FROM summary),
  'total_attempts', (SELECT count(*) FROM checks),
  'total_linked', (SELECT count(*) FROM checks WHERE linked IS TRUE),
  'github_claims', (SELECT coalesce(sum(github_attempts), 0) FROM public.executions),
  'github_published', (SELECT count(*) FROM public.executions WHERE github_remote IS NOT NULL)
));
COMMIT;
