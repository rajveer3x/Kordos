CREATE TABLE "inbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"email_at" timestamp with time zone,
	"email_slot" date,
	"email_attempts" integer DEFAULT 0 NOT NULL,
	"email_result" text,
	CONSTRAINT "inbox_entries_effect_unique" UNIQUE("workspace_id","recipient_id","subject_id","reason","revision"),
	CONSTRAINT "inbox_entries_reason" CHECK ("inbox_entries"."reason" IN ('assignment','mention','review','risk','due','overdue','escalation')),
	CONSTRAINT "inbox_entries_email_result" CHECK ("inbox_entries"."email_result" IN ('sent','failed','suppressed'))
);
--> statement-breakpoint
CREATE TABLE "inbox_preferences" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	CONSTRAINT "inbox_preferences_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "deadline_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_entries" ADD CONSTRAINT "inbox_entries_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_entries" ADD CONSTRAINT "inbox_entries_recipient_fk" FOREIGN KEY ("workspace_id","recipient_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_preferences" ADD CONSTRAINT "inbox_preferences_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_entries_recipient_idx" ON "inbox_entries" USING btree ("workspace_id","recipient_id","delivered_at","id") WHERE "inbox_entries"."delivered_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inbox_entries_pending_idx" ON "inbox_entries" USING btree ("next_at","id") WHERE "inbox_entries"."delivered_at" IS NULL AND "inbox_entries"."canceled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "inbox_entries_email_idx" ON "inbox_entries" USING btree ("email_at","id") WHERE "inbox_entries"."email_at" IS NOT NULL AND "inbox_entries"."email_result" IS NULL;--> statement-breakpoint
CREATE INDEX "work_items_deadline_idx" ON "work_items" USING btree (coalesce("deadline", "commitment")) WHERE "work_items"."archived_at" IS NULL AND "work_items"."status" <> 'done' AND coalesce("work_items"."deadline", "work_items"."commitment") IS NOT NULL;--> statement-breakpoint
CREATE SCHEMA kordos_inbox;
REVOKE ALL ON SCHEMA kordos_inbox FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_inbox TO kordos_app, kordos_brief_worker;
ALTER TABLE public.inbox_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION kordos_inbox.settings(p_workspace uuid, p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('version', coalesce(pref.version, 0), 'timeZone', w.time_zone,
    'quietHours', NULL, 'reminderDays', 1, 'escalationDays', 2,
    'channels', '{"assignment":"in_app","mention":"in_app","review":"in_app","risk":"in_app",
      "due":"in_app","overdue":"in_app","escalation":"in_app"}'::jsonb)
    || coalesce(pref.settings, '{}')
  FROM public.workspaces w LEFT JOIN public.inbox_preferences pref
    ON (pref.workspace_id, pref.user_id) = (w.id, p_user)
  WHERE w.id = p_workspace
$$;

CREATE FUNCTION kordos_inbox.preferences() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_inbox.settings(kordos_identity.workspace_id(), kordos_identity.actor_id())
  WHERE kordos_identity.current_role() IS NOT NULL
$$;

CREATE FUNCTION kordos_inbox.save_preferences(p_version int, p_settings jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  settings jsonb;
BEGIN
  PERFORM 1 FROM public.memberships WHERE (workspace_id, user_id) = (tenant, actor)
    AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Also validate the PostgreSQL timezone and scheduling fields at the command boundary.
  IF NOT EXISTS (SELECT FROM pg_timezone_names WHERE name = p_settings->>'timeZone')
    OR (p_settings->>'reminderDays')::int NOT BETWEEN 0 AND 30
    OR (p_settings->>'escalationDays')::int NOT BETWEEN 1 AND 30
    OR (
      p_settings->'quietHours' <> 'null'::jsonb AND (
        (p_settings->'quietHours'->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        OR (p_settings->'quietHours'->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        OR p_settings->'quietHours'->>'start' = p_settings->'quietHours'->>'end'
      )
    )
    OR EXISTS (
      SELECT FROM unnest(ARRAY['assignment','mention','review','risk','due','overdue','escalation']) reason
      WHERE coalesce(p_settings->'channels'->>reason, '') NOT IN ('in_app', 'email', 'digest')
    )
    OR NOT (p_settings ?& ARRAY['timeZone','reminderDays','escalationDays','quietHours','channels'])
    OR p_settings->'reminderDays' = 'null'::jsonb OR p_settings->'escalationDays' = 'null'::jsonb
    OR (p_settings->'quietHours' <> 'null'::jsonb AND (
      NOT coalesce(p_settings->'quietHours' ?& ARRAY['start','end'], false)
      OR p_settings->'quietHours'->>'start' IS NULL OR p_settings->'quietHours'->>'end' IS NULL
    ))
  THEN RETURN jsonb_build_object('result', 'invalid'); END IF;

  settings := kordos_inbox.settings(tenant, actor);
  IF (settings->>'version')::int <> p_version THEN
    RETURN jsonb_build_object('result', 'conflict', 'preferences', settings);
  END IF;

  INSERT INTO public.inbox_preferences (workspace_id, user_id, version, settings)
  VALUES (tenant, actor, p_version + 1, p_settings - 'version')
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET version = excluded.version, settings = excluded.settings;
  UPDATE public.inbox_entries SET next_at = statement_timestamp()
  WHERE (workspace_id, recipient_id) = (tenant, actor)
    AND delivered_at IS NULL AND canceled_at IS NULL AND next_at > statement_timestamp();

  RETURN jsonb_build_object('result', 'saved', 'preferences', kordos_inbox.settings(tenant, actor));
END
$$;

CREATE FUNCTION kordos_inbox.leads(p_workspace uuid, p_project uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT pm.user_id FROM public.project_members pm JOIN public.memberships m USING (workspace_id, user_id)
  WHERE (pm.workspace_id, pm.project_id) = (p_workspace, p_project)
    AND pm.role = 'lead' AND pm.removed_at IS NULL AND m.removed_at IS NULL AND m.role <> 'viewer'
  ORDER BY pm.joined_at, pm.user_id
$$;

CREATE FUNCTION kordos_inbox.work_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF coalesce(NEW.deadline, NEW.commitment) IS DISTINCT FROM coalesce(OLD.deadline, OLD.commitment) THEN
    NEW.deadline_revision := OLD.deadline_revision + 1;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inbox_work_revision BEFORE UPDATE OF deadline, commitment ON public.work_items
FOR EACH ROW EXECUTE FUNCTION kordos_inbox.work_revision();

CREATE FUNCTION kordos_inbox.on_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN RETURN NEW; END IF;
  IF NEW.owner_id IS NOT NULL THEN
    INSERT INTO public.inbox_entries (workspace_id, project_id, recipient_id, subject_id, reason, revision)
    VALUES (NEW.workspace_id, NEW.project_id, NEW.owner_id, NEW.id, 'assignment', NEW.version)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inbox_work AFTER INSERT OR UPDATE OF owner_id ON public.work_items
FOR EACH ROW EXECUTE FUNCTION kordos_inbox.on_work();

CREATE FUNCTION kordos_inbox.on_comment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- Preserve a pending mention through an edit that keeps the recipient. A removed
  -- and later re-added mention is a new event. Resolution does not enqueue mentions.
  INSERT INTO public.inbox_entries (workspace_id, project_id, recipient_id, subject_id, reason, revision)
  SELECT NEW.workspace_id, NEW.project_id, recipient, NEW.id, 'mention', NEW.version
  FROM unnest(NEW.mention_ids) recipient
  WHERE recipient <> NEW.author_id
    AND (TG_OP = 'INSERT' OR NOT (recipient = ANY(OLD.mention_ids)))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;
CREATE TRIGGER inbox_comment AFTER INSERT OR UPDATE OF mention_ids ON public.comments
FOR EACH ROW EXECUTE FUNCTION kordos_inbox.on_comment();

CREATE FUNCTION kordos_inbox.on_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status = 'pending' AND (TG_OP = 'INSERT' OR OLD.status <> 'pending' OR OLD.revision <> NEW.revision) THEN
    INSERT INTO public.inbox_entries (workspace_id, project_id, recipient_id, subject_id, reason, revision)
    SELECT NEW.workspace_id, NEW.project_id, recipient, NEW.id, 'review', NEW.revision
    FROM kordos_inbox.leads(NEW.workspace_id, NEW.project_id) recipient
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inbox_review AFTER INSERT OR UPDATE OF status, revision ON public.proposals
FOR EACH ROW EXECUTE FUNCTION kordos_inbox.on_review();

CREATE FUNCTION kordos_inbox.on_risk() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status = 'open' AND NEW.assessment->>'severity' IN ('at_risk', 'watch') THEN
    INSERT INTO public.inbox_entries (workspace_id, project_id, recipient_id, subject_id, reason, revision)
    SELECT NEW.workspace_id, NEW.project_id, recipient, NEW.id, 'risk', NEW.version
    FROM kordos_inbox.leads(NEW.workspace_id, NEW.project_id) recipient
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inbox_risk AFTER INSERT ON public.risk_findings
FOR EACH ROW EXECUTE FUNCTION kordos_inbox.on_risk();
--> statement-breakpoint
-- Deadline dates are inclusive. Midnight after the date, in the project's
-- timezone, starts overdue work. Lead and escalation intervals are calendar days.
CREATE FUNCTION kordos_inbox.deadline_times(
  p_date date, p_zone text, p_reminder int, p_escalation int
) RETURNS TABLE(reminder timestamptz, due timestamptz, escalation timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT ((p_date - p_reminder) + time '09:00') AT TIME ZONE p_zone,
    (p_date + 1)::timestamp AT TIME ZONE p_zone,
    (p_date + 1 + p_escalation)::timestamp AT TIME ZONE p_zone
$$;

CREATE FUNCTION kordos_inbox.quiet_until(p_at timestamptz, p_settings jsonb) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  WITH local_time AS (
    SELECT p_at AT TIME ZONE (p_settings->>'timeZone') AS value,
      (p_settings->'quietHours'->>'start')::time AS starts,
      (p_settings->'quietHours'->>'end')::time AS ends
  )
  SELECT CASE
    WHEN starts < ends AND value::time >= starts AND value::time < ends
      THEN (value::date + ends) AT TIME ZONE (p_settings->>'timeZone')
    WHEN starts > ends AND (value::time >= starts OR value::time < ends)
      THEN (value::date + (value::time >= starts)::int + ends) AT TIME ZONE (p_settings->>'timeZone')
    ELSE p_at
  END FROM local_time
$$;

CREATE FUNCTION kordos_inbox.review_ready(
  p public.proposals, r public.proposal_revisions, w public.work_items
) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT r.revision = p.revision AND kordos_planning.project_access(p.project_id) = 'lead'
    AND kordos_reviews.effective_status(p, r) = 'pending'
    AND (p.work_id IS NULL OR (w.archived_at IS NULL AND w.version = r.target_version))
    AND jsonb_array_length(kordos_reviews.citations(r.evidence)) = jsonb_array_length(r.evidence)
$$;

-- Resolve subject data under the recipient's current scope. Queue records contain
-- identifiers only, so a deferred item cannot carry a stale private excerpt.
CREATE FUNCTION kordos_inbox.target(e public.inbox_entries)
RETURNS TABLE(title text, deadline date, active boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN e.reason = 'mention' THEN 'You were mentioned in a comment'
    WHEN e.reason = 'review' THEN coalesce(w.title, r.before->>'title', 'Proposal')
    WHEN e.reason = 'risk' THEN coalesce(f.assessment->'task'->>'title', 'Schedule risk')
    ELSE w.title
  END,
  CASE WHEN e.reason IN ('assignment', 'review') OR e.revision = w.deadline_revision
    THEN coalesce(w.deadline, w.commitment) END,
  coalesce(project.archived_at IS NULL AND CASE
    WHEN e.reason = 'mention' THEN c.id IS NOT NULL AND e.recipient_id = ANY(c.mention_ids)
      AND kordos_collaboration.subject_open(e.project_id, c.subject_kind, c.subject_id)
      AND NOT newer.has_entry
    WHEN e.reason = 'review' THEN kordos_inbox.review_ready(p, r, w)
    WHEN e.reason = 'risk' THEN f.status IN ('open','acknowledged')
      AND kordos_risks.comment_at(c) = f.source_at
      AND kordos_collaboration.subject_open(e.project_id, c.subject_kind, c.subject_id)
    ELSE w.archived_at IS NULL AND w.status <> 'done' AND CASE e.reason
      WHEN 'assignment' THEN w.owner_id = e.recipient_id
        AND kordos_planning.owner_eligible(e.project_id, e.recipient_id) AND NOT newer.has_entry
      WHEN 'due' THEN w.owner_id = e.recipient_id AND e.revision = w.deadline_revision
        AND kordos_planning.owner_eligible(e.project_id, e.recipient_id)
        AND statement_timestamp() >= times.reminder AND statement_timestamp() < times.due
      WHEN 'overdue' THEN w.owner_id = e.recipient_id AND e.revision = w.deadline_revision
        AND kordos_planning.owner_eligible(e.project_id, e.recipient_id) AND statement_timestamp() >= times.due
      WHEN 'escalation' THEN w.owner_id IS DISTINCT FROM e.recipient_id AND e.revision = w.deadline_revision
        AND e.recipient_id = (SELECT lead FROM kordos_inbox.leads(e.workspace_id, e.project_id) lead
          WHERE lead IS DISTINCT FROM w.owner_id LIMIT 1)
        AND statement_timestamp() >= times.escalation
      ELSE false
    END
  END, false)
  FROM public.projects project
  LEFT JOIN public.proposals p ON e.reason = 'review'
    AND (p.workspace_id, p.project_id, p.id) = (e.workspace_id, e.project_id, e.subject_id)
  LEFT JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision)
    = (p.workspace_id, p.project_id, p.id, e.revision)
  LEFT JOIN public.work_items w ON (w.workspace_id, w.project_id, w.id) = (e.workspace_id, e.project_id,
    CASE WHEN e.reason = 'review' THEN p.work_id
      WHEN e.reason IN ('assignment','due','overdue','escalation') THEN e.subject_id END)
  LEFT JOIN public.risk_findings f ON e.reason = 'risk'
    AND (f.workspace_id,f.project_id,f.id) = (e.workspace_id,e.project_id,e.subject_id)
  LEFT JOIN public.comments c ON (c.workspace_id,c.project_id,c.id) = (e.workspace_id,e.project_id,
    CASE WHEN e.reason = 'mention' THEN e.subject_id ELSE f.comment_id END)
  CROSS JOIN LATERAL (
    SELECT e.reason IN ('assignment','mention') AND EXISTS (
      SELECT FROM public.inbox_entries n WHERE (n.workspace_id, n.recipient_id, n.subject_id, n.reason)
        = (e.workspace_id, e.recipient_id, e.subject_id, e.reason) AND n.revision > e.revision
    ) AS has_entry
  ) newer
  LEFT JOIN public.inbox_preferences pref
    ON (pref.workspace_id, pref.user_id) = (w.workspace_id, w.owner_id)
  CROSS JOIN LATERAL kordos_inbox.deadline_times(coalesce(w.deadline,w.commitment), project.time_zone,
    coalesce((pref.settings->>'reminderDays')::int, 1),
    coalesce((pref.settings->>'escalationDays')::int, 2)) times
  WHERE (project.workspace_id, project.id) = (e.workspace_id,e.project_id)
    AND (e.workspace_id,e.recipient_id) = (kordos_identity.workspace_id(),kordos_identity.actor_id())
    AND kordos_planning.project_access(e.project_id) IS NOT NULL
    AND CASE e.reason
      WHEN 'mention' THEN c.id IS NOT NULL AND kordos_collaboration.subject_open(e.project_id, c.subject_kind, c.subject_id) IS NOT NULL
      WHEN 'risk' THEN f.id IS NOT NULL AND kordos_collaboration.subject_open(e.project_id, c.subject_kind, c.subject_id) IS NOT NULL
      WHEN 'review' THEN kordos_reviews.can_read(p) AND r.revision IS NOT NULL
        AND jsonb_array_length(kordos_reviews.citations(r.evidence)) = jsonb_array_length(r.evidence)
      ELSE w.id IS NOT NULL
    END
$$;

CREATE FUNCTION kordos_inbox.entry(e public.inbox_entries) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', e.id, 'projectId', e.project_id, 'projectName', p.name,
    'subjectId', e.subject_id, 'reason', e.reason, 'revision', e.revision, 'title', target.title, 'deadline', target.deadline,
    'receivedAt', e.delivered_at, 'readAt', e.read_at, 'resolved', NOT target.active)
  FROM kordos_inbox.target(e) target
  JOIN public.projects p ON (p.workspace_id, p.id) = (e.workspace_id, e.project_id)
  WHERE e.delivered_at IS NOT NULL
$$;

CREATE FUNCTION kordos_inbox.detail(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_inbox.entry(e) FROM public.inbox_entries e
  WHERE e.id = p_id AND (e.workspace_id, e.recipient_id) = (kordos_identity.workspace_id(), kordos_identity.actor_id())
$$;

CREATE FUNCTION kordos_inbox.directory(p_cursor uuid, p_reason text, p_state text, p_digest date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH cursor_row AS (
    SELECT delivered_at, id FROM public.inbox_entries e WHERE e.id = p_cursor AND kordos_inbox.entry(e) IS NOT NULL
  ), page AS (
    SELECT e.id, e.delivered_at, view.value FROM public.inbox_entries e
    CROSS JOIN LATERAL (SELECT kordos_inbox.entry(e) AS value) view
    WHERE (e.workspace_id, e.recipient_id) = (kordos_identity.workspace_id(), kordos_identity.actor_id())
      AND e.delivered_at IS NOT NULL AND (p_reason IS NULL OR e.reason = p_reason)
      AND (p_digest IS NULL OR (e.email_slot = p_digest AND e.email_result = 'sent'))
      AND (p_cursor IS NULL OR (e.delivered_at, e.id) < (SELECT delivered_at, id FROM cursor_row))
      AND view.value IS NOT NULL AND CASE p_state
        WHEN 'unread' THEN e.read_at IS NULL AND NOT (view.value->>'resolved')::boolean
        WHEN 'read' THEN e.read_at IS NOT NULL
        WHEN 'resolved' THEN (view.value->>'resolved')::boolean
        ELSE true
      END
    ORDER BY e.delivered_at DESC, e.id DESC LIMIT 31
  )
  SELECT jsonb_build_object('items', coalesce((SELECT jsonb_agg(value ORDER BY delivered_at DESC, id DESC)
    FROM (SELECT * FROM page LIMIT 30) limited), '[]'),
    'nextCursor', CASE WHEN (SELECT count(*) FROM page) > 30
      THEN (SELECT id FROM page OFFSET 29 LIMIT 1) END,
    'unreadCount', (SELECT count(*) FROM public.inbox_entries e
      CROSS JOIN LATERAL (SELECT kordos_inbox.entry(e) AS value) view
      WHERE (e.workspace_id, e.recipient_id) = (kordos_identity.workspace_id(), kordos_identity.actor_id())
        AND e.delivered_at IS NOT NULL AND e.read_at IS NULL AND NOT (view.value->>'resolved')::boolean))
  WHERE kordos_identity.current_role() IS NOT NULL
$$;

CREATE FUNCTION kordos_inbox.mark_read(p_id uuid, p_read boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE entry public.inbox_entries;
BEGIN
  IF kordos_inbox.detail(p_id) IS NULL THEN RETURN NULL; END IF;
  UPDATE public.inbox_entries SET read_at = CASE WHEN p_read THEN coalesce(read_at, statement_timestamp()) END
  WHERE id = p_id RETURNING * INTO entry;
  RETURN kordos_inbox.entry(entry);
END
$$;

CREATE FUNCTION kordos_inbox.review_milestone(w public.work_items) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  WITH RECURSIVE downstream(id) AS (
    SELECT w.id
    UNION
    SELECT edge.successor_id
    FROM downstream d
    JOIN public.dependency_edges edge ON (edge.workspace_id, edge.project_id, edge.predecessor_id)
      = (w.workspace_id, w.project_id, d.id)
  )
  SELECT item.title FROM downstream d
  JOIN public.work_items item ON (item.workspace_id, item.project_id, item.id) = (w.workspace_id, w.project_id, d.id)
  WHERE item.kind = 'milestone' AND item.archived_at IS NULL AND item.status <> 'done'
  ORDER BY coalesce(item.commitment, item.deadline), item.id LIMIT 1
$$;

CREATE FUNCTION kordos_inbox.home(p_sort text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH reviews AS MATERIALIZED (
    SELECT p.id, project.id AS project_id, project.name AS project_name,
      coalesce(w.title, r.before->>'title', 'Proposal') AS title,
      coalesce(w.deadline, w.commitment) AS deadline, coalesce(p.submitted_at, r.created_at) AS submitted_at,
      kordos_inbox.review_milestone(w) AS milestone
    FROM public.proposals p
    JOIN public.projects project ON (project.workspace_id, project.id) = (p.workspace_id, p.project_id)
    JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision)
      = (p.workspace_id, p.project_id, p.id, p.revision)
    LEFT JOIN public.work_items w ON (w.workspace_id, w.project_id, w.id) = (p.workspace_id, p.project_id, p.work_id)
    WHERE p.workspace_id = kordos_identity.workspace_id() AND project.archived_at IS NULL
      AND p.status = 'pending' AND kordos_inbox.review_ready(p, r, w)
  ), due AS (
    SELECT w.id, project.id AS project_id, project.name AS project_name, w.title,
      coalesce(w.deadline, w.commitment) AS deadline
    FROM public.work_items w
    JOIN public.projects project ON (project.workspace_id, project.id) = (w.workspace_id, w.project_id)
    WHERE (w.workspace_id, w.owner_id) = (kordos_identity.workspace_id(), kordos_identity.actor_id())
      AND w.status <> 'done' AND w.archived_at IS NULL AND project.archived_at IS NULL
      AND coalesce(w.deadline, w.commitment) <= (statement_timestamp() AT TIME ZONE project.time_zone)::date + 7
      AND kordos_planning.owner_eligible(project.id, w.owner_id)
    ORDER BY deadline, w.id LIMIT 5
  ), risks AS (
    SELECT f.id, project.id AS project_id, project.name AS project_name,
      coalesce(f.assessment->'task'->>'title', 'Schedule risk') AS title,
      f.created_at, f.assessment->>'severity' = 'at_risk' AS high
    FROM public.risk_findings f
    JOIN public.projects project ON (project.workspace_id, project.id) = (f.workspace_id, f.project_id)
    JOIN public.comments c ON (c.workspace_id, c.project_id, c.id) = (f.workspace_id, f.project_id, f.comment_id)
    WHERE f.workspace_id = kordos_identity.workspace_id() AND project.archived_at IS NULL
      AND f.status IN ('open','acknowledged') AND f.assessment->>'severity' IN ('at_risk','watch')
      AND kordos_risks.comment_at(c) = f.source_at
      AND kordos_collaboration.subject_open(project.id, c.subject_kind, c.subject_id)
    ORDER BY high DESC, f.created_at DESC, f.id LIMIT 5
  )
  SELECT jsonb_build_object(
    'pendingCount', (SELECT count(*) FROM reviews),
    'reviews', coalesce((SELECT jsonb_agg(value ORDER BY sort_milestone NULLS LAST, submitted_at, id)
      FROM (SELECT id, submitted_at, CASE WHEN p_sort = 'milestone' THEN milestone END AS sort_milestone,
        jsonb_build_object('subjectId', id, 'projectId', project_id, 'projectName', project_name,
          'title', title, 'deadline', deadline, 'requestedAt', submitted_at, 'milestone', milestone) AS value
        FROM reviews ORDER BY sort_milestone NULLS LAST, submitted_at, id LIMIT 5) listed), '[]'),
    'due', coalesce((SELECT jsonb_agg(jsonb_build_object('subjectId', id, 'projectId', project_id,
      'projectName', project_name, 'title', title, 'deadline', deadline) ORDER BY deadline, id) FROM due), '[]'),
    'risks', coalesce((SELECT jsonb_agg(jsonb_build_object('subjectId', id, 'projectId', project_id,
      'projectName', project_name, 'title', title, 'deadline', NULL) ORDER BY high DESC, created_at DESC, id) FROM risks), '[]'))
  WHERE kordos_identity.current_role() IS NOT NULL
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_inbox.schedule() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('kordos.inbox.schedule', 0)) THEN RETURN; END IF;

  INSERT INTO public.inbox_entries (workspace_id, project_id, recipient_id, subject_id, reason, revision)
  SELECT w.workspace_id, w.project_id, candidate.recipient, w.id, candidate.reason, w.deadline_revision
  FROM public.work_items w
  JOIN public.projects p ON (p.workspace_id, p.id) = (w.workspace_id, w.project_id)
  LEFT JOIN public.memberships m ON (m.workspace_id, m.user_id) = (w.workspace_id, w.owner_id)
  LEFT JOIN public.project_members pm ON (pm.workspace_id, pm.project_id, pm.user_id) = (w.workspace_id, w.project_id, w.owner_id)
  LEFT JOIN public.inbox_preferences pref ON (pref.workspace_id, pref.user_id) = (w.workspace_id, w.owner_id)
  CROSS JOIN LATERAL kordos_inbox.deadline_times(coalesce(w.deadline,w.commitment), p.time_zone,
    coalesce((pref.settings->>'reminderDays')::int, 1),
    coalesce((pref.settings->>'escalationDays')::int, 2)) times
  CROSS JOIN LATERAL (
    SELECT w.owner_id AS recipient, CASE WHEN statement_timestamp() >= times.due THEN 'overdue' ELSE 'due' END AS reason
    WHERE statement_timestamp() >= times.reminder AND m.role <> 'viewer' AND m.removed_at IS NULL
      AND pm.role IN ('lead','contributor') AND pm.removed_at IS NULL
    UNION ALL
    SELECT lead.user_id, 'escalation' FROM (
      SELECT user_id FROM kordos_inbox.leads(w.workspace_id, w.project_id) lead(user_id)
      WHERE user_id IS DISTINCT FROM w.owner_id LIMIT 1
    ) lead WHERE statement_timestamp() >= times.escalation
  ) candidate
  WHERE w.archived_at IS NULL AND w.status <> 'done' AND p.archived_at IS NULL
    AND coalesce(w.deadline, w.commitment) <= (statement_timestamp() AT TIME ZONE 'UTC')::date + 31
    AND NOT EXISTS (
      SELECT FROM public.inbox_entries e
      WHERE (e.workspace_id, e.recipient_id, e.subject_id, e.reason, e.revision)
        = (w.workspace_id, candidate.recipient, w.id, candidate.reason, w.deadline_revision)
        AND e.canceled_at IS NULL
    )
  ORDER BY coalesce(w.deadline, w.commitment), w.id, candidate.reason LIMIT 200
  ON CONFLICT (workspace_id, recipient_id, subject_id, reason, revision)
    DO UPDATE SET canceled_at = NULL, next_at = statement_timestamp()
    WHERE inbox_entries.canceled_at IS NOT NULL AND inbox_entries.delivered_at IS NULL;
END
$$;

CREATE FUNCTION kordos_inbox.advance() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  entry public.inbox_entries;
  settings jsonb;
  available_at timestamptz;
  now_at timestamptz := statement_timestamp();
  digest_at timestamptz;
  digest_day date;
  mode text;
BEGIN
  FOR entry IN SELECT * FROM public.inbox_entries
    WHERE delivered_at IS NULL AND canceled_at IS NULL AND next_at <= now_at
    ORDER BY next_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('kordos.workspace_id', entry.workspace_id::text, true),
      set_config('kordos.actor_id', entry.recipient_id::text, true);
    IF NOT coalesce((SELECT t.active FROM kordos_inbox.target(entry) t), false) THEN
      UPDATE public.inbox_entries SET canceled_at = now_at WHERE id = entry.id;
      CONTINUE;
    END IF;

    settings := kordos_inbox.settings(entry.workspace_id, entry.recipient_id);
    available_at := kordos_inbox.quiet_until(now_at, settings);
    IF available_at > now_at THEN
      UPDATE public.inbox_entries SET next_at = available_at WHERE id = entry.id;
      CONTINUE;
    END IF;

    mode := settings->'channels'->>entry.reason;
    digest_at := NULL;
    digest_day := NULL;
    IF mode = 'digest' THEN
      digest_day := (now_at AT TIME ZONE (settings->>'timeZone'))::date;
      digest_at := (digest_day + time '08:00') AT TIME ZONE (settings->>'timeZone');
      IF digest_at <= now_at THEN
        digest_day := digest_day + 1;
        digest_at := (digest_day + time '08:00') AT TIME ZONE (settings->>'timeZone');
      END IF;
    END IF;

    UPDATE public.inbox_entries SET delivered_at = now_at,
      email_at = CASE mode WHEN 'email' THEN now_at WHEN 'digest' THEN digest_at END,
      email_slot = digest_day
    WHERE id = entry.id;
  END LOOP;
END
$$;

CREATE FUNCTION kordos_inbox.next_email() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  entry public.inbox_entries;
  settings jsonb;
  recipient text;
  available_at timestamptz;
  now_at timestamptz := statement_timestamp();
  expiration timestamptz;
BEGIN
  FOR entry IN SELECT * FROM public.inbox_entries WHERE email_result IS NULL AND email_at <= now_at
    ORDER BY email_at, id LIMIT 50 FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM set_config('kordos.workspace_id', entry.workspace_id::text, true),
      set_config('kordos.actor_id', entry.recipient_id::text, true);
    settings := kordos_inbox.settings(entry.workspace_id, entry.recipient_id);
    expiration := CASE WHEN entry.email_slot IS NULL THEN entry.delivered_at + interval '20 hours'
      ELSE (entry.email_slot + 1)::timestamp AT TIME ZONE (settings->>'timeZone') END;
    IF now_at >= expiration THEN
      UPDATE public.inbox_entries SET email_result = 'failed' WHERE id = entry.id;
      CONTINUE;
    END IF;

    SELECT email INTO recipient FROM public.users WHERE id = entry.recipient_id AND email_verified;
    IF recipient IS NULL
      OR settings->'channels'->>entry.reason IS DISTINCT FROM
        (CASE WHEN entry.email_slot IS NULL THEN 'email' ELSE 'digest' END)
      OR NOT coalesce((SELECT t.active FROM kordos_inbox.target(entry) t), false) THEN
      UPDATE public.inbox_entries SET email_result = 'suppressed' WHERE id = entry.id;
      CONTINUE;
    END IF;

    available_at := kordos_inbox.quiet_until(now_at, settings);
    IF available_at > now_at THEN
      UPDATE public.inbox_entries SET email_at = available_at WHERE id = entry.id;
      CONTINUE;
    END IF;

    IF entry.email_slot IS NOT NULL AND EXISTS (
      SELECT FROM public.inbox_entries sibling
      WHERE (sibling.workspace_id, sibling.recipient_id, sibling.email_slot)
        = (entry.workspace_id, entry.recipient_id, entry.email_slot)
        AND sibling.email_result = 'sent'
    ) THEN
      UPDATE public.inbox_entries SET email_result = 'sent' WHERE id = entry.id;
      CONTINUE;
    END IF;

    RETURN jsonb_build_object('id', entry.id, 'workspaceId', entry.workspace_id, 'email', recipient,
      'reason', entry.reason, 'digest', entry.email_slot,
      'key', CASE WHEN entry.email_slot IS NULL THEN 'inbox/' || entry.id
        ELSE concat_ws('/', 'digest', entry.workspace_id, entry.recipient_id, entry.email_slot) END);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION kordos_inbox.finish_email(p_id uuid, p_result text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE public.inbox_entries SET email_attempts = email_attempts + 1,
    email_result = CASE WHEN p_result = 'sent' THEN 'sent'
      WHEN p_result = 'failed' OR email_attempts >= 4 THEN 'failed' END,
    email_at = statement_timestamp() + interval '30 seconds' * power(2, least(email_attempts, 4))
  WHERE id = p_id AND email_at IS NOT NULL AND email_result IS NULL
    AND (workspace_id, recipient_id) = (kordos_identity.workspace_id(), kordos_identity.actor_id())
    AND p_result IN ('sent', 'failed', 'retry')
$$;
--> statement-breakpoint
-- Existing actionable reviews and open risks are surfaced when inbox is first enabled.
INSERT INTO public.inbox_entries (workspace_id, project_id, recipient_id, subject_id, reason, revision)
SELECT p.workspace_id, p.project_id, recipient, p.id, 'review', p.revision
FROM public.proposals p
JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision)
  = (p.workspace_id, p.project_id, p.id, p.revision)
CROSS JOIN LATERAL kordos_inbox.leads(p.workspace_id, p.project_id) recipient
WHERE p.status = 'pending' AND r.expires_at > statement_timestamp()
UNION ALL
SELECT f.workspace_id, f.project_id, recipient, f.id, 'risk', f.version
FROM public.risk_findings f CROSS JOIN LATERAL kordos_inbox.leads(f.workspace_id, f.project_id) recipient
WHERE f.status IN ('open','acknowledged') AND f.assessment->>'severity' IN ('at_risk','watch');

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_inbox FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_inbox.directory(uuid,text,text,date), kordos_inbox.detail(uuid),
  kordos_inbox.mark_read(uuid,boolean), kordos_inbox.home(text), kordos_inbox.preferences(),
  kordos_inbox.save_preferences(int,jsonb) TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_inbox.schedule(), kordos_inbox.advance() TO kordos_app, kordos_brief_worker;
GRANT EXECUTE ON FUNCTION kordos_inbox.next_email(), kordos_inbox.finish_email(uuid,text) TO kordos_brief_worker;
