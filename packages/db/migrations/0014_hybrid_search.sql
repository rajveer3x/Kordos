CREATE TYPE "public"."search_kind" AS ENUM('work', 'document', 'decision', 'meeting', 'github', 'email');--> statement-breakpoint
CREATE TABLE "search_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "search_kind" NOT NULL,
	"source_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"passage" text NOT NULL,
	"attribution" text NOT NULL,
	"attributed_date" date,
	"owner_id" uuid,
	"citation" jsonb,
	"external_id" text,
	"exact_ids" text[] NOT NULL,
	"audience" text NOT NULL,
	"terms" "tsvector" GENERATED ALWAYS AS (
      setweight(to_tsvector('english', title), 'A') ||
      setweight(to_tsvector('english', passage), 'B')
    ) STORED NOT NULL,
	"embedding" vector(512),
	"model" text,
	"embedding_lease" uuid,
	"embed_after" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_chunk_source_ordinal" UNIQUE("workspace_id","project_id","kind","source_id","ordinal"),
	CONSTRAINT "search_chunk_audience" CHECK ("search_chunks"."audience" IN ('project', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "search_outbox" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "search_kind" NOT NULL,
	"source_id" uuid NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_outbox_workspace_id_project_id_kind_source_id_pk" PRIMARY KEY("workspace_id","project_id","kind","source_id")
);
--> statement-breakpoint
ALTER TABLE "search_chunks" ADD CONSTRAINT "search_chunks_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_outbox" ADD CONSTRAINT "search_outbox_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_chunk_terms_idx" ON "search_chunks" USING gin ("terms");--> statement-breakpoint
CREATE INDEX "search_chunk_exact_idx" ON "search_chunks" USING gin ("exact_ids");--> statement-breakpoint
CREATE INDEX "search_chunk_embedding_queue_idx" ON "search_chunks" USING btree ("model","embed_after","id") WHERE "search_chunks"."audience" = 'project';--> statement-breakpoint
CREATE INDEX "search_outbox_queue_idx" ON "search_outbox" USING btree ("queued_at");
--> statement-breakpoint
CREATE SCHEMA kordos_search;
REVOKE ALL ON SCHEMA kordos_search FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_search TO kordos_app, kordos_brief_worker;
ALTER TABLE public.search_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_outbox ENABLE ROW LEVEL SECURITY;

-- The outbox is committed with the canonical write, including writes made by
-- existing approval and connector workers. Several writes can coalesce into one rebuild.
-- A pending row must be locked by the writer even when it already exists. An
-- indexer that processed the prior snapshot can then only delete the prior row.
-- ON CONFLICT DO UPDATE plus the worker's row lock enforce that ordering.
CREATE FUNCTION kordos_search.enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  subject record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  INSERT INTO public.search_outbox (workspace_id, project_id, kind, source_id)
    VALUES (subject.workspace_id, subject.project_id, TG_ARGV[0]::public.search_kind, subject.id)
  ON CONFLICT (workspace_id, project_id, kind, source_id) DO UPDATE SET queued_at = excluded.queued_at;
  RETURN NULL;
END
$$;

CREATE FUNCTION kordos_search.enqueue_github() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  subject record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  INSERT INTO public.search_outbox (workspace_id, project_id, kind, source_id)
  SELECT subject.workspace_id, subject.project_id, 'github', subject.id
  FROM public.connector_installations i
  WHERE (i.workspace_id, i.id) = (subject.workspace_id, subject.installation_id) AND i.provider = 'github'
  ON CONFLICT (workspace_id, project_id, kind, source_id) DO UPDATE SET queued_at = excluded.queued_at;
  RETURN NULL;
END
$$;

CREATE TRIGGER search_work AFTER INSERT OR UPDATE OR DELETE ON public.work_items
FOR EACH ROW EXECUTE FUNCTION kordos_search.enqueue('work');
CREATE TRIGGER search_document AFTER INSERT OR UPDATE OR DELETE ON public.documents
FOR EACH ROW EXECUTE FUNCTION kordos_search.enqueue('document');
CREATE TRIGGER search_decision AFTER INSERT OR UPDATE OR DELETE ON public.decisions
FOR EACH ROW EXECUTE FUNCTION kordos_search.enqueue('decision');
CREATE TRIGGER search_meeting AFTER INSERT OR UPDATE OF title, agenda, starts_at, transcript_revision OR DELETE ON public.meetings
FOR EACH ROW EXECUTE FUNCTION kordos_search.enqueue('meeting');
CREATE TRIGGER search_email AFTER INSERT OR UPDATE OR DELETE ON public.connector_shares
FOR EACH ROW EXECUTE FUNCTION kordos_search.enqueue('email');
CREATE TRIGGER search_github AFTER INSERT OR UPDATE OF revision, withdrawn_at OR DELETE ON public.source_objects
FOR EACH ROW EXECUTE FUNCTION kordos_search.enqueue_github();

CREATE FUNCTION kordos_search.refresh_github_audience() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.search_outbox (workspace_id,project_id,kind,source_id)
  SELECT s.workspace_id,s.project_id,'github',s.id
  FROM public.source_objects s JOIN public.connector_installations i
    ON (i.workspace_id,i.id) = (s.workspace_id,s.installation_id)
  WHERE s.workspace_id = NEW.workspace_id AND i.provider = 'github'
    AND CASE TG_TABLE_NAME WHEN 'connector_mappings' THEN s.mapping_id = NEW.id
      ELSE s.installation_id = NEW.id END
  ON CONFLICT (workspace_id,project_id,kind,source_id) DO UPDATE SET queued_at = excluded.queued_at;
  RETURN NULL;
END
$$;

CREATE TRIGGER search_github_mapping AFTER UPDATE OF audience, provider_audience, revoked_at ON public.connector_mappings
FOR EACH ROW WHEN (OLD.audience IS DISTINCT FROM NEW.audience OR OLD.provider_audience IS DISTINCT FROM NEW.provider_audience
  OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
EXECUTE FUNCTION kordos_search.refresh_github_audience();

CREATE TRIGGER search_github_disconnect AFTER UPDATE OF state ON public.connector_installations
FOR EACH ROW WHEN (NEW.provider = 'github' AND NEW.state = 'disconnected' AND OLD.state <> 'disconnected')
EXECUTE FUNCTION kordos_search.refresh_github_audience();

-- Identify the audience at ingest and use the live connector rules at read time.
CREATE FUNCTION kordos_search.github_audience(p_source uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN m.audience = 'project' AND m.provider_audience = 'project' THEN 'project' ELSE 'owner' END
  FROM public.source_objects s
  JOIN public.connector_mappings m ON (m.workspace_id,m.installation_id,m.id,m.project_id)
    = (s.workspace_id,s.installation_id,s.mapping_id,s.project_id)
  JOIN public.connector_installations i ON (i.workspace_id,i.id) = (m.workspace_id,m.installation_id)
  WHERE s.id = p_source AND i.provider = 'github'
$$;

CREATE VIEW kordos_search.sources AS
  SELECT w.workspace_id, w.project_id, 'work'::public.search_kind AS kind, w.id AS source_id,
    w.version AS revision, w.title, coalesce(w.description,'') AS body, w.owner_id,
    coalesce(u.name,'Unassigned') AS attribution,
    (e.created_at AT TIME ZONE 'UTC')::date AS attributed_date,
    NULL::text AS external_id, ARRAY[w.id::text] AS exact_ids, 'project'::text AS audience,
    NULL::jsonb AS segments, NULL::int AS transcript_revision
  FROM public.work_items w
  LEFT JOIN public.users u ON u.id = w.owner_id
  LEFT JOIN LATERAL (
    SELECT created_at FROM public.audit_events a
    WHERE (a.workspace_id,a.project_id,a.target_id) = (w.workspace_id,w.project_id,w.id)
      AND a.action LIKE 'work.%'
    ORDER BY created_at DESC LIMIT 1
  ) e ON true
  WHERE w.archived_at IS NULL
  UNION ALL
  SELECT d.workspace_id,d.project_id,'document',d.id,d.revision,v.title,v.content,v.author_id,u.name,
    (v.created_at AT TIME ZONE 'UTC')::date,NULL,ARRAY[d.id::text],'project',NULL,NULL
  FROM public.documents d JOIN public.document_versions v
    ON (v.workspace_id,v.project_id,v.document_id,v.revision)=(d.workspace_id,d.project_id,d.id,d.revision)
  JOIN public.users u ON u.id = v.author_id
  WHERE d.archived_at IS NULL
  UNION ALL
  SELECT d.workspace_id,d.project_id,'decision',d.id,d.version,d.question,d.conclusion,d.accountable_id,u.name,
    d.effective_date,NULL,ARRAY[d.id::text],'project',NULL,NULL
  FROM public.decisions d JOIN public.users u ON u.id = d.accountable_id
  WHERE d.confirmed_at IS NOT NULL
  UNION ALL
  SELECT m.workspace_id,m.project_id,'meeting',m.id,m.version,m.title,coalesce(m.agenda,''),
    m.organizer_id,u.name,(m.starts_at AT TIME ZONE m.time_zone)::date,NULL,ARRAY[m.id::text],'project',t.segments,m.transcript_revision
  FROM public.meetings m JOIN public.users u ON u.id = m.organizer_id
  LEFT JOIN public.meeting_transcripts t ON (t.workspace_id,t.project_id,t.meeting_id,t.revision)
    = (m.workspace_id,m.project_id,m.id,m.transcript_revision)
  UNION ALL
  SELECT s.workspace_id,s.project_id,'github',s.id,s.revision,r.title,coalesce(r.body,''),i.owner_id,
    r.github->>'repository',(r.observed_at AT TIME ZONE 'UTC')::date,
    (r.github->>'repository') || '#' || (r.github->>'number'),
    ARRAY[s.id::text,lower(s.external_id),lower(r.url),lower(r.github->>'nodeId'),
      lower((r.github->>'repository') || '#' || (r.github->>'number')), '#' || (r.github->>'number'),
      (CASE r.github->>'kind' WHEN 'pull' THEN 'pr:' ELSE 'issue:' END) || (r.github->>'number')],
    kordos_search.github_audience(s.id),NULL,NULL
  FROM public.source_objects s JOIN public.source_revisions r
    ON (r.workspace_id,r.project_id,r.source_id,r.revision) = (s.workspace_id,s.project_id,s.id,s.revision)
  JOIN public.connector_installations i ON (i.workspace_id,i.id) = (s.workspace_id,s.installation_id)
  JOIN public.connector_mappings m ON (m.workspace_id,m.installation_id,m.id,m.project_id)
    = (s.workspace_id,s.installation_id,s.mapping_id,s.project_id)
  WHERE s.withdrawn_at IS NULL AND i.provider = 'github' AND i.state <> 'disconnected'
    AND m.revoked_at IS NULL AND r.github IS NOT NULL AND r.title IS NOT NULL
  UNION ALL
  SELECT sh.workspace_id,sh.project_id,'email',sh.id,sh.revision,sh.title,sh.excerpt,sh.sharer_id,u.name,
    (sh.created_at AT TIME ZONE 'UTC')::date,NULL,ARRAY[sh.id::text],'project',NULL,NULL
  FROM public.connector_shares sh JOIN public.users u ON u.id = sh.sharer_id
  JOIN public.source_objects s ON (s.workspace_id,s.project_id,s.id) = (sh.workspace_id,sh.project_id,sh.source_id)
  JOIN public.connector_installations i ON (i.workspace_id,i.id) = (s.workspace_id,s.installation_id)
  WHERE sh.revoked_at IS NULL AND i.provider = 'gmail';

-- Existing sources use the same rebuild path as new writes.
INSERT INTO public.search_outbox (workspace_id,project_id,kind,source_id)
SELECT workspace_id,project_id,kind,source_id FROM kordos_search.sources;

CREATE FUNCTION kordos_search.spans(p_body text) RETURNS TABLE(first_char int,last_char int)
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  boundary int;
  whitespace int;
BEGIN
  first_char := 0;
  IF p_body = '' THEN
    last_char := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  WHILE first_char < char_length(p_body) LOOP
    last_char := least(first_char + 700, char_length(p_body));
    boundary := regexp_instr(p_body, E'\n[[:blank:]]*#{1,6}[[:blank:]]+', first_char + 2);
    IF boundary > first_char + 1 AND boundary <= last_char THEN
      last_char := boundary;
    ELSIF last_char < char_length(p_body) THEN
      whitespace := regexp_instr(reverse(substr(p_body, last_char - 119, 120)), '[[:space:]]');
      IF whitespace > 0 THEN last_char := last_char - whitespace + 1; END IF;
    END IF;
    RETURN NEXT;
    first_char := last_char;
  END LOOP;
END
$$;

CREATE FUNCTION kordos_search.rebuild() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  job public.search_outbox;
  processed int := 0;
BEGIN
  FOR job IN SELECT * FROM public.search_outbox ORDER BY queued_at,source_id LIMIT 16 FOR UPDATE SKIP LOCKED
  LOOP
    DELETE FROM public.search_chunks c WHERE (c.workspace_id,c.project_id,c.kind,c.source_id) =
      (job.workspace_id,job.project_id,job.kind,job.source_id);
    INSERT INTO public.search_chunks (
      workspace_id,project_id,kind,source_id,revision,ordinal,title,passage,attribution,
      attributed_date,owner_id,citation,external_id,exact_ids,audience
    )
    SELECT s.workspace_id,s.project_id,s.kind,s.source_id,s.revision,
      row_number() OVER (ORDER BY part.turn,span.first_char),s.title,
      substr(part.body,span.first_char+1,span.last_char-span.first_char),part.attribution,
      s.attributed_date,s.owner_id,
      CASE WHEN span.last_char > span.first_char AND (s.kind = 'document' OR part.segment_id IS NOT NULL)
        THEN jsonb_build_object('kind',s.kind,'projectId',s.project_id,'id',s.source_id,'anchor',
          jsonb_strip_nulls(jsonb_build_object('revision',coalesce(s.transcript_revision,s.revision),
            'start',span.first_char,
            'end',span.last_char,'segmentId',part.segment_id))) END,
      s.external_id,s.exact_ids,s.audience
    FROM kordos_search.sources s
    CROSS JOIN LATERAL (
      SELECT s.body, s.attribution, 0::bigint AS turn, NULL::text AS segment_id
      UNION ALL
      SELECT segment->>'text',coalesce(segment->>'speaker','Unknown speaker'),turn,segment->>'id'
      FROM jsonb_array_elements(s.segments) WITH ORDINALITY AS t(segment,turn)
    ) part
    CROSS JOIN LATERAL kordos_search.spans(part.body) span
    WHERE (s.workspace_id,s.project_id,s.kind,s.source_id) = (job.workspace_id,job.project_id,job.kind,job.source_id);
    DELETE FROM public.search_outbox WHERE (workspace_id,project_id,kind,source_id) =
      (job.workspace_id,job.project_id,job.kind,job.source_id);
    processed := processed + 1;
  END LOOP;
  RETURN processed;
END
$$;

-- Check live audience before provider calls. Owner-only connector text remains
-- available to its owner through lexical search without submitting it for embedding.
CREATE FUNCTION kordos_search.can_embed(c public.search_chunks) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT c.audience = 'project'
    AND EXISTS (SELECT FROM public.projects p WHERE (p.workspace_id,p.id)=(c.workspace_id,c.project_id)
      AND p.archived_at IS NULL)
    AND NOT EXISTS (SELECT FROM public.search_outbox o WHERE (o.workspace_id,o.project_id,o.kind,o.source_id)
      = (c.workspace_id,c.project_id,c.kind,c.source_id))
    AND (c.kind <> 'github' OR EXISTS (
      SELECT FROM public.source_objects s JOIN public.connector_mappings m
        ON (m.workspace_id,m.installation_id,m.id,m.project_id)=(s.workspace_id,s.installation_id,s.mapping_id,s.project_id)
      JOIN public.connector_installations i ON (i.workspace_id,i.id)=(s.workspace_id,s.installation_id)
      WHERE (s.workspace_id,s.project_id,s.id,s.revision)=(c.workspace_id,c.project_id,c.source_id,c.revision)
        AND s.withdrawn_at IS NULL AND m.revoked_at IS NULL AND m.verified_until > statement_timestamp()
        AND m.audience = 'project' AND m.provider_audience = 'project'
        AND i.state <> 'disconnected' AND i.issue IS DISTINCT FROM 'credential_revoked'
        AND kordos_connectors.owner_authorized(i,m)
    ))
$$;

CREATE FUNCTION kordos_search.claim_embeddings(p_model text, p_lease uuid)
RETURNS TABLE(id uuid, title text, passage text, embedding_lease uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH due AS (
    (SELECT c.id,c.embed_after FROM public.search_chunks c
      WHERE c.audience = 'project' AND c.model IS NULL AND c.embed_after <= statement_timestamp()
        AND kordos_search.can_embed(c)
      ORDER BY c.embed_after,c.id LIMIT 12)
    UNION ALL
    (SELECT c.id,c.embed_after FROM public.search_chunks c
      WHERE c.audience = 'project' AND c.model < p_model AND c.embed_after <= statement_timestamp()
        AND kordos_search.can_embed(c)
      ORDER BY c.model,c.embed_after,c.id LIMIT 12)
    UNION ALL
    (SELECT c.id,c.embed_after FROM public.search_chunks c
      WHERE c.audience = 'project' AND c.model > p_model AND c.embed_after <= statement_timestamp()
        AND kordos_search.can_embed(c)
      ORDER BY c.model,c.embed_after,c.id LIMIT 12)
  ), batch AS (
    SELECT c.id FROM due d JOIN public.search_chunks c ON c.id = d.id
    WHERE c.model IS DISTINCT FROM p_model AND c.embed_after <= statement_timestamp()
    ORDER BY d.embed_after,c.id LIMIT 12 FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE public.search_chunks c SET embedding_lease = p_lease, embed_after = statement_timestamp() + interval '1 minute'
  FROM batch b WHERE c.id = b.id
  RETURNING c.id,c.title,c.passage,c.embedding_lease
$$;

CREATE FUNCTION kordos_search.finish_embedding(p_id uuid,p_lease uuid,p_model text,p_vector public.vector)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE public.search_chunks c SET embedding = p_vector, model = p_model, embedding_lease = NULL
  WHERE c.id = p_id AND c.embedding_lease = p_lease AND kordos_search.can_embed(c)
$$;

CREATE FUNCTION kordos_search.allowed(p_project uuid,p_kind public.search_kind,p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_kind
    WHEN 'github' THEN EXISTS (
      SELECT FROM public.source_objects s
      WHERE (s.workspace_id,s.project_id,s.id)=(kordos_identity.workspace_id(),p_project,p_id)
        AND kordos_connectors.mirror_allowed(s)
    )
    WHEN 'email' THEN EXISTS (
      SELECT FROM public.connector_shares s
      WHERE (s.workspace_id,s.project_id,s.id)=(kordos_identity.workspace_id(),p_project,p_id) AND s.revoked_at IS NULL
    )
    ELSE true
  END
$$;

CREATE FUNCTION kordos_search.query(p_input jsonb,p_exact text,p_model text,p_vector public.vector)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH projects AS MATERIALIZED (
    SELECT p.id,p.name FROM public.projects p WHERE p.workspace_id = kordos_identity.workspace_id()
      AND p.archived_at IS NULL AND kordos_planning.project_access(p.id) IS NOT NULL
      AND (p_input->>'project' IS NULL OR p.id = (p_input->>'project')::uuid)
  ), filters AS (
    SELECT websearch_to_tsquery('english',p_input->>'q') AS terms,(p_input->>'type')::public.search_kind AS kind,
      (p_input->>'owner')::uuid AS owner,(p_input->>'from')::date AS since,(p_input->>'to')::date AS until
  ), candidate AS NOT MATERIALIZED (
    SELECT c.*,p.name AS project,f.terms AS query_terms
    FROM public.search_chunks c JOIN projects p ON p.id = c.project_id CROSS JOIN filters f
    WHERE c.workspace_id = kordos_identity.workspace_id()
      AND (f.kind IS NULL OR c.kind = f.kind) AND (f.owner IS NULL OR c.owner_id = f.owner)
      AND (f.since IS NULL OR c.attributed_date >= f.since)
      AND (f.until IS NULL OR c.attributed_date <= f.until)
      AND kordos_search.allowed(c.project_id,c.kind,c.source_id)
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
  ), distances AS MATERIALIZED (
    SELECT id,kind,source_id,ordinal,embedding OPERATOR(public.<=>) p_vector AS distance
    FROM candidate WHERE p_exact IS NULL AND p_vector IS NOT NULL AND model = p_model AND embedding IS NOT NULL
      AND (kind <> 'github' OR kordos_search.github_audience(source_id) = 'project')
  ), vector_best AS (
    SELECT DISTINCT ON (kind,source_id) id,kind,source_id,distance FROM distances WHERE distance <= 0.65
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
    'mode',CASE WHEN p_exact IS NOT NULL THEN 'exact' WHEN EXISTS (SELECT FROM distances) THEN 'hybrid' ELSE 'lexical' END
  ) WHERE kordos_identity.current_role() IS NOT NULL
    AND (p_input->>'project' IS NULL OR EXISTS (SELECT FROM projects))
$$;

CREATE FUNCTION kordos_search.owners() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH projects AS MATERIALIZED (
    SELECT p.id FROM public.projects p
    WHERE p.workspace_id = kordos_identity.workspace_id() AND p.archived_at IS NULL
      AND kordos_planning.project_access(p.id) IS NOT NULL
  ), owners AS (
    SELECT DISTINCT c.owner_id FROM public.search_chunks c JOIN projects p ON p.id = c.project_id
    WHERE c.workspace_id = kordos_identity.workspace_id() AND c.owner_id IS NOT NULL
      AND kordos_search.allowed(c.project_id,c.kind,c.source_id)
      AND NOT EXISTS (SELECT FROM public.search_outbox o WHERE (o.workspace_id,o.project_id,o.kind,o.source_id)
        = (c.workspace_id,c.project_id,c.kind,c.source_id))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) ORDER BY u.name,u.id),'[]')
  FROM owners JOIN public.users u ON u.id = owners.owner_id
  HAVING kordos_identity.current_role() IS NOT NULL
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA kordos_search FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_search.query(jsonb,text,text,public.vector), kordos_search.owners() TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_search.rebuild(),
  kordos_search.claim_embeddings(text,uuid),
  kordos_search.finish_embedding(uuid,uuid,text,public.vector) TO kordos_brief_worker;
