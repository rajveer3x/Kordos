CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"work_id" uuid,
	"parent_id" uuid,
	"author_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"body" text NOT NULL,
	"mention_ids" uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "comments_subject_id_unique" UNIQUE("workspace_id","project_id","subject_kind","subject_id","id"),
	CONSTRAINT "comments_subject" CHECK ((
      ("comments"."subject_kind" = 'project' AND "comments"."subject_id" = "comments"."project_id" AND "comments"."work_id" IS NULL)
      OR ("comments"."subject_kind" = 'task' AND "comments"."work_id" IS NOT NULL AND "comments"."work_id" = "comments"."subject_id")
      OR ("comments"."subject_kind" IN ('document', 'meeting') AND "comments"."work_id" IS NULL)
    )),
	CONSTRAINT "comments_content" CHECK (char_length(btrim("comments"."body")) BETWEEN 1 AND 4000
      AND cardinality("comments"."mention_ids") <= 20 AND "comments"."version" > 0),
	CONSTRAINT "comments_resolution" CHECK (("comments"."resolved_at" IS NULL AND "comments"."resolved_by" IS NULL)
      OR ("comments"."parent_id" IS NULL AND "comments"."resolved_at" IS NOT NULL AND "comments"."resolved_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "comment_sequence" bigint;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_work_fk" FOREIGN KEY ("workspace_id","project_id","work_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_fk" FOREIGN KEY ("workspace_id","project_id","subject_kind","subject_id","parent_id") REFERENCES "public"."comments"("workspace_id","project_id","subject_kind","subject_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_fk" FOREIGN KEY ("workspace_id","author_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolver_fk" FOREIGN KEY ("workspace_id","resolved_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_subject_threads_idx" ON "comments" USING btree ("workspace_id","project_id","subject_kind","subject_id","parent_id","created_at","id");--> statement-breakpoint
CREATE INDEX "outbox_comment_feed_idx" ON "outbox" USING btree ("workspace_id","project_id",("request"->'subject'),"comment_sequence") WHERE "outbox"."comment_sequence" IS NOT NULL;
--> statement-breakpoint
CREATE SCHEMA kordos_collaboration;
--> statement-breakpoint
CREATE FUNCTION kordos_collaboration.subject_open(p_project uuid, p_kind text, p_subject uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_kind = 'project' AND p_subject = p_project THEN p.archived_at IS NULL
    WHEN p_kind = 'task' AND w.id IS NOT NULL THEN p.archived_at IS NULL AND w.archived_at IS NULL
  END
  FROM public.projects p
  LEFT JOIN public.work_items w ON p_kind = 'task'
    AND (w.workspace_id, w.project_id, w.id) = (p.workspace_id, p.id, p_subject)
  WHERE p.workspace_id = kordos_identity.workspace_id() AND p.id = p_project
    AND kordos_planning.project_access(p_project) IS NOT NULL
$$;
--> statement-breakpoint
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY comments_read ON public.comments FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id()
  AND kordos_collaboration.subject_open(project_id, subject_kind, subject_id) IS NOT NULL
);
GRANT SELECT ON public.comments TO kordos_app;
--> statement-breakpoint
CREATE FUNCTION kordos_collaboration.people(p_project uuid)
RETURNS TABLE (id uuid, name text) LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT u.id, u.name
  FROM public.projects p
  JOIN public.memberships m ON m.workspace_id = p.workspace_id AND m.removed_at IS NULL
  JOIN public.users u ON u.id = m.user_id
  LEFT JOIN public.project_members pm ON pm.workspace_id = m.workspace_id
    AND pm.project_id = p.id AND pm.user_id = m.user_id AND pm.removed_at IS NULL
  WHERE p.workspace_id = kordos_identity.workspace_id() AND p.id = p_project
    AND kordos_planning.project_access(p_project) IS NOT NULL
    AND (p.visibility = 'workspace' OR pm.user_id IS NOT NULL)
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_collaboration.person(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', u.id, 'name', u.name)
  FROM public.users u WHERE u.id = p_user
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_collaboration.snapshot(
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
      'body', c.body, 'version', c.version, 'createdAt', c.created_at, 'editedAt', c.edited_at,
      'resolvedAt', c.resolved_at, 'resolvedBy', kordos_collaboration.person(c.resolved_by),
      'author', kordos_collaboration.person(c.author_id),
      'mentions', coalesce((SELECT jsonb_agg(kordos_collaboration.person(m.id) ORDER BY m.ordinality)
        FROM unnest(c.mention_ids) WITH ORDINALITY m(id, ordinality)), '[]')
    ) ORDER BY c.created_at, c.id), '[]') FROM entries c)
  ) FROM access WHERE access.writable IS NOT NULL
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_collaboration.feed(
  p_project uuid, p_kind text, p_subject uuid, p_after bigint, p_present uuid[]
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH access AS (
    SELECT concat_ws(':', m.version, pm.version, p.visibility, kordos_planning.project_access(p_project),
      kordos_collaboration.subject_open(p_project, p_kind, p_subject)) AS revision
    FROM public.projects p
    JOIN public.memberships m ON m.workspace_id = p.workspace_id AND m.user_id = kordos_identity.actor_id()
    LEFT JOIN public.project_members pm ON pm.workspace_id = p.workspace_id AND pm.project_id = p.id AND pm.user_id = m.user_id
    WHERE p.workspace_id = kordos_identity.workspace_id() AND p.id = p_project
      AND kordos_collaboration.subject_open(p_project, p_kind, p_subject) IS NOT NULL
  ), changes AS (
    SELECT id, comment_sequence, kind, actor_id FROM public.outbox
    WHERE workspace_id = kordos_identity.workspace_id() AND project_id = p_project
      AND comment_sequence > p_after
      AND request->'subject' = jsonb_build_object('kind', p_kind, 'id', p_subject)
    ORDER BY comment_sequence LIMIT 101
  )
  SELECT jsonb_build_object(
    'revision', access.revision,
    'more', (SELECT count(*) FROM changes) > 100,
    'events', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'cursor', comment_sequence::text, 'kind', kind, 'actorId', actor_id
    ) ORDER BY comment_sequence), '[]') FROM (SELECT * FROM changes ORDER BY comment_sequence LIMIT 100) batch),
    'presence', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name, id), '[]')
      FROM kordos_collaboration.people(p_project) WHERE id = ANY(p_present))
  ) FROM access
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_collaboration.save(
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
    IF parent IS NOT NULL THEN
      SELECT * INTO previous FROM public.comments c
        WHERE (c.workspace_id, c.project_id, c.subject_kind, c.subject_id, c.id)
          = (tenant, p_project, p_kind, p_subject, parent) AND c.parent_id IS NULL;
      IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
      IF previous.resolved_at IS NOT NULL THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;
    END IF;
    INSERT INTO public.comments (
      workspace_id, project_id, subject_kind, subject_id, work_id,
      parent_id, author_id, mutation_id, body, mention_ids
    ) VALUES (
      tenant, p_project, p_kind, p_subject, CASE WHEN p_kind = 'task' THEN p_subject END,
      parent, actor, mutation, p_input->>'body', mentions
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
--> statement-breakpoint
-- Notifications contain no tenant data. Every API process reads changes under each socket's scope.
CREATE FUNCTION kordos_collaboration.access_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_notify('kordos_collaboration', '');
  RETURN NULL;
END
$$;
CREATE TRIGGER comment_workspace_access_changed AFTER INSERT OR UPDATE OR DELETE ON public.memberships
  FOR EACH STATEMENT EXECUTE FUNCTION kordos_collaboration.access_changed();
CREATE TRIGGER comment_project_access_changed AFTER INSERT OR UPDATE OR DELETE ON public.project_members
  FOR EACH STATEMENT EXECUTE FUNCTION kordos_collaboration.access_changed();
CREATE TRIGGER comment_project_state_changed AFTER UPDATE OF visibility, archived_at ON public.projects
  FOR EACH STATEMENT EXECUTE FUNCTION kordos_collaboration.access_changed();
CREATE TRIGGER comment_work_state_changed AFTER UPDATE OF archived_at ON public.work_items
  FOR EACH STATEMENT EXECUTE FUNCTION kordos_collaboration.access_changed();
--> statement-breakpoint
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_collaboration FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_collaboration TO kordos_app;
GRANT EXECUTE ON FUNCTION
  kordos_collaboration.subject_open(uuid, text, uuid),
  kordos_collaboration.snapshot(uuid, text, uuid, uuid),
  kordos_collaboration.feed(uuid, text, uuid, bigint, uuid[]),
  kordos_collaboration.save(uuid, text, uuid, jsonb)
TO kordos_app;
