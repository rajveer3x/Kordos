CREATE TABLE "search_vectors" (
	"chunk_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "search_kind" NOT NULL,
	"owner_id" uuid,
	"attributed_date" date,
	"model" text NOT NULL,
	"embedding" vector(512) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_vectors" ADD CONSTRAINT "search_vectors_chunk_id_search_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."search_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_vectors_scope_idx" ON "search_vectors" USING btree ("workspace_id","model","project_id");

--> statement-breakpoint
-- Distance scans read compact rows with the vector inline. Full content,
-- mutable connector grants and retention rules stay in the chunk lookup.
ALTER TABLE public.search_vectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_vectors ALTER COLUMN embedding SET STORAGE PLAIN;

CREATE FUNCTION kordos_search.sync_vector() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.embedding IS NULL OR NEW.model IS NULL OR NEW.audience <> 'project' THEN
    IF TG_OP = 'UPDATE' AND OLD.embedding IS NOT NULL THEN
      DELETE FROM public.search_vectors WHERE chunk_id = NEW.id;
    END IF;
  ELSE
    INSERT INTO public.search_vectors
      (chunk_id,workspace_id,project_id,kind,owner_id,attributed_date,model,embedding)
    VALUES (NEW.id,NEW.workspace_id,NEW.project_id,NEW.kind,NEW.owner_id,NEW.attributed_date,NEW.model,NEW.embedding)
    ON CONFLICT (chunk_id) DO UPDATE SET
      workspace_id = excluded.workspace_id, project_id = excluded.project_id, kind = excluded.kind,
      owner_id = excluded.owner_id, attributed_date = excluded.attributed_date,
      model = excluded.model, embedding = excluded.embedding;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION kordos_search.sync_vector() FROM PUBLIC;

-- Block concurrent chunk changes between taking the backfill snapshot and
-- installing the trigger. Existing readers continue using the previous query.
LOCK TABLE public.search_chunks IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public.search_vectors
  (chunk_id,workspace_id,project_id,kind,owner_id,attributed_date,model,embedding)
SELECT id,workspace_id,project_id,kind,owner_id,attributed_date,model,embedding
FROM public.search_chunks WHERE embedding IS NOT NULL AND model IS NOT NULL AND audience = 'project';

CREATE TRIGGER search_sync_vector AFTER INSERT OR UPDATE OF
  workspace_id,project_id,kind,owner_id,attributed_date,model,embedding,audience
ON public.search_chunks FOR EACH ROW EXECUTE FUNCTION kordos_search.sync_vector();

ANALYZE public.search_vectors;

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
  ), vector_matches AS MATERIALIZED (
    SELECT v.chunk_id, v.embedding OPERATOR(public.<=>) p_vector AS distance
    FROM public.search_vectors v CROSS JOIN filters f
    WHERE p_exact IS NULL AND p_vector IS NOT NULL AND v.model = p_model
      AND v.workspace_id = (SELECT kordos_identity.workspace_id())
      AND v.project_id = ANY(ARRAY(SELECT id FROM projects))
      AND (f.kind IS NULL OR v.kind = f.kind) AND (f.owner IS NULL OR v.owner_id = f.owner)
      AND (f.since IS NULL OR v.attributed_date >= f.since)
      AND (f.until IS NULL OR v.attributed_date <= f.until)
      AND v.embedding OPERATOR(public.<=>) p_vector <= 0.65
  ), vector_best AS (
    SELECT DISTINCT ON (c.kind,c.source_id) c.id,c.kind,c.source_id,v.distance
    FROM vector_matches v JOIN candidate c ON c.id = v.chunk_id
    WHERE c.kind <> 'github' OR kordos_search.github_audience(c.source_id) = 'project'
    ORDER BY c.kind,c.source_id,v.distance,c.ordinal
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
    'mode',CASE WHEN p_exact IS NOT NULL THEN 'exact' WHEN p_vector IS NOT NULL AND (EXISTS (SELECT FROM vector_best) OR EXISTS (
      SELECT FROM candidate c
      WHERE c.model = p_model AND c.embedding IS NOT NULL
        AND (c.kind <> 'github' OR kordos_search.github_audience(c.source_id) = 'project'))) THEN 'hybrid' ELSE 'lexical' END
  ) WHERE kordos_identity.current_role() IS NOT NULL
    AND (p_input->>'project' IS NULL OR EXISTS (SELECT FROM projects))
$$;
