CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"question" text NOT NULL,
	"conclusion" text NOT NULL,
	"accountable_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"evidence" jsonb NOT NULL,
	"supersedes_id" uuid,
	"author_id" uuid NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "decisions_scope_unique" UNIQUE("workspace_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "document_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "document_attachments_mutation_unique" UNIQUE("workspace_id","actor_id","mutation_id")
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"base_revision" integer,
	"restored_from" integer,
	CONSTRAINT "document_versions_workspace_id_project_id_document_id_revision_pk" PRIMARY KEY("workspace_id","project_id","document_id","revision")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "documents_scope_unique" UNIQUE("workspace_id","project_id","id")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "anchor" jsonb;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_accountable_fk" FOREIGN KEY ("workspace_id","accountable_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_author_fk" FOREIGN KEY ("workspace_id","author_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_confirmer_fk" FOREIGN KEY ("workspace_id","confirmed_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_supersedes_fk" FOREIGN KEY ("workspace_id","project_id","supersedes_id") REFERENCES "public"."decisions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_document_fk" FOREIGN KEY ("workspace_id","project_id","document_id") REFERENCES "public"."documents"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_fk" FOREIGN KEY ("workspace_id","project_id","document_id") REFERENCES "public"."documents"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_author_fk" FOREIGN KEY ("workspace_id","author_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_base_fk" FOREIGN KEY ("workspace_id","project_id","document_id","base_revision") REFERENCES "public"."document_versions"("workspace_id","project_id","document_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_restore_fk" FOREIGN KEY ("workspace_id","project_id","document_id","restored_from") REFERENCES "public"."document_versions"("workspace_id","project_id","document_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_project_date_idx" ON "decisions" USING btree ("workspace_id","project_id","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_one_successor_idx" ON "decisions" USING btree ("workspace_id","project_id","supersedes_id") WHERE confirmed_at IS NOT NULL AND supersedes_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "document_attachments_document_idx" ON "document_attachments" USING btree ("workspace_id","project_id","document_id");
--> statement-breakpoint
CREATE SCHEMA kordos_knowledge;
REVOKE ALL ON SCHEMA kordos_knowledge FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_knowledge TO kordos_app;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_read ON public.documents FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND kordos_planning.project_access(project_id) IS NOT NULL
);
CREATE POLICY document_versions_read ON public.document_versions FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND kordos_planning.project_access(project_id) IS NOT NULL
);
GRANT SELECT ON public.documents, public.document_versions TO kordos_app;

