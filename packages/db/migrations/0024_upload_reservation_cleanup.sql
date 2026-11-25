ALTER TABLE "document_attachments" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "document_attachments_cleanup_idx" ON "document_attachments" USING btree ("created_at","id") WHERE "document_attachments"."ready_at" IS NULL AND "document_attachments"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION kordos_meetings.abort_upload(p_project uuid, p_id uuid, p_mutation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  m public.meetings;
BEGIN
  IF kordos_knowledge.open_write(p_project, p_mutation) IS NOT NULL THEN RETURN; END IF;
  SELECT * INTO m FROM public.meetings WHERE (workspace_id, project_id, id) = (tenant, p_project, p_id);
  IF NOT FOUND OR NOT kordos_meetings.manage(m) THEN RETURN; END IF;
  UPDATE public.meeting_media SET removed_at = clock_timestamp()
    WHERE (workspace_id, actor_id, mutation_id) = (tenant, actor, p_mutation)
      AND project_id = p_project AND meeting_id = p_id
      AND available_at IS NULL AND removed_at IS NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kordos_knowledge.attachment(p_project uuid, p_document uuid, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('key', kordos_knowledge.attachment_key(a), 'name', a.name, 'size', a.size)
  FROM public.document_attachments a
  WHERE (a.workspace_id, a.project_id, a.document_id, a.id) =
    (kordos_identity.workspace_id(), p_project, p_document, p_id)
    AND a.ready_at IS NOT NULL AND a.removed_at IS NULL AND kordos_planning.project_access(p_project) IS NOT NULL
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kordos_knowledge.document(p_project uuid, p_document uuid, p_revision integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', d.id, 'title', v.title, 'revision', d.revision,
    'version', d.version, 'archivedAt', d.archived_at, 'entry', kordos_knowledge.revision_view(v, true),
    'history', (SELECT jsonb_agg(kordos_knowledge.revision_view(h, false) ORDER BY h.revision DESC)
      FROM public.document_versions h
      WHERE (h.workspace_id, h.project_id, h.document_id) = (d.workspace_id, d.project_id, d.id)),
    'attachments', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'size', a.size)
      ORDER BY a.created_at, a.id), '[]') FROM public.document_attachments a
      WHERE (a.workspace_id, a.project_id, a.document_id) = (d.workspace_id, d.project_id, d.id)
        AND a.ready_at IS NOT NULL AND a.removed_at IS NULL))
  FROM public.documents d JOIN public.document_versions v
    ON (v.workspace_id, v.project_id, v.document_id, v.revision) =
      (d.workspace_id, d.project_id, d.id, coalesce(p_revision, d.revision))
  WHERE (d.workspace_id, d.project_id, d.id) = (kordos_identity.workspace_id(), p_project, p_document)
    AND kordos_planning.project_access(p_project) IS NOT NULL
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kordos_knowledge.upload(p_project uuid, p_document uuid, p_input jsonb, p_finish boolean) RETURNS jsonb
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
    IF found_attachment.removed_at IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'invalid_state');
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
  UPDATE public.document_attachments SET ready_at = clock_timestamp()
    WHERE id = found_attachment.id AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;
  PERFORM kordos_planning.emit(p_project, found_attachment.id, 'document.attachment_added', request, NULL,
    jsonb_build_object('documentId', p_document, 'name', found_attachment.name, 'size', found_attachment.size));
  RETURN jsonb_build_object('result', 'saved', 'id', found_attachment.id);
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_knowledge.abort_upload(p_project uuid, p_document uuid, p_mutation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  writable boolean;
BEGIN
  IF kordos_knowledge.open_write(p_project, p_mutation) IS NOT NULL THEN RETURN; END IF;
  SELECT archived_at IS NULL INTO writable FROM public.documents
    WHERE (workspace_id, project_id, id) = (tenant, p_project, p_document);
  IF NOT FOUND OR NOT writable THEN RETURN; END IF;
  UPDATE public.document_attachments SET removed_at = clock_timestamp()
    WHERE (workspace_id, actor_id, mutation_id) = (tenant, actor, p_mutation)
      AND project_id = p_project AND document_id = p_document
      AND ready_at IS NULL AND removed_at IS NULL;
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_knowledge.cleanup() RETURNS TABLE(id uuid, key text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH due AS (
    SELECT a.id FROM public.document_attachments a
    WHERE a.deleted_at IS NULL AND a.ready_at IS NULL
      AND ((a.removed_at IS NOT NULL AND a.removed_at <= clock_timestamp() - interval '1 minute')
        OR a.created_at <= clock_timestamp() - interval '1 hour')
    ORDER BY coalesce(a.removed_at, a.created_at), a.id FOR UPDATE SKIP LOCKED LIMIT 20
  )
  UPDATE public.document_attachments a SET removed_at = coalesce(a.removed_at, clock_timestamp())
  FROM due WHERE a.id = due.id RETURNING a.id, kordos_knowledge.attachment_key(a)
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_knowledge.cleaned(p_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE public.document_attachments SET deleted_at = clock_timestamp()
  WHERE id = p_id AND removed_at IS NOT NULL AND deleted_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kordos_meetings.abort_upload(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION kordos_knowledge.abort_upload(uuid, uuid, uuid),
  kordos_knowledge.cleanup(), kordos_knowledge.cleaned(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_meetings.abort_upload(uuid, uuid, uuid) TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_knowledge.abort_upload(uuid, uuid, uuid) TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_knowledge.cleanup(), kordos_knowledge.cleaned(uuid) TO kordos_brief_worker;