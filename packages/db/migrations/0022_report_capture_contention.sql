-- Resolve each distinct owner once per authorized schedule. Risk analysis,
-- forecasts and weekly capture all share this reader.
CREATE OR REPLACE FUNCTION kordos_planning.read_schedule(p_workspace uuid, p_project uuid)
RETURNS TABLE ("graphVersion" int, archived boolean, "readAtMillis" float8,
  "inputRevision" text, calendar jsonb, items jsonb, edges jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog SET jit = off AS $$
    WITH items AS MATERIALIZED (
      SELECT id, title, kind, status, version, estimate_days, commitment, completed_at, owner_id
      FROM public.work_items
      WHERE workspace_id = kordos_identity.workspace_id() AND project_id = p_project AND archived_at IS NULL
    ), owners AS MATERIALIZED (
      SELECT owner_id, kordos_planning.person(p_project, owner_id) AS person
      FROM (SELECT DISTINCT owner_id FROM items WHERE owner_id IS NOT NULL) assigned
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
        'owner', o.person
      ) ORDER BY i.title, i.id) AS items,
      jsonb_agg(jsonb_build_array(i.id, i.version) ORDER BY i.id) AS revisions
      FROM items i LEFT JOIN owners o USING (owner_id)
    ) work
    WHERE p.workspace_id = p_workspace AND p_workspace = kordos_identity.workspace_id() AND p.id = p_project AND kordos_planning.project_access(p_project) IS NOT NULL
$$;

-- Hold the project's write lock throughout capture while allowing search
-- chunk inserts to take foreign key share locks on the same project.
CREATE OR REPLACE FUNCTION kordos_health.next_project() RETURNS TABLE (workspace uuid, project uuid, actor uuid)
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
  LIMIT 1 FOR NO KEY UPDATE OF p SKIP LOCKED
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
  WHERE (workspace_id, id) = (tenant, p_project) AND archived_at IS NULL FOR NO KEY UPDATE;
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
