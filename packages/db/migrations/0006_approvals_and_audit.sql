CREATE TYPE "public"."proposal_status" AS ENUM('draft', 'pending', 'approved', 'applying', 'applied', 'stale', 'rejected', 'expired', 'failed', 'reconciliation_required');--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"authority" jsonb NOT NULL,
	"status" "proposal_status" DEFAULT 'approved' NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"issue" text,
	"write_mutation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"approval_audit_id" uuid NOT NULL,
	"outcome_audit_id" uuid,
	"effect_event_id" uuid,
	CONSTRAINT "executions_effect_event_id_unique" UNIQUE("effect_event_id"),
	CONSTRAINT "executions_workspace_id_project_id_proposal_id_revision_unique" UNIQUE("workspace_id","project_id","proposal_id","revision"),
	CONSTRAINT "executions_status" CHECK ("executions"."status" NOT IN ('draft', 'pending', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "proposal_revisions" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"author_id" uuid NOT NULL,
	"target_version" integer NOT NULL,
	"command" jsonb NOT NULL,
	"before" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "proposal_revisions_pk" PRIMARY KEY("workspace_id","project_id","proposal_id","revision"),
	CONSTRAINT "proposal_revisions_command" CHECK ("proposal_revisions"."command"->>'kind' IS NOT DISTINCT FROM 'work.edit')
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"status" "proposal_status" DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewer_id" uuid,
	"reason" text,
	CONSTRAINT "proposals_workspace_id_project_id_id_unique" UNIQUE("workspace_id","project_id","id")
);
--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_approval_audit_id_audit_events_id_fk" FOREIGN KEY ("approval_audit_id") REFERENCES "public"."audit_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_outcome_audit_id_audit_events_id_fk" FOREIGN KEY ("outcome_audit_id") REFERENCES "public"."audit_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_effect_event_id_audit_events_id_fk" FOREIGN KEY ("effect_event_id") REFERENCES "public"."audit_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_revision_fk" FOREIGN KEY ("workspace_id","project_id","proposal_id","revision") REFERENCES "public"."proposal_revisions"("workspace_id","project_id","proposal_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_reviewer_fk" FOREIGN KEY ("workspace_id","reviewer_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_proposal_fk" FOREIGN KEY ("workspace_id","project_id","proposal_id") REFERENCES "public"."proposals"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_author_fk" FOREIGN KEY ("workspace_id","author_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_work_fk" FOREIGN KEY ("workspace_id","project_id","work_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_requester_fk" FOREIGN KEY ("workspace_id","requester_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_reviewer_fk" FOREIGN KEY ("workspace_id","reviewer_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "executions_pending_idx" ON "executions" USING btree ("approved_at","id") WHERE "executions"."status" IN ('approved', 'applying');--> statement-breakpoint
CREATE INDEX "proposals_workspace_date_idx" ON "proposals" USING btree ("workspace_id","created_at","id");
--> statement-breakpoint
CREATE SCHEMA kordos_reviews;
REVOKE ALL ON SCHEMA kordos_reviews FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_reviews TO kordos_app;

-- Only the scoped commands below can access proposal revisions and receipts.
ALTER TABLE public.proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proposal_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.executions ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION kordos_reviews.citations(p_evidence jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_agg(value ORDER BY e.position) FILTER (WHERE value IS NOT NULL), '[]')
  FROM jsonb_array_elements(p_evidence) WITH ORDINALITY e(entry, position)
  CROSS JOIN LATERAL (SELECT kordos_knowledge.citation(e.entry->'source') AS value) resolved
  WHERE e.entry->>'version' IS NULL OR EXISTS (
    SELECT 1 FROM public.comments c
    WHERE (c.workspace_id, c.project_id, c.id, c.version) = (kordos_identity.workspace_id(),
      (e.entry->'source'->>'projectId')::uuid, (e.entry->'source'->>'id')::uuid, (e.entry->>'version')::int)
  )
$$;

CREATE FUNCTION kordos_reviews.lock_projects(p_project uuid, p_sources jsonb) RETURNS void
LANGUAGE sql SET search_path = pg_catalog AS $$
  SELECT FROM public.projects p
  WHERE p.workspace_id = kordos_identity.workspace_id()
    AND (p.id = p_project OR p.id IN (SELECT (source->>'projectId')::uuid FROM jsonb_array_elements(p_sources) source))
  ORDER BY p.id FOR UPDATE
$$;

-- Bind approval to the current membership versions. Removing and restoring
-- access must not reactivate an approval granted under the old membership.
CREATE FUNCTION kordos_reviews.authority(p_user uuid, p_project uuid, p_evidence jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('target', jsonb_build_array(m.version, destination.version),
    'sources', (SELECT coalesce(jsonb_agg(pm.version ORDER BY e.position), '[]')
      FROM jsonb_array_elements(p_evidence) WITH ORDINALITY e(entry, position)
      LEFT JOIN public.project_members pm ON (pm.workspace_id, pm.project_id, pm.user_id)
        = (m.workspace_id, (e.entry->'source'->>'projectId')::uuid, m.user_id)))
  FROM public.memberships m
  LEFT JOIN public.project_members destination ON (destination.workspace_id, destination.project_id, destination.user_id)
    = (m.workspace_id, p_project, m.user_id)
  WHERE (m.workspace_id, m.user_id) = (kordos_identity.workspace_id(), p_user)
$$;

CREATE FUNCTION kordos_reviews.can_read(p public.proposals) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT p.workspace_id = kordos_identity.workspace_id()
    AND kordos_planning.project_access(p.project_id) IS NOT NULL
    AND (p.status <> 'draft' OR p.submitted_at IS NOT NULL
      OR p.requester_id = kordos_identity.actor_id() OR kordos_planning.project_access(p.project_id) = 'lead')
$$;

CREATE FUNCTION kordos_reviews.effective_status(p public.proposals, r public.proposal_revisions)
RETURNS public.proposal_status LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p.status IN ('draft', 'pending') AND r.expires_at <= statement_timestamp()
    THEN 'expired'::public.proposal_status ELSE p.status END
$$;

CREATE FUNCTION kordos_reviews.summary(
  p public.proposals, project public.projects, w public.work_items, r public.proposal_revisions
) RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', p.id, 'projectId', p.project_id, 'projectName', project.name,
    'workId', w.id, 'title', w.title, 'kind', w.kind, 'revision', r.revision,
    'status', kordos_reviews.effective_status(p, r), 'requester', kordos_collaboration.person(p.requester_id),
    'requestedAt', CASE WHEN p.status = 'draft' THEN r.created_at ELSE coalesce(p.submitted_at, r.created_at) END)
$$;

CREATE FUNCTION kordos_reviews.directory(p_before uuid, p_pending boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH cursor_row AS (
    SELECT p.id, p.created_at FROM public.proposals p
    WHERE p.id = p_before AND kordos_reviews.can_read(p)
  ), entries AS (
    SELECT p.id, p.created_at, kordos_reviews.summary(p, project, w, r) AS value
    FROM public.proposals p
    JOIN public.projects project ON (project.workspace_id, project.id) = (p.workspace_id, p.project_id)
    JOIN public.work_items w ON (w.workspace_id, w.project_id, w.id) = (p.workspace_id, p.project_id, p.work_id)
    JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision)
      = (p.workspace_id, p.project_id, p.id, p.revision)
    WHERE p.workspace_id = kordos_identity.workspace_id() AND kordos_reviews.can_read(p)
      AND (NOT p_pending OR (p.status = 'pending' AND r.expires_at > statement_timestamp()))
      AND (p_before IS NULL OR (p.created_at, p.id) < (SELECT created_at, id FROM cursor_row))
    ORDER BY p.created_at DESC, p.id DESC LIMIT 41
  ), page AS (
    SELECT * FROM entries ORDER BY created_at DESC, id DESC LIMIT 40
  )
  SELECT jsonb_build_object('items', coalesce((SELECT jsonb_agg(value ORDER BY created_at DESC, id DESC) FROM page), '[]'),
    'pendingCount', (SELECT count(*) FROM public.proposals p JOIN public.proposal_revisions r
      ON (r.workspace_id, r.project_id, r.proposal_id, r.revision) = (p.workspace_id, p.project_id, p.id, p.revision)
      WHERE p.workspace_id = kordos_identity.workspace_id() AND p.status = 'pending'
        AND r.expires_at > statement_timestamp() AND kordos_reviews.can_read(p)),
    'nextCursor', CASE WHEN (SELECT count(*) FROM entries) > 40 THEN
      (SELECT id FROM page ORDER BY created_at, id LIMIT 1) END)
  WHERE kordos_identity.current_role() IS NOT NULL
$$;

CREATE FUNCTION kordos_reviews.detail(p_id uuid, p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_reviews.summary(p, project, w, r) || jsonb_build_object(
    'version', p.version, 'revisionHead', p.revision, 'targetVersion', r.target_version, 'currentTargetVersion', w.version,
    'expiresAt', r.expires_at, 'author', kordos_collaboration.person(r.author_id),
    'status', CASE WHEN current_revision THEN current_status ELSE coalesce(e.status, 'stale') END,
    'reviewer', kordos_collaboration.person(coalesce(e.reviewer_id, CASE WHEN current_revision THEN p.reviewer_id END)),
    'reviewedAt', coalesce(e.approved_at, CASE WHEN current_revision THEN p.reviewed_at END),
    'reason', CASE WHEN current_revision AND all_visible THEN p.reason END,
    'evidence', visibility.evidence, 'evidenceRestricted', NOT all_visible,
    'before', CASE WHEN all_visible THEN r.before END,
    'after', CASE WHEN all_visible THEN r.command->'values' END,
    'owners', CASE WHEN all_visible THEN (
      SELECT coalesce(jsonb_agg(kordos_collaboration.person(u.id) ORDER BY u.id), '[]')
      FROM (SELECT DISTINCT id::uuid FROM unnest(ARRAY[
        r.before->>'ownerId', r.before->>'blockerOwnerId',
        r.command->'values'->>'ownerId', r.command->'values'->>'blockerOwnerId']) id WHERE id IS NOT NULL) u
    ) ELSE '[]'::jsonb END,
    'canEdit', editable AND current_status NOT IN ('applied', 'rejected', 'reconciliation_required'),
    'canSubmit', editable AND current_status = 'draft' AND p.reviewer_id IS NULL AND w.version = r.target_version AND all_visible,
    'canReview', writable AND access = 'lead' AND current_status = 'pending' AND current_revision
      AND all_visible,
    'receipt', CASE WHEN e.id IS NOT NULL THEN jsonb_build_object(
      'id', e.id, 'status', e.status, 'reviewer', kordos_collaboration.person(e.reviewer_id),
      'approvedAt', e.approved_at, 'finishedAt', e.finished_at, 'issue', e.issue,
      'effectEventId', e.effect_event_id, 'auditId', coalesce(e.outcome_audit_id, e.approval_audit_id)) END)
  FROM public.proposals p
  JOIN public.projects project ON (project.workspace_id, project.id) = (p.workspace_id, p.project_id)
  JOIN public.work_items w ON (w.workspace_id, w.project_id, w.id) = (p.workspace_id, p.project_id, p.work_id)
  JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision)
    = (p.workspace_id, p.project_id, p.id, coalesce(p_revision, p.revision))
  LEFT JOIN public.executions e ON (e.workspace_id, e.project_id, e.proposal_id, e.revision)
    = (r.workspace_id, r.project_id, r.proposal_id, r.revision)
  CROSS JOIN LATERAL (SELECT kordos_planning.project_access(p.project_id) AS access,
    kordos_reviews.effective_status(p, r) AS current_status, p.revision = r.revision AS current_revision,
    project.archived_at IS NULL AND w.archived_at IS NULL AS writable,
    kordos_reviews.citations(r.evidence) AS evidence) visibility
  CROSS JOIN LATERAL (SELECT jsonb_array_length(visibility.evidence) = jsonb_array_length(r.evidence) AS all_visible,
    writable AND current_revision AND (access = 'lead' OR
      (access = 'contributor' AND p.requester_id = kordos_identity.actor_id())) AS editable) permissions
  WHERE p.id = p_id AND kordos_reviews.can_read(p)
$$;

-- Audit rows and their outbox events carry metadata only. The secured revision
-- reader resolves citations and checks audience before exposing proposed values.
CREATE FUNCTION kordos_reviews.event(
  p public.proposals, p_kind text, p_request jsonb, p_receipt uuid DEFAULT NULL, p_issue text DEFAULT NULL, p_executor boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE event_id uuid;
BEGIN
  PERFORM kordos_planning.emit(p.project_id, p.id, p_kind, p_request, NULL,
    jsonb_build_object('revision', p.revision, 'workId', p.work_id, 'receiptId', p_receipt, 'issue', p_issue, 'executor', p_executor));
  SELECT id INTO STRICT event_id FROM public.outbox WHERE workspace_id = p.workspace_id
    AND actor_id = kordos_identity.actor_id() AND mutation_id = (p_request->>'mutationId')::uuid;
  RETURN event_id;
END
$$;

CREATE FUNCTION kordos_reviews.finish(
  e public.executions, p public.proposals, p_status public.proposal_status, p_issue text, p_effect uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE event_id uuid;
BEGIN
  event_id := kordos_reviews.event(p, 'proposal.' || p_status,
    jsonb_build_object('mutationId', gen_random_uuid()), e.id, p_issue, p_issue IS DISTINCT FROM 'superseded');
  UPDATE public.executions SET status = p_status, issue = p_issue, effect_event_id = p_effect,
    finished_at = clock_timestamp(), outcome_audit_id = event_id WHERE id = e.id;
  UPDATE public.proposals SET status = p_status, version = version + 1 WHERE id = p.id;
  UPDATE public.outbox SET delivered_at = clock_timestamp() WHERE id = e.approval_audit_id;
END
$$;

CREATE FUNCTION kordos_reviews.mutate(p_project uuid, p_id uuid, p_action text, p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  wanted_revision int := (p_input->>'revision')::int;
  target_version int := (p_input->>'targetVersion')::int;
  p public.proposals;
  r public.proposal_revisions;
  e public.executions;
  w public.work_items;
  project uuid := p_project;
  access public.project_role;
  writable boolean;
  expires timestamptz;
  sources jsonb;
  links jsonb;
  request jsonb;
  existing public.outbox;
  receipt_id uuid;
  approval_event uuid;
BEGIN
  IF p_action NOT IN ('create', 'revise', 'submit', 'approve', 'request_edit', 'reject') THEN
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;
  IF p_action <> 'create' THEN
    SELECT * INTO p FROM public.proposals WHERE id = p_id AND workspace_id = tenant;
    project := p.project_id;
  END IF;
  access := kordos_planning.project_access(project);
  IF access IS NULL OR access = 'viewer' THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  IF p_action IN ('approve', 'reject', 'request_edit') AND access <> 'lead' THEN
    RETURN jsonb_build_object('result', 'forbidden');
  END IF;

  PERFORM kordos_planning.lock_workspace(mutation);
  IF p_action IN ('create', 'revise') THEN
    sources := p_input->'evidence';
  ELSE
    SELECT coalesce(jsonb_agg(entry->'source'), '[]') INTO sources
    FROM public.proposal_revisions previous, jsonb_array_elements(previous.evidence) entry
    WHERE (previous.workspace_id, previous.project_id, previous.proposal_id, previous.revision)
      = (tenant, project, p_id, wanted_revision);
  END IF;
  PERFORM kordos_reviews.lock_projects(project, sources);
  access := kordos_planning.project_access(project);
  IF access IS NULL OR access = 'viewer' THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  IF p_action IN ('approve', 'reject', 'request_edit') AND access <> 'lead' THEN
    RETURN jsonb_build_object('result', 'forbidden');
  END IF;

  request := jsonb_build_object('mutationId', mutation, '_command', 'proposal.' || p_action,
    'hash', encode(sha256(convert_to(jsonb_build_array(p_id, p_input)::text, 'UTF8')), 'hex'));
  SELECT * INTO existing FROM public.outbox WHERE workspace_id = tenant AND actor_id = actor AND mutation_id = mutation;
  IF FOUND THEN
    IF existing.project_id <> project OR (existing.request - 'revision') <> request THEN
      RETURN jsonb_build_object('result', 'mutation_conflict');
    END IF;
    SELECT id INTO receipt_id FROM public.executions WHERE approval_audit_id = existing.id;
    RETURN jsonb_strip_nulls(jsonb_build_object('result', 'saved', 'id', existing.target_id,
      'revision', existing.request->'revision', 'receiptId', receipt_id));
  END IF;

  IF p_action <> 'create' THEN
    SELECT * INTO STRICT p FROM public.proposals WHERE id = p_id AND workspace_id = tenant FOR UPDATE;
    IF NOT kordos_reviews.can_read(p) THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
    IF p_action IN ('revise', 'submit') AND actor <> p.requester_id AND access <> 'lead' THEN
      RETURN jsonb_build_object('result', 'forbidden');
    END IF;
    IF p_action = 'approve' THEN
      SELECT id INTO receipt_id FROM public.executions WHERE workspace_id = tenant
        AND project_id = project AND proposal_id = p.id AND revision = wanted_revision;
      IF FOUND THEN
        RETURN jsonb_build_object('result', 'saved', 'id', p.id, 'revision', wanted_revision, 'receiptId', receipt_id);
      END IF;
    END IF;
    IF p.revision <> wanted_revision OR p.version <> (p_input->>'expectedVersion')::int THEN
      RETURN jsonb_build_object('result', 'conflict');
    END IF;
    SELECT * INTO STRICT r FROM public.proposal_revisions WHERE (workspace_id, project_id, proposal_id, revision)
      = (tenant, project, p.id, p.revision);
  END IF;

  SELECT * INTO w FROM public.work_items WHERE (workspace_id, project_id, id)
    = (tenant, project, coalesce(p.work_id, (p_input->>'workId')::uuid));
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  SELECT archived_at IS NULL AND w.archived_at IS NULL INTO STRICT writable
    FROM public.projects WHERE id = project AND workspace_id = tenant;
  IF NOT writable THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;

  IF p_action IN ('create', 'revise') THEN
    IF p.status IN ('applied', 'rejected', 'reconciliation_required') THEN
      RETURN jsonb_build_object('result', 'invalid_state');
    END IF;
    IF w.version IS DISTINCT FROM target_version THEN RETURN jsonb_build_object('result', 'target_changed'); END IF;
    IF p_input->'command'->>'kind' IS DISTINCT FROM 'work.edit'
      OR p_input->'command'->'values'->>'kind' IS DISTINCT FROM w.kind::text THEN
      RETURN jsonb_build_object('result', 'invalid_state');
    END IF;
    expires := coalesce((p_input->>'expiresAt')::timestamptz, clock_timestamp() + interval '7 days');
    IF NOT (expires > clock_timestamp() AND expires <= clock_timestamp() + interval '30 days') THEN
      RETURN jsonb_build_object('result', 'invalid_expiry');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('source', source, 'version', c.version) ORDER BY position), '[]')
    INTO links FROM jsonb_array_elements(sources) WITH ORDINALITY s(source, position)
    LEFT JOIN public.comments c ON source->>'kind' = 'comment'
      AND (c.workspace_id, c.project_id, c.id) = (tenant, (source->>'projectId')::uuid, (source->>'id')::uuid);
    IF jsonb_array_length(kordos_reviews.citations(links)) <> jsonb_array_length(links) THEN
      RETURN jsonb_build_object('result', 'evidence_changed');
    END IF;

    IF p_action = 'create' THEN
      INSERT INTO public.proposals (workspace_id, project_id, work_id, requester_id)
        VALUES (tenant, project, w.id, actor) RETURNING * INTO p;
    ELSE
      SELECT * INTO e FROM public.executions WHERE (workspace_id, project_id, proposal_id, revision)
        = (tenant, project, p.id, p.revision) AND status IN ('approved', 'applying') FOR UPDATE;
      IF FOUND THEN PERFORM kordos_reviews.finish(e, p, 'stale', 'superseded'); END IF;
      UPDATE public.proposals SET revision = revision + 1, version = version + 1, status = 'draft',
        reviewed_at = NULL, reviewer_id = NULL, reason = NULL WHERE id = p.id RETURNING * INTO p;
    END IF;
    INSERT INTO public.proposal_revisions (workspace_id, project_id, proposal_id, revision, author_id,
      target_version, command, before, evidence, expires_at)
    VALUES (tenant, project, p.id, p.revision, actor, w.version,
      p_input->'command', kordos_planning.work_snapshot(w), links, expires);

  ELSIF (p_action = 'submit' AND p.status = 'draft' AND p.reviewer_id IS NULL) OR
      (p_action IN ('approve', 'request_edit', 'reject') AND p.status = 'pending') THEN
    IF r.expires_at <= clock_timestamp() THEN RETURN jsonb_build_object('result', 'expired'); END IF;
    IF p_action IN ('approve', 'submit') AND w.version <> r.target_version THEN
      RETURN jsonb_build_object('result', 'target_changed');
    END IF;
    IF jsonb_array_length(kordos_reviews.citations(r.evidence)) <> jsonb_array_length(r.evidence) THEN
      RETURN jsonb_build_object('result', 'evidence_changed');
    END IF;
    UPDATE public.proposals SET status = CASE p_action
        WHEN 'submit' THEN 'pending' WHEN 'approve' THEN 'approved'
        WHEN 'reject' THEN 'rejected' ELSE 'draft' END::public.proposal_status,
      version = version + 1, submitted_at = CASE WHEN p_action = 'submit' THEN clock_timestamp() ELSE submitted_at END,
      reviewer_id = CASE WHEN p_action <> 'submit' THEN actor END,
      reviewed_at = CASE WHEN p_action <> 'submit' THEN clock_timestamp() END,
      reason = p_input->>'reason' WHERE id = p.id RETURNING * INTO p;
  ELSE
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;

  request := request || jsonb_build_object('revision', p.revision);
  IF p_action = 'approve' THEN
    receipt_id := gen_random_uuid();
    approval_event := kordos_reviews.event(p, 'proposal.approved', request, receipt_id);
    INSERT INTO public.executions
      (id, workspace_id, project_id, proposal_id, revision, reviewer_id, authority, approval_audit_id)
    VALUES (receipt_id, tenant, project, p.id, p.revision, actor, jsonb_build_object(
      'requester', kordos_reviews.authority(p.requester_id, project, r.evidence),
      'reviewer', kordos_reviews.authority(actor, project, r.evidence)), approval_event);
  ELSE
    PERFORM kordos_reviews.event(p, CASE p_action WHEN 'create' THEN 'proposal.drafted'
      WHEN 'revise' THEN 'proposal.revised' WHEN 'submit' THEN 'proposal.submitted'
      WHEN 'reject' THEN 'proposal.rejected' ELSE 'proposal.edits_requested' END, request);
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('result', 'saved', 'id', p.id, 'revision', p.revision, 'receiptId', receipt_id));
END
$$;

CREATE FUNCTION kordos_reviews.pending() RETURNS TABLE(id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT e.id FROM public.executions e JOIN public.outbox o ON o.id = e.approval_audit_id
  WHERE e.status IN ('approved', 'applying') AND o.delivered_at IS NULL
  ORDER BY e.approved_at, e.id LIMIT 50
$$;

CREATE FUNCTION kordos_reviews.run(p_execution uuid, p_step text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  e public.executions;
  p public.proposals;
  r public.proposal_revisions;
  w public.work_items;
  saved jsonb;
  effect_id uuid;
  requester_access public.project_role;
  requester_evidence boolean;
  requester_authority jsonb;
  reviewer_authority jsonb;
BEGIN
  IF p_step NOT IN ('claim', 'apply', 'fail') THEN RETURN false; END IF;
  SELECT * INTO e FROM public.executions WHERE id = p_execution AND status IN ('approved', 'applying');
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM set_config('kordos.workspace_id', e.workspace_id::text, true);
  PERFORM set_config('kordos.actor_id', e.reviewer_id::text, true);
  SELECT * INTO STRICT r FROM public.proposal_revisions WHERE (workspace_id, project_id, proposal_id, revision)
    = (e.workspace_id, e.project_id, e.proposal_id, e.revision);

  -- Hold the same workspace and project locks as membership and work edits.
  -- Lock cited projects in the same order as review commands before checking access.
  PERFORM kordos_planning.lock_workspace(e.write_mutation_id);
  PERFORM kordos_reviews.lock_projects(e.project_id,
    (SELECT coalesce(jsonb_agg(source->'source'), '[]') FROM jsonb_array_elements(r.evidence) source));
  SELECT * INTO STRICT p FROM public.proposals WHERE id = e.proposal_id FOR UPDATE;
  SELECT * INTO STRICT e FROM public.executions WHERE id = p_execution FOR UPDATE;
  IF p.revision <> e.revision OR e.status NOT IN ('approved', 'applying') THEN RETURN false; END IF;

  IF p_step = 'claim' THEN
    IF e.status = 'approved' THEN
      UPDATE public.executions SET status = 'applying' WHERE id = e.id;
      UPDATE public.proposals SET status = 'applying', version = version + 1 WHERE id = p.id;
      PERFORM kordos_reviews.event(p, 'proposal.applying', jsonb_build_object('mutationId', gen_random_uuid()), e.id, NULL, true);
    END IF;
    RETURN true;
  END IF;
  -- A prior effect and an unfinished receipt cannot result from our atomic
  -- write. Stop if the stored mutation key is already associated with an event.
  IF EXISTS (SELECT 1 FROM public.outbox WHERE workspace_id = e.workspace_id
    AND actor_id = e.reviewer_id AND mutation_id = e.write_mutation_id) THEN
    PERFORM kordos_reviews.finish(e, p, 'reconciliation_required', 'ambiguous_effect');
    RETURN false;
  END IF;

  IF p_step = 'fail' THEN
    PERFORM kordos_reviews.finish(e, p, 'failed', 'worker_failed');
    RETURN false;
  END IF;
  IF e.status <> 'applying' THEN RETURN false; END IF;
  IF r.expires_at <= clock_timestamp() THEN
    PERFORM kordos_reviews.finish(e, p, 'expired', 'expired');
    RETURN false;
  END IF;

  PERFORM set_config('kordos.actor_id', p.requester_id::text, true);
  requester_access := kordos_planning.project_access(p.project_id);
  requester_evidence := jsonb_array_length(kordos_reviews.citations(r.evidence)) = jsonb_array_length(r.evidence);
  PERFORM set_config('kordos.actor_id', e.reviewer_id::text, true);
  requester_authority := kordos_reviews.authority(p.requester_id, p.project_id, r.evidence);
  reviewer_authority := kordos_reviews.authority(e.reviewer_id, p.project_id, r.evidence);
  IF requester_access IS NULL OR requester_access = 'viewer'
    OR kordos_planning.project_access(p.project_id) IS DISTINCT FROM 'lead'
    OR requester_authority->'target' IS DISTINCT FROM e.authority->'requester'->'target'
    OR reviewer_authority->'target' IS DISTINCT FROM e.authority->'reviewer'->'target' THEN
    PERFORM kordos_reviews.finish(e, p, 'stale', 'access_changed');
    RETURN false;
  END IF;
  IF NOT requester_evidence OR jsonb_array_length(kordos_reviews.citations(r.evidence)) <> jsonb_array_length(r.evidence)
    OR requester_authority->'sources' IS DISTINCT FROM e.authority->'requester'->'sources'
    OR reviewer_authority->'sources' IS DISTINCT FROM e.authority->'reviewer'->'sources' THEN
    PERFORM kordos_reviews.finish(e, p, 'stale', 'evidence_changed');
    RETURN false;
  END IF;

  SELECT * INTO STRICT w FROM public.work_items WHERE (workspace_id, project_id, id) = (p.workspace_id, p.project_id, p.work_id);
  IF w.version <> r.target_version THEN
    PERFORM kordos_reviews.finish(e, p, 'stale', 'target_changed');
    RETURN false;
  END IF;
  IF w.archived_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.projects WHERE workspace_id = p.workspace_id AND id = p.project_id AND archived_at IS NOT NULL
  ) THEN
    PERFORM kordos_reviews.finish(e, p, 'stale', 'target_unavailable');
    RETURN false;
  END IF;

  saved := kordos_planning.save_work(p.project_id, p.work_id, r.command->'values' ||
    jsonb_build_object('action', 'edit', 'expectedVersion', r.target_version, 'mutationId', e.write_mutation_id));
  IF saved->>'result' IS DISTINCT FROM 'saved' THEN
    PERFORM kordos_reviews.finish(e, p, 'failed', 'invalid_change');
    RETURN false;
  END IF;

  SELECT id INTO STRICT effect_id FROM public.outbox WHERE workspace_id = p.workspace_id
    AND actor_id = e.reviewer_id AND mutation_id = e.write_mutation_id;
  PERFORM kordos_reviews.finish(e, p, 'applied', NULL, effect_id);
  RETURN true;
END
$$;

CREATE FUNCTION kordos_reviews.audit(p_filter jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH cursor_row AS (
    SELECT a.created_at, a.id FROM public.audit_events a
    WHERE a.workspace_id = kordos_identity.workspace_id() AND a.id = (p_filter->>'cursor')::uuid
      AND CASE WHEN a.project_id IS NULL THEN kordos_identity.current_role() = 'admin'
        ELSE kordos_planning.project_access(a.project_id) IS NOT NULL END
  ), entries AS (
    SELECT a.*, project.name AS project_name
    FROM public.audit_events a
    LEFT JOIN public.projects project ON (project.workspace_id, project.id) = (a.workspace_id, a.project_id)
    WHERE a.workspace_id = kordos_identity.workspace_id()
      AND CASE WHEN a.project_id IS NULL THEN kordos_identity.current_role() = 'admin'
        ELSE kordos_planning.project_access(a.project_id) IS NOT NULL END
      AND (p_filter->>'eventId' IS NULL OR a.id = (p_filter->>'eventId')::uuid)
      AND (p_filter->>'projectId' IS NULL OR a.project_id = (p_filter->>'projectId')::uuid)
      AND (p_filter->>'actorId' IS NULL OR a.actor_id = (p_filter->>'actorId')::uuid)
      AND (p_filter->>'targetId' IS NULL OR a.target_id = (p_filter->>'targetId')::uuid
        OR (a.action LIKE 'proposal.%' AND a.details->'after'->>'workId' = p_filter->>'targetId'))
      AND (p_filter->>'from' IS NULL OR a.created_at >= ((p_filter->>'from')::date::timestamp AT TIME ZONE 'UTC'))
      AND (p_filter->>'to' IS NULL OR a.created_at < (((p_filter->>'to')::date + 1)::timestamp AT TIME ZONE 'UTC'))
      AND (p_filter->>'cursor' IS NULL OR (a.created_at, a.id) < (SELECT created_at, id FROM cursor_row))
    ORDER BY a.created_at DESC, a.id DESC LIMIT 41
  ), page AS (
    SELECT * FROM entries ORDER BY created_at DESC, id DESC LIMIT 40
  )
  SELECT jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', a.id, 'targetId', a.target_id, 'action', a.action, 'occurredAt', a.created_at,
      'projectId', a.project_id, 'projectName', a.project_name,
      'actor', kordos_collaboration.person(a.actor_id),
      'actorType', CASE WHEN e.id IS NOT NULL OR meta->>'executor' = 'true' THEN 'service' ELSE 'user' END,
      'workId', CASE WHEN a.action LIKE 'work.%' THEN a.target_id ELSE (meta->>'workId')::uuid END,
      'proposalId', CASE WHEN kordos_reviews.can_read(p) THEN p.id END,
      'revision', CASE WHEN kordos_reviews.can_read(p) THEN coalesce(e.revision, (meta->>'revision')::int) END,
      'receiptId', coalesce(e.id, (meta->>'receiptId')::uuid),
      'before', CASE WHEN a.action LIKE 'work.%' THEN a.details->'before' END,
      'after', CASE WHEN a.action LIKE 'work.%' THEN a.details->'after' END
    ) ORDER BY a.created_at DESC, a.id DESC)
    FROM page a
    LEFT JOIN public.executions e ON e.effect_event_id = a.id AND e.workspace_id = a.workspace_id
    CROSS JOIN LATERAL (SELECT CASE WHEN a.action LIKE 'proposal.%' THEN a.details->'after' END AS meta) m
    LEFT JOIN public.proposals p ON p.workspace_id = a.workspace_id
      AND p.id = coalesce(e.proposal_id, CASE WHEN meta IS NOT NULL THEN a.target_id END)
  ), '[]'), 'nextCursor', CASE WHEN (SELECT count(*) FROM entries) > 40 THEN
    (SELECT id FROM page ORDER BY created_at, id LIMIT 1) END)
  WHERE kordos_identity.current_role() IS NOT NULL
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_reviews FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_reviews.directory(uuid, boolean), kordos_reviews.detail(uuid, int),
  kordos_reviews.mutate(uuid, uuid, text, jsonb), kordos_reviews.pending(), kordos_reviews.run(uuid, text),
  kordos_reviews.audit(jsonb) TO kordos_app;