CREATE OR REPLACE FUNCTION kordos_collaboration.subject_open(p_project uuid, p_kind text, p_subject uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_kind = 'project' AND p_subject = p_project THEN p.archived_at IS NULL
    WHEN p_kind = 'task' AND w.id IS NOT NULL THEN p.archived_at IS NULL AND w.archived_at IS NULL
    WHEN p_kind = 'document' AND d.id IS NOT NULL THEN p.archived_at IS NULL AND d.archived_at IS NULL
  END
  FROM public.projects p
  LEFT JOIN public.work_items w ON p_kind = 'task'
    AND (w.workspace_id, w.project_id, w.id) = (p.workspace_id, p.id, p_subject)
  LEFT JOIN public.documents d ON p_kind = 'document'
    AND (d.workspace_id, d.project_id, d.id) = (p.workspace_id, p.id, p_subject)
  WHERE p.workspace_id = kordos_identity.workspace_id() AND p.id = p_project
    AND kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE FUNCTION kordos_knowledge.citation(p_source jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  project uuid := (p_source->>'projectId')::uuid;
  target uuid := (p_source->>'id')::uuid;
  anchor jsonb := p_source->'anchor';
  anchor_revision integer := (anchor->>'revision')::integer;
  first_char integer := (anchor->>'start')::integer;
  last_char integer := (anchor->>'end')::integer;
  value jsonb;
BEGIN
  IF kordos_planning.project_access(project) IS NULL THEN RETURN NULL; END IF;
  CASE p_source->>'kind'
    WHEN 'document' THEN
      SELECT jsonb_build_object('source', p_source, 'title', v.title,
        'excerpt', substring(v.content FROM first_char + 1 FOR last_char - first_char),
        'author', kordos_collaboration.person(v.author_id), 'capturedAt', v.created_at,
        'newer', d.revision > v.revision)
      INTO value
      FROM public.documents d JOIN public.document_versions v
        ON (v.workspace_id, v.project_id, v.document_id) = (d.workspace_id, d.project_id, d.id)
      WHERE (d.workspace_id, d.project_id, d.id) = (tenant, project, target)
        AND v.revision = anchor_revision AND first_char >= 0
        AND last_char > first_char AND last_char <= char_length(v.content)
        AND last_char - first_char <= 2000;
    WHEN 'comment' THEN
      SELECT jsonb_build_object('source', p_source, 'title', 'Comment', 'excerpt', c.body,
        'author', kordos_collaboration.person(c.author_id), 'capturedAt', coalesce(c.edited_at, c.created_at),
        'newer', false, 'subject', jsonb_build_object('kind', c.subject_kind, 'id', c.subject_id))
      INTO value
      FROM public.comments c
      WHERE (c.workspace_id, c.project_id, c.id) = (tenant, project, target)
        AND kordos_collaboration.subject_open(project, c.subject_kind, c.subject_id) IS NOT NULL;
    ELSE
      RETURN NULL;
  END CASE;
  RETURN value;
END
$$;

CREATE FUNCTION kordos_knowledge.open_write(p_project uuid, p_mutation uuid, p_lead boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE
  writable boolean;
  access public.project_role;
BEGIN
  access := kordos_planning.project_access(p_project);
  IF access IS NULL OR access = 'viewer' OR (p_lead AND access <> 'lead') THEN
    RETURN 'unavailable';
  END IF;
  PERFORM kordos_planning.lock_workspace(p_mutation);
  SELECT archived_at IS NULL INTO writable
    FROM public.projects WHERE (workspace_id, id) = (kordos_identity.workspace_id(), p_project) FOR UPDATE;
  access := kordos_planning.project_access(p_project);
  IF access IS NULL OR access = 'viewer' OR (p_lead AND access <> 'lead') THEN
    RETURN 'unavailable';
  END IF;
  IF writable IS DISTINCT FROM true THEN RETURN 'invalid_state'; END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION kordos_knowledge.revision_view(p public.document_versions, p_content boolean)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('revision', p.revision, 'title', p.title,
    'author', kordos_collaboration.person(p.author_id), 'createdAt', p.created_at,
    'baseRevision', p.base_revision, 'restoredFrom', p.restored_from)
    || CASE WHEN p_content THEN jsonb_build_object('content', p.content) ELSE '{}'::jsonb END
$$;

CREATE FUNCTION kordos_knowledge.documents(p_project uuid, p_archived boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT CASE WHEN kordos_planning.project_access(p_project) IS NOT NULL THEN (
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'title', v.title,
      'revision', d.revision, 'version', d.version, 'archivedAt', d.archived_at)
      ORDER BY v.title, d.id), '[]')
    FROM public.documents d JOIN public.document_versions v
      ON (v.workspace_id, v.project_id, v.document_id, v.revision) = (d.workspace_id, d.project_id, d.id, d.revision)
    WHERE (d.workspace_id, d.project_id) = (kordos_identity.workspace_id(), p_project)
      AND (d.archived_at IS NOT NULL) = p_archived
  ) END
$$;

CREATE FUNCTION kordos_knowledge.document(p_project uuid, p_document uuid, p_revision integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', d.id, 'title', v.title, 'revision', d.revision,
    'version', d.version, 'archivedAt', d.archived_at, 'entry', kordos_knowledge.revision_view(v, true),
    'history', (SELECT jsonb_agg(kordos_knowledge.revision_view(h, false) ORDER BY h.revision DESC)
      FROM public.document_versions h
      WHERE (h.workspace_id, h.project_id, h.document_id) = (d.workspace_id, d.project_id, d.id)),
    'attachments', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'size', a.size)
      ORDER BY a.created_at, a.id), '[]') FROM public.document_attachments a
      WHERE (a.workspace_id, a.project_id, a.document_id) = (d.workspace_id, d.project_id, d.id) AND a.ready_at IS NOT NULL))
  FROM public.documents d JOIN public.document_versions v
    ON (v.workspace_id, v.project_id, v.document_id, v.revision) =
      (d.workspace_id, d.project_id, d.id, coalesce(p_revision, d.revision))
  WHERE (d.workspace_id, d.project_id, d.id) = (kordos_identity.workspace_id(), p_project, p_document)
    AND kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE FUNCTION kordos_knowledge.save_document(p_project uuid, p_document uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  action text := p_input->>'action';
  request jsonb := p_input || jsonb_build_object('_command', 'document');
  problem text;
  repeated jsonb;
  previous public.documents;
  updated public.documents;
  restored public.document_versions;
  event_kind text;
BEGIN
  problem := kordos_knowledge.open_write(p_project, (p_input->>'mutationId')::uuid);
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('result', problem); END IF;
  repeated := kordos_planning.replay(request, p_project, p_document);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;

  IF action = 'create' AND p_document IS NULL THEN
    INSERT INTO public.documents (workspace_id, project_id) VALUES (tenant, p_project) RETURNING * INTO updated;
    event_kind := 'document.created';
  ELSE
    SELECT * INTO previous FROM public.documents
      WHERE (workspace_id, project_id, id) = (tenant, p_project, p_document);
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
    IF previous.version IS DISTINCT FROM (p_input->>'expectedVersion')::integer THEN
      RETURN jsonb_build_object('result', 'conflict', 'current', kordos_knowledge.document(p_project, p_document, NULL));
    END IF;
    IF previous.archived_at IS NOT NULL OR action NOT IN ('save', 'restore', 'archive') THEN
      RETURN jsonb_build_object('result', 'invalid_state');
    END IF;
    IF action = 'restore' THEN
      SELECT * INTO restored FROM public.document_versions
        WHERE (workspace_id, project_id, document_id, revision) =
          (tenant, p_project, p_document, (p_input->>'revision')::integer)
          AND revision < previous.revision;
      IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
    END IF;
    UPDATE public.documents SET version = version + 1,
      revision = CASE WHEN action = 'archive' THEN revision ELSE revision + 1 END,
      archived_at = CASE WHEN action = 'archive' THEN clock_timestamp() END
      WHERE id = p_document RETURNING * INTO updated;
    event_kind := CASE action WHEN 'archive' THEN 'document.archived'
      WHEN 'restore' THEN 'document.restored' ELSE 'document.revised' END;
  END IF;
  IF action <> 'archive' THEN
    INSERT INTO public.document_versions (workspace_id, project_id, document_id, revision,
      title, content, author_id, created_at, base_revision, restored_from)
    VALUES (tenant, p_project, updated.id, updated.revision, coalesce(restored.title, p_input->>'title'),
      coalesce(restored.content, p_input->>'content'), actor, clock_timestamp(), previous.revision, restored.revision);
  END IF;
  PERFORM kordos_planning.emit(p_project, updated.id, event_kind, request,
    to_jsonb(previous), to_jsonb(updated));
  RETURN jsonb_build_object('result', 'saved', 'id', updated.id);
END
$$;

CREATE FUNCTION kordos_knowledge.decision_view(p public.decisions, p_detail boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', p.id, 'question', p.question,
    'accountable', kordos_collaboration.person(p.accountable_id), 'effectiveDate', p.effective_date,
    'author', kordos_collaboration.person(p.author_id), 'confirmedAt', p.confirmed_at,
    'confirmedBy', kordos_collaboration.person(p.confirmed_by), 'supersedesId', p.supersedes_id,
    'supersededById', newer.id, 'supersededOn', newer.effective_date, 'version', p.version)
    || CASE WHEN p_detail THEN jsonb_build_object('conclusion', p.conclusion,
      'evidence', (SELECT coalesce(jsonb_agg(visible.quote ORDER BY e.position), '[]')
        FROM jsonb_array_elements(p.evidence) WITH ORDINALITY e(source, position)
        CROSS JOIN LATERAL kordos_knowledge.citation(e.source) AS visible(quote)
        WHERE visible.quote IS NOT NULL))
    ELSE '{}'::jsonb END
  FROM (SELECT 1) row
  LEFT JOIN public.decisions newer ON (newer.workspace_id, newer.project_id, newer.supersedes_id) =
    (p.workspace_id, p.project_id, p.id) AND newer.confirmed_at IS NOT NULL
$$;

CREATE FUNCTION kordos_knowledge.decisions(p_project uuid, p_decision uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH access AS (SELECT kordos_planning.project_access(p_project) AS role),
  visible AS (
    SELECT d FROM public.decisions d, access
    WHERE (d.workspace_id, d.project_id) = (kordos_identity.workspace_id(), p_project)
      AND access.role IS NOT NULL AND (d.confirmed_at IS NOT NULL OR access.role IN ('contributor', 'lead'))
  )
  SELECT CASE WHEN p_decision IS NOT NULL THEN (
    SELECT kordos_knowledge.decision_view(d, true) FROM visible WHERE (d).id = p_decision
  ) WHEN access.role IS NOT NULL THEN jsonb_build_object(
    'items', (SELECT coalesce(jsonb_agg(kordos_knowledge.decision_view(d, false)
      ORDER BY (d).effective_date DESC, (d).id), '[]') FROM visible),
    'people', CASE WHEN access.role IN ('contributor', 'lead') THEN (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name, id), '[]')
      FROM kordos_collaboration.people(p_project)
    ) ELSE '[]'::jsonb END
  ) END FROM access
