CREATE INDEX "search_chunk_embedding_workspace_idx" ON "search_chunks" USING btree ("workspace_id","model","embed_after","id") WHERE "search_chunks"."audience" = 'project';
--> statement-breakpoint
CREATE FUNCTION kordos_search.claim_embeddings(p_model text, p_lease uuid, p_skip uuid[])
RETURNS TABLE(id uuid, title text, passage text, embedding_lease uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH due AS (
    (SELECT c.id, c.embed_after FROM public.search_chunks c
      WHERE c.audience = 'project' AND c.model IS NULL AND c.embed_after <= statement_timestamp()
        AND (cardinality(p_skip) = 0 OR NOT (c.workspace_id = ANY(p_skip)))
        AND kordos_search.can_embed(c)
      ORDER BY c.embed_after, c.id LIMIT 12)
    UNION ALL
    (SELECT c.id, c.embed_after FROM public.search_chunks c
      WHERE c.audience = 'project' AND c.model < p_model AND c.embed_after <= statement_timestamp()
        AND (cardinality(p_skip) = 0 OR NOT (c.workspace_id = ANY(p_skip)))
        AND kordos_search.can_embed(c)
      ORDER BY c.model, c.embed_after, c.id LIMIT 12)
    UNION ALL
    (SELECT c.id, c.embed_after FROM public.search_chunks c
      WHERE c.audience = 'project' AND c.model > p_model AND c.embed_after <= statement_timestamp()
        AND (cardinality(p_skip) = 0 OR NOT (c.workspace_id = ANY(p_skip)))
        AND kordos_search.can_embed(c)
      ORDER BY c.model, c.embed_after, c.id LIMIT 12)
  ), batch AS (
    SELECT c.id FROM due d JOIN public.search_chunks c ON c.id = d.id
    WHERE c.model IS DISTINCT FROM p_model AND c.embed_after <= statement_timestamp()
    ORDER BY d.embed_after, c.id LIMIT 12 FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE public.search_chunks c SET embedding_lease = p_lease, embed_after = statement_timestamp() + interval '1 minute'
  FROM batch b WHERE c.id = b.id
  RETURNING c.id, c.title, c.passage, c.embedding_lease
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_ops.claim_embeddings(p_model text, p_lease uuid, p_skip uuid[])
RETURNS TABLE(id uuid, workspace_id uuid, title text, passage text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT c.id, s.workspace_id, c.title, c.passage
  FROM kordos_search.claim_embeddings(p_model, p_lease, p_skip) c
  JOIN public.search_chunks s ON s.id = c.id
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_search.defer_embeddings(
  p_lease uuid, p_workspace uuid, p_model text, p_seconds int
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  delay interval := make_interval(secs => greatest(60, least(p_seconds, 300)));
  until_at timestamptz := statement_timestamp() + delay;
BEGIN
  UPDATE public.search_chunks c SET embedding_lease = NULL, embed_after = until_at
  WHERE c.workspace_id = p_workspace AND c.embedding_lease = p_lease;

  WITH queued AS (
    SELECT c.id FROM public.search_chunks c
    WHERE c.audience = 'project' AND c.workspace_id = p_workspace
      AND c.embedding_lease IS NULL AND c.embed_after <= statement_timestamp()
      AND (c.model IS NULL OR c.model < p_model OR c.model > p_model)
    ORDER BY c.model, c.embed_after, c.id LIMIT 5000 FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE public.search_chunks c SET embed_after = until_at
  FROM queued q WHERE c.id = q.id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kordos_search.claim_embeddings(text, uuid, uuid[]),
  kordos_search.defer_embeddings(uuid, uuid, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION kordos_ops.claim_embeddings(text, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_search.defer_embeddings(uuid, uuid, text, int) TO kordos_brief_worker;
GRANT EXECUTE ON FUNCTION kordos_ops.claim_embeddings(text, uuid, uuid[]) TO kordos_brief_worker;