-- Avoid compiling the nested retention plans for every short search request.
-- Inline request filters and check expensive source rules only for source kinds
-- that need them. Distance filtering no longer materializes every embedding's score.
CREATE OR REPLACE FUNCTION kordos_search.query(p_input jsonb,p_exact text,p_model text,p_vector public.vector)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog SET jit = off AS $$
  WITH projects AS MATERIALIZED (
    SELECT p.id,p.name FROM public.projects p WHERE p.workspace_id = kordos_identity.workspace_id()
      AND p.archived_at IS NULL AND kordos_planning.project_access(p.id) IS NOT NULL
      AND (p_input->>'project' IS NULL OR p.id = (p_input->>'project')::uuid)
  ), filters AS NOT MATERIALIZED (
    SELECT websearch_to_tsquery('english',p_input->>'q') AS terms,(p_input->>'type')::public.search_kind AS kind,
      (p_input->>'owner')::uuid AS owner,(p_input->>'from')::date AS since,(p_input->>'to')::date AS until
  ), candidate AS NOT MATERIALIZED (
    SELECT c.*,p.name AS project,f.terms AS query_terms
    FROM public.search_chunks c JOIN projects p ON p.id = c.project_id CROSS JOIN filters f
    WHERE c.workspace_id = kordos_identity.workspace_id()
      AND (f.kind IS NULL OR c.kind = f.kind) AND (f.owner IS NULL OR c.owner_id = f.owner)
      AND (f.since IS NULL OR c.attributed_date >= f.since)
      AND (f.until IS NULL OR c.attributed_date <= f.until)
      AND CASE WHEN c.kind IN ('github','email')
        THEN kordos_search.allowed(c.project_id,c.kind,c.source_id) ELSE true END
      AND CASE WHEN c.kind = 'github' OR (c.kind = 'meeting' AND c.citation IS NOT NULL)
        THEN kordos_retention.search_visible(c) ELSE true END
      AND NOT EXISTS (SELECT FROM public.search_outbox o WHERE (o.workspace_id,o.project_id,o.kind,o.source_id)
        = (c.workspace_id,c.project_id,c.kind,c.source_id))
  ), exact AS (
    SELECT DISTINCT ON (kind,source_id) id,kind,source_id
    FROM candidate WHERE p_exact IS NOT NULL AND exact_ids @> ARRAY[p_exact]
    ORDER BY kind,source_id,ordinal
  ), lexical_best AS (
    SELECT DISTINCT ON (kind,source_id) id,kind,source_id,ts_rank_cd(terms,query_terms,32) AS score
    FROM candidate WHERE p_exact IS NULL AND terms @@ query_terms
    ORDER BY kind,source_id,score DESC,ordinal
  ), vector_candidates AS NOT MATERIALIZED (
    SELECT id,kind,source_id,ordinal,embedding OPERATOR(public.<=>) p_vector AS distance
    FROM candidate WHERE p_exact IS NULL AND p_vector IS NOT NULL AND model = p_model AND embedding IS NOT NULL
      AND (kind <> 'github' OR kordos_search.github_audience(source_id) = 'project')
  ), vector_best AS (
    SELECT DISTINCT ON (kind,source_id) id,kind,source_id,distance
    FROM vector_candidates WHERE distance <= 0.65
    ORDER BY kind,source_id,distance,ordinal
  ), ranked AS (
    SELECT id,kind,source_id,1.0 AS score FROM exact
    UNION ALL
    (SELECT id,kind,source_id,1.0/(60 + row_number() OVER (ORDER BY score DESC,id)) AS score
      FROM lexical_best ORDER BY lexical_best.score DESC,id LIMIT 90)
    UNION ALL
    (SELECT id,kind,source_id,1.0/(60 + row_number() OVER (ORDER BY distance,id)) AS score
      FROM vector_best ORDER BY distance,id LIMIT 90)
  ), grouped AS (
    SELECT (array_agg(id ORDER BY score DESC,id))[1] AS id,sum(score) AS score
    FROM ranked GROUP BY kind,source_id ORDER BY sum(score) DESC,kind,source_id LIMIT 31
  ), hydrated AS (
    SELECT jsonb_build_object('id',c.source_id,'kind',c.kind,'projectId',c.project_id,
      'project',c.project,'title',c.title,'excerpt',c.passage,'attribution',c.attribution,
      'date',c.attributed_date,'revision',c.revision,'externalId',c.external_id,'citation',c.citation,
      'modelAllowed',c.audience = 'project' AND (c.kind <> 'github' OR kordos_search.github_audience(c.source_id) = 'project')
    ) AS value, g.score,c.kind,c.source_id
    FROM grouped g JOIN candidate c ON c.id = g.id
    ORDER BY g.score DESC,c.kind,c.source_id LIMIT 30
  )
  SELECT jsonb_build_object(
    'items',coalesce((SELECT jsonb_agg(value ORDER BY score DESC,kind,source_id) FROM hydrated),'[]'),
    'hasMore',(SELECT count(*) FROM grouped) > 30,
    'indexing',EXISTS (
      SELECT FROM public.search_outbox o JOIN projects p ON p.id = o.project_id
      JOIN kordos_search.sources s ON (s.workspace_id,s.project_id,s.kind,s.source_id)
        = (o.workspace_id,o.project_id,o.kind,o.source_id)
      CROSS JOIN filters f
      WHERE o.workspace_id = kordos_identity.workspace_id() AND (f.kind IS NULL OR o.kind = f.kind)
        AND (f.owner IS NULL OR s.owner_id = f.owner)
        AND (f.since IS NULL OR s.attributed_date >= f.since) AND (f.until IS NULL OR s.attributed_date <= f.until)
        AND kordos_search.allowed(o.project_id,o.kind,o.source_id)),
    'mode',CASE WHEN p_exact IS NOT NULL THEN 'exact' WHEN EXISTS (SELECT FROM vector_candidates) THEN 'hybrid' ELSE 'lexical' END
  ) WHERE kordos_identity.current_role() IS NOT NULL
    AND (p_input->>'project' IS NULL OR EXISTS (SELECT FROM projects))
$$;