$$;

CREATE FUNCTION kordos_knowledge.save_decision(p_project uuid, p_decision uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  action text := p_input->>'action';
  request jsonb := p_input || jsonb_build_object('_command', 'decision');
  problem text;
  repeated jsonb;
  previous public.decisions;
  updated public.decisions;
  predecessor uuid;
  effective date;
  accountable uuid;
  sources jsonb;
BEGIN
  problem := kordos_knowledge.open_write(p_project, (p_input->>'mutationId')::uuid, action = 'confirm');
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('result', problem); END IF;
  repeated := kordos_planning.replay(request, p_project, p_decision);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;
  IF action NOT IN ('draft', 'edit', 'confirm')
    OR (action = 'draft') IS DISTINCT FROM (p_decision IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;
  IF p_decision IS NOT NULL THEN
    SELECT * INTO previous FROM public.decisions
      WHERE (workspace_id, project_id, id) = (tenant, p_project, p_decision);
    IF NOT FOUND OR (action = 'edit' AND previous.author_id <> actor AND kordos_planning.project_access(p_project) <> 'lead') THEN
      RETURN jsonb_build_object('result', 'unavailable');
    END IF;
    IF previous.version IS DISTINCT FROM (p_input->>'expectedVersion')::integer THEN
      RETURN jsonb_build_object('result', 'conflict');
    END IF;
    IF previous.confirmed_at IS NOT NULL THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;
  END IF;

  predecessor := CASE WHEN action = 'confirm' THEN previous.supersedes_id ELSE (p_input->>'supersedesId')::uuid END;
  effective := CASE WHEN action = 'confirm' THEN previous.effective_date ELSE (p_input->>'effectiveDate')::date END;
  accountable := CASE WHEN action = 'confirm' THEN previous.accountable_id ELSE (p_input->>'accountableId')::uuid END;
  sources := CASE WHEN action = 'confirm' THEN previous.evidence ELSE p_input->'evidence' END;
  IF NOT EXISTS (SELECT 1 FROM kordos_collaboration.people(p_project) WHERE id = accountable)
    OR jsonb_array_length(sources) NOT BETWEEN 1 AND 12
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(sources) source WHERE kordos_knowledge.citation(source) IS NULL) THEN
    RETURN jsonb_build_object('result', 'invalid_reference');
  END IF;
  IF predecessor IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM public.decisions p WHERE (p.workspace_id, p.project_id, p.id) = (tenant, p_project, predecessor)
      AND p.confirmed_at IS NOT NULL AND p.effective_date <= effective)
    OR EXISTS (SELECT 1 FROM public.decisions n WHERE (n.workspace_id, n.project_id, n.supersedes_id) = (tenant, p_project, predecessor)
      AND n.confirmed_at IS NOT NULL)
  ) THEN RETURN jsonb_build_object('result', 'invalid_reference'); END IF;

  CASE action
    WHEN 'draft' THEN
      INSERT INTO public.decisions (workspace_id, project_id, question, conclusion, accountable_id,
        effective_date, evidence, supersedes_id, author_id)
      VALUES (tenant, p_project, p_input->>'question', p_input->>'conclusion', accountable,
        effective, sources, predecessor, actor) RETURNING * INTO updated;
    WHEN 'edit' THEN
      UPDATE public.decisions SET question = p_input->>'question', conclusion = p_input->>'conclusion',
        accountable_id = accountable, effective_date = effective, evidence = sources, supersedes_id = predecessor,
        version = version + 1 WHERE id = p_decision RETURNING * INTO updated;
    WHEN 'confirm' THEN
      UPDATE public.decisions SET confirmed_at = clock_timestamp(), confirmed_by = actor, version = version + 1
        WHERE id = p_decision RETURNING * INTO updated;
  END CASE;
  -- The destination project's audit history must not contain private source references.
  PERFORM kordos_planning.emit(p_project, updated.id, 'decision.' || action, request,
    CASE WHEN previous.id IS NOT NULL THEN jsonb_build_object('version', previous.version) END,
    jsonb_build_object('version', updated.version));
  RETURN jsonb_build_object('result', 'saved', 'id', updated.id);
