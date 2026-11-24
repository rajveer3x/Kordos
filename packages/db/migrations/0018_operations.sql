CREATE SCHEMA kordos_ops;
REVOKE ALL ON SCHEMA kordos_ops FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_ops TO kordos_brief_worker;
--> statement-breakpoint
-- Keep the original worker functions available during a rolling update.
CREATE FUNCTION kordos_ops.claim_brief(p_id uuid, p_attempt int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE claimed jsonb := kordos_briefs.claim(p_id, p_attempt);
BEGIN
  RETURN claimed || jsonb_build_object('workspaceId', kordos_identity.workspace_id());
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_ops.claim_meeting(p_id uuid, p_generation int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE claimed jsonb := kordos_meetings.claim(p_id, p_generation);
BEGIN
  RETURN claimed || jsonb_build_object('workspaceId', kordos_identity.workspace_id());
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_ops.claim_embeddings(p_model text, p_lease uuid)
RETURNS TABLE(id uuid, workspace_id uuid, title text, passage text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT c.id, s.workspace_id, c.title, c.passage
  FROM kordos_search.claim_embeddings(p_model, p_lease) c
  JOIN public.search_chunks s ON s.id = c.id
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_ops.backlog()
RETURNS TABLE(queue text, pending bigint, oldest_age_seconds bigint, retries bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT component, count(*),
    greatest(0, extract(epoch FROM statement_timestamp() - min(queued)))::bigint,
    sum(attempts) AS retries
  FROM (
    SELECT 'brief' AS component, b.created_at AS queued, b.attempt - 1 AS attempts
      FROM public.brief_jobs b WHERE b.status IN ('queued', 'running')
    UNION ALL
    SELECT 'meeting', (SELECT a.created_at FROM public.audit_events a
        WHERE (a.workspace_id, a.project_id, a.target_id) = (m.workspace_id, m.project_id, m.id)
          AND a.action IN ('meeting.queued', 'meeting.audio_queued')
        ORDER BY a.created_at DESC LIMIT 1), greatest(0, m.attempt - 1)
      FROM public.meetings m WHERE m.status IN ('queued', 'processing')
    UNION ALL
    SELECT CASE WHEN p.github_source_id IS NULL THEN 'execution' ELSE 'github_execution' END,
        e.approved_at, greatest(0, e.github_attempts - 1)
      FROM public.executions e JOIN public.proposals p
        ON (p.workspace_id, p.project_id, p.id) = (e.workspace_id, e.project_id, e.proposal_id)
      WHERE e.status IN ('approved', 'applying')
    UNION ALL
    SELECT 'github_reconciliation', e.approved_at, greatest(0, e.github_attempts - 1)
      FROM public.executions e WHERE e.status = 'reconciliation_required'
    UNION ALL
    SELECT 'risk', r.created_at, 0 FROM public.risk_comment_jobs r WHERE r.processed_at IS NULL
    UNION ALL
    SELECT 'connector', j.created_at, greatest(0, j.attempts - 1)
      FROM public.connector_jobs j WHERE j.state IN ('queued', 'running')
      AND (j.available_at <= statement_timestamp() OR j.state = 'running')
    UNION ALL
    SELECT 'search_index', s.queued_at, 0 FROM public.search_outbox s
    UNION ALL
    SELECT 'inbox', i.next_at, 0 FROM public.inbox_entries i
      WHERE i.canceled_at IS NULL AND i.delivered_at IS NULL AND i.next_at <= statement_timestamp()
    UNION ALL
    SELECT 'email', i.email_at, greatest(0, i.email_attempts - 1) FROM public.inbox_entries i
      WHERE i.canceled_at IS NULL AND i.email_result IS NULL AND i.email_at <= statement_timestamp()
    UNION ALL
    SELECT 'storage_deletion', coalesce(m.removed_at, m.expires_at), 0
      FROM public.meeting_media m WHERE m.deleted_at IS NULL
      AND (m.removed_at IS NOT NULL OR m.expires_at <= statement_timestamp())
  ) q
  GROUP BY component
$$;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA kordos_ops FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_ops TO kordos_brief_worker;
