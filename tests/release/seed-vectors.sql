-- Synthetic vectors use the same dimension mapping as the loopback fixture.
-- Restrict the update to the fixture sources and preserve completed worker vectors.
WITH pending AS MATERIALIZED (
  SELECT id,
    coalesce((substring(title FROM 'dossier b([0-9]+)'))::int % 100,
      100 + (substring(title FROM 'record ([0-9]+)'))::int % 412) AS dimension
  FROM public.search_chunks
  WHERE workspace_id::text LIKE '22000000-0000-4000-8200-%'
    AND source_id::text LIKE '22000000-0000-4000-8%'
    AND model IS NULL
), loaded AS (
  UPDATE public.search_chunks c
  SET embedding = ('[' || repeat('0,', p.dimension) || '1' ||
      repeat(',0', 511 - p.dimension) || ']')::public.vector,
    model = 'search-embeddings-fixture', embedding_lease = NULL
  FROM pending p WHERE p.id = c.id AND p.dimension IS NOT NULL AND c.model IS NULL
  RETURNING c.id
)
SELECT count(*)::int AS chunks FROM loaded;