END
$$;

CREATE FUNCTION kordos_knowledge.attachment_key(p public.document_attachments) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT concat_ws('/', 'attachments', p.workspace_id, p.project_id, p.document_id, p.id)
$$;

CREATE FUNCTION kordos_knowledge.attachment(p_project uuid, p_document uuid, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('key', kordos_knowledge.attachment_key(a), 'name', a.name, 'size', a.size)
  FROM public.document_attachments a
  WHERE (a.workspace_id, a.project_id, a.document_id, a.id) =
    (kordos_identity.workspace_id(), p_project, p_document, p_id)
    AND a.ready_at IS NOT NULL AND kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE FUNCTION kordos_knowledge.upload(p_project uuid, p_document uuid, p_input jsonb, p_finish boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  request jsonb := p_input || jsonb_build_object('_command', 'attachment', 'documentId', p_document);
  problem text;
  repeated jsonb;
  found_attachment public.document_attachments;
  writable boolean;
BEGIN
  problem := kordos_knowledge.open_write(p_project, mutation);
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('result', problem); END IF;
  repeated := kordos_planning.replay(request, p_project, NULL);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;
  SELECT archived_at IS NULL INTO writable FROM public.documents
    WHERE (workspace_id, project_id, id) = (tenant, p_project, p_document);
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  IF NOT writable THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;
  SELECT * INTO found_attachment FROM public.document_attachments
    WHERE (workspace_id, actor_id, mutation_id) = (tenant, actor, mutation);
  IF FOUND THEN
    IF (found_attachment.project_id, found_attachment.document_id, found_attachment.name, found_attachment.size, found_attachment.digest)
      IS DISTINCT FROM (p_project, p_document, p_input->>'name', (p_input->>'size')::integer, p_input->>'digest') THEN
      RETURN jsonb_build_object('result', 'mutation_conflict');
    END IF;
  ELSIF p_finish THEN
    RETURN jsonb_build_object('result', 'unavailable');
  ELSE
    INSERT INTO public.document_attachments (workspace_id, project_id, document_id, actor_id, mutation_id, name, size, digest)
    VALUES (tenant, p_project, p_document, actor, mutation, p_input->>'name', (p_input->>'size')::integer, p_input->>'digest')
    RETURNING * INTO found_attachment;
  END IF;
  IF NOT p_finish THEN
    RETURN jsonb_build_object('result', 'pending', 'key', kordos_knowledge.attachment_key(found_attachment));
  END IF;
  UPDATE public.document_attachments SET ready_at = clock_timestamp() WHERE id = found_attachment.id;
  PERFORM kordos_planning.emit(p_project, found_attachment.id, 'document.attachment_added', request, NULL,
    jsonb_build_object('documentId', p_document, 'name', found_attachment.name, 'size', found_attachment.size));
  RETURN jsonb_build_object('result', 'saved', 'id', found_attachment.id);
END
$$;

CREATE OR REPLACE FUNCTION kordos_collaboration.snapshot(
  p_project uuid, p_kind text, p_subject uuid, p_before uuid
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH access AS (
    SELECT kordos_collaboration.subject_open(p_project, p_kind, p_subject) AS writable,
      kordos_planning.project_access(p_project) AS role
  ), subject AS NOT MATERIALIZED (
    SELECT * FROM public.comments c WHERE (c.workspace_id, c.project_id, c.subject_kind, c.subject_id)
      = (kordos_identity.workspace_id(), p_project, p_kind, p_subject)
  ), roots AS (
    SELECT c.id, c.created_at FROM subject c WHERE c.parent_id IS NULL
    AND (p_before IS NULL OR (c.created_at, c.id) < (
      SELECT b.created_at, b.id FROM subject b WHERE b.id = p_before AND b.parent_id IS NULL
    ))
    ORDER BY c.created_at DESC, c.id DESC LIMIT 41
  ), page AS (
    SELECT * FROM roots ORDER BY created_at DESC, id DESC LIMIT 40
  ), entries AS (
    SELECT c.* FROM page p JOIN subject c ON c.id = p.id OR c.parent_id = p.id
  )
  SELECT jsonb_build_object(
    'cursor', coalesce((SELECT max(o.comment_sequence)::text FROM public.outbox o
      WHERE o.workspace_id = kordos_identity.workspace_id() AND o.project_id = p_project
        AND o.comment_sequence IS NOT NULL
        AND o.request->'subject' = jsonb_build_object('kind', p_kind, 'id', p_subject)), '0'),
    'older', CASE WHEN (SELECT count(*) FROM roots) > 40 THEN
      (SELECT id FROM page ORDER BY created_at, id LIMIT 1) END,
    'canPost', access.writable AND access.role IN ('contributor', 'lead'),
    'canModerate', access.writable AND access.role = 'lead',
    'people', CASE WHEN access.writable AND access.role IN ('contributor', 'lead') THEN (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name, id), '[]')
      FROM kordos_collaboration.people(p_project)
    ) ELSE '[]'::jsonb END,
    'items', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'mutationId', c.mutation_id, 'parentId', c.parent_id,
      'body', c.body, 'anchor', c.anchor, 'version', c.version, 'createdAt', c.created_at, 'editedAt', c.edited_at,
      'resolvedAt', c.resolved_at, 'resolvedBy', kordos_collaboration.person(c.resolved_by),
      'author', kordos_collaboration.person(c.author_id),
      'mentions', coalesce((SELECT jsonb_agg(kordos_collaboration.person(m.id) ORDER BY m.ordinality)
        FROM unnest(c.mention_ids) WITH ORDINALITY m(id, ordinality)), '[]')
    ) ORDER BY c.created_at, c.id), '[]') FROM entries c)
  ) FROM access WHERE access.writable IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION kordos_collaboration.save(
  p_project uuid, p_kind text, p_subject uuid, p_input jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  action text := p_input->>'action';
  target uuid := (p_input->>'commentId')::uuid;
  parent uuid := (p_input->>'parentId')::uuid;
  subject jsonb := jsonb_build_object('kind', p_kind, 'id', p_subject);
  request jsonb := p_input || jsonb_build_object('_command', 'comment', 'subject', subject);
  anchor jsonb := p_input->'anchor';
  access public.project_role;
  mentions uuid[];
  previous public.comments;
  updated public.comments;
  repeated jsonb;
  event_kind text;
BEGIN
  IF kordos_collaboration.subject_open(p_project, p_kind, p_subject) IS NULL
    OR kordos_planning.project_access(p_project) = 'viewer' THEN
    RETURN jsonb_build_object('result', 'unavailable');
  END IF;
  PERFORM kordos_planning.lock_workspace(mutation);
  -- Serialize comment sequence allocation and permission changes within the project.
  PERFORM 1 FROM public.projects WHERE workspace_id = tenant AND id = p_project FOR UPDATE;
  access := kordos_planning.project_access(p_project);
  IF access IS NULL OR access = 'viewer'
    OR kordos_collaboration.subject_open(p_project, p_kind, p_subject) IS NULL THEN
    RETURN jsonb_build_object('result', 'unavailable');
  END IF;
  repeated := kordos_planning.replay(request, p_project, target);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;
  IF NOT kordos_collaboration.subject_open(p_project, p_kind, p_subject) THEN
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;

  IF action IN ('post', 'edit') THEN
    mentions := ARRAY(SELECT jsonb_array_elements_text(p_input->'mentionIds')::uuid);
    IF EXISTS (SELECT unnest(mentions) EXCEPT SELECT id FROM kordos_collaboration.people(p_project)) THEN
      RETURN jsonb_build_object('result', 'invalid_mention');
    END IF;
  END IF;

  IF action = 'post' THEN
    IF anchor IS NOT NULL AND (p_kind <> 'document' OR parent IS NOT NULL
      OR kordos_knowledge.citation(jsonb_build_object('kind', 'document', 'projectId', p_project,
        'id', p_subject, 'anchor', anchor)) IS NULL) THEN
      RETURN jsonb_build_object('result', 'invalid_anchor');
    END IF;
    IF parent IS NOT NULL THEN
      SELECT * INTO previous FROM public.comments c
        WHERE (c.workspace_id, c.project_id, c.subject_kind, c.subject_id, c.id)
          = (tenant, p_project, p_kind, p_subject, parent) AND c.parent_id IS NULL;
      IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
      IF previous.resolved_at IS NOT NULL THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;
    END IF;
    INSERT INTO public.comments (
      workspace_id, project_id, subject_kind, subject_id, work_id,
      parent_id, author_id, mutation_id, body, mention_ids, anchor
    ) VALUES (
      tenant, p_project, p_kind, p_subject, CASE WHEN p_kind = 'task' THEN p_subject END,
      parent, actor, mutation, p_input->>'body', mentions, anchor
    ) RETURNING * INTO updated;
    previous := NULL;
    event_kind := 'comment.posted';
  ELSE
    SELECT * INTO previous FROM public.comments c
      WHERE (c.workspace_id, c.project_id, c.subject_kind, c.subject_id, c.id)
        = (tenant, p_project, p_kind, p_subject, target);
    IF NOT FOUND OR (previous.author_id <> actor AND (action = 'edit' OR access <> 'lead')) THEN
      RETURN jsonb_build_object('result', 'unavailable');
    END IF;
    IF previous.version IS DISTINCT FROM (p_input->>'expectedVersion')::integer THEN
      RETURN jsonb_build_object('result', 'conflict');
    END IF;
    IF action = 'edit' THEN
      UPDATE public.comments SET body = p_input->>'body', mention_ids = mentions,
        edited_at = clock_timestamp(), version = version + 1
      WHERE id = target RETURNING * INTO updated;
      event_kind := 'comment.edited';
    ELSIF action IN ('resolve', 'reopen') AND previous.parent_id IS NULL
      AND (previous.resolved_at IS NULL) = (action = 'resolve') THEN
      UPDATE public.comments SET resolved_at = CASE WHEN action = 'resolve' THEN clock_timestamp() END,
        resolved_by = CASE WHEN action = 'resolve' THEN actor END, version = version + 1
      WHERE id = target RETURNING * INTO updated;
      event_kind := CASE WHEN action = 'resolve' THEN 'comment.resolved' ELSE 'comment.reopened' END;
    ELSE
      RETURN jsonb_build_object('result', 'invalid_state');
    END IF;
  END IF;

  PERFORM kordos_planning.emit(p_project, updated.id, event_kind, request,
    to_jsonb(previous), to_jsonb(updated));
  UPDATE public.outbox SET comment_sequence = (
    SELECT coalesce(max(o.comment_sequence), 0) + 1 FROM public.outbox o
    WHERE o.workspace_id = tenant AND o.project_id = p_project AND o.comment_sequence IS NOT NULL
      AND o.request->'subject' = subject
  )
    WHERE workspace_id = tenant AND actor_id = actor AND mutation_id = mutation;
  PERFORM pg_notify('kordos_collaboration', '');
  RETURN jsonb_build_object('result', 'saved', 'id', updated.id);
END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_knowledge FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_knowledge.citation(jsonb),
  kordos_knowledge.documents(uuid, boolean), kordos_knowledge.document(uuid, uuid, integer),
  kordos_knowledge.save_document(uuid, uuid, jsonb), kordos_knowledge.decisions(uuid, uuid),
  kordos_knowledge.save_decision(uuid, uuid, jsonb), kordos_knowledge.attachment(uuid, uuid, uuid),
  kordos_knowledge.upload(uuid, uuid, jsonb, boolean) TO kordos_app;
