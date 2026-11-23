CREATE TABLE "meeting_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"key" text NOT NULL,
	"transcript_revision" integer NOT NULL,
	"suggestion" jsonb NOT NULL,
	"reviewed_values" jsonb,
	"status" text DEFAULT 'suggested' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"proposal_id" uuid,
	"work_id" uuid,
	"decision_id" uuid,
	CONSTRAINT "meeting_items_scope_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "meeting_items_key_unique" UNIQUE("workspace_id","project_id","meeting_id","key"),
	CONSTRAINT "meeting_items_work_unique" UNIQUE("work_id"),
	CONSTRAINT "meeting_items_decision_unique" UNIQUE("decision_id"),
	CONSTRAINT "meeting_items_state" CHECK ("meeting_items"."status" IN ('suggested','submitted','stale','accepted','rejected'))
);
--> statement-breakpoint
CREATE TABLE "meeting_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"extension" text NOT NULL,
	"digest" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meeting_media_scope_unique" UNIQUE("workspace_id","project_id","meeting_id","id"),
	CONSTRAINT "meeting_media_mutation_unique" UNIQUE("workspace_id","actor_id","mutation_id"),
	CONSTRAINT "meeting_media_metadata" CHECK ("meeting_media"."extension" IN ('wav','mp3','m4a') AND "meeting_media"."size" BETWEEN 1 AND 20971520)
);
--> statement-breakpoint
CREATE TABLE "meeting_transcripts" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"media_id" uuid,
	"author_id" uuid NOT NULL,
	"segments" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_transcripts_pk" PRIMARY KEY("workspace_id","project_id","meeting_id","revision")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organizer_id" uuid NOT NULL,
	"job_actor_id" uuid NOT NULL,
	"title" text NOT NULL,
	"agenda" text,
	"starts_at" timestamp with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"retention_days" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"transcript_revision" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'empty' NOT NULL,
	"mode" text,
	"failure" text,
	"pending_text" text,
	"lease" uuid,
	"lease_until" timestamp with time zone,
	CONSTRAINT "meetings_scope_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "meetings_state" CHECK ("meetings"."status" IN ('empty','queued','processing','ready','failed')
    AND "meetings"."attempt" BETWEEN 0 AND 3 AND "meetings"."retention_days" IN (7,30,90)
    AND ("meetings"."status" = 'processing') = ("meetings"."lease" IS NOT NULL AND "meetings"."lease_until" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "proposal_revisions" DROP CONSTRAINT "proposal_revisions_command";--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT "proposals_one_target";--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "meeting_item_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_items" ADD CONSTRAINT "meeting_items_transcript_fk" FOREIGN KEY ("workspace_id","project_id","meeting_id","transcript_revision") REFERENCES "public"."meeting_transcripts"("workspace_id","project_id","meeting_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_items" ADD CONSTRAINT "meeting_items_work_fk" FOREIGN KEY ("workspace_id","project_id","work_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_items" ADD CONSTRAINT "meeting_items_decision_fk" FOREIGN KEY ("workspace_id","project_id","decision_id") REFERENCES "public"."decisions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_media" ADD CONSTRAINT "meeting_media_meeting_fk" FOREIGN KEY ("workspace_id","project_id","meeting_id") REFERENCES "public"."meetings"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_media" ADD CONSTRAINT "meeting_media_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_meeting_fk" FOREIGN KEY ("workspace_id","project_id","meeting_id") REFERENCES "public"."meetings"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_media_fk" FOREIGN KEY ("workspace_id","project_id","meeting_id","media_id") REFERENCES "public"."meeting_media"("workspace_id","project_id","meeting_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_actor_fk" FOREIGN KEY ("workspace_id","author_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizer_fk" FOREIGN KEY ("workspace_id","organizer_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_actor_fk" FOREIGN KEY ("workspace_id","job_actor_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_media_active_idx" ON "meeting_media" USING btree ("workspace_id","project_id","meeting_id") WHERE "meeting_media"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_media_expiry_idx" ON "meeting_media" USING btree ("expires_at","id") WHERE "meeting_media"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meetings_project_date_idx" ON "meetings" USING btree ("workspace_id","project_id","starts_at","id");--> statement-breakpoint
CREATE INDEX "meetings_queue_idx" ON "meetings" USING btree ("lease_until","id") WHERE "meetings"."status" IN ('queued','processing');--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_meeting_item_fk" FOREIGN KEY ("workspace_id","project_id","meeting_item_id") REFERENCES "public"."meeting_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_meeting_item_idx" ON "proposals" USING btree ("meeting_item_id");--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_command" CHECK (coalesce("proposal_revisions"."command"->>'kind' IN ('work.edit', 'plan.create', 'meeting.accept'), false));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_one_target" CHECK (num_nonnulls("proposals"."work_id", "proposals"."brief_id", "proposals"."meeting_item_id") = 1);
--> statement-breakpoint
CREATE SCHEMA kordos_meetings;
REVOKE ALL ON SCHEMA kordos_meetings FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_meetings TO kordos_app, kordos_brief_worker;
ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_items ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION kordos_meetings.manage(m public.meetings) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(kordos_planning.project_access(m.project_id) = 'lead' OR
    (kordos_planning.project_access(m.project_id) = 'contributor' AND m.organizer_id = kordos_identity.actor_id()), false)
$$;

CREATE FUNCTION kordos_meetings.request(p_input jsonb, p_action text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('mutationId',p_input->'mutationId','_command','meeting.'||p_action,
    'hash',encode(sha256(convert_to(p_input::text,'UTF8')),'hex'))
$$;

CREATE FUNCTION kordos_meetings.summary(m public.meetings) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id',m.id,'title',m.title,'startsAt',m.starts_at,'status',m.status,
    'organizer',kordos_collaboration.person(m.organizer_id))
$$;

CREATE FUNCTION kordos_meetings.key(media public.meeting_media) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT 'workspaces/' || media.workspace_id || '/projects/' || media.project_id || '/meetings/' ||
    media.meeting_id || '/' || media.id || '.' || media.extension
$$;
CREATE FUNCTION kordos_meetings.available(media public.meeting_media) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT media.available_at IS NOT NULL AND media.removed_at IS NULL AND media.expires_at > statement_timestamp()
$$;

CREATE FUNCTION kordos_meetings.audio(p_project uuid,p_meeting uuid,p_media uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('key',kordos_meetings.key(media),'size',media.size,'extension',media.extension)
  FROM public.meeting_media media WHERE (media.workspace_id,media.project_id,media.meeting_id,media.id)
    = (kordos_identity.workspace_id(),p_project,p_meeting,p_media)
  AND kordos_planning.project_access(p_project) IS NOT NULL AND kordos_meetings.available(media)
$$;

CREATE FUNCTION kordos_meetings.directory(p_project uuid,p_cursor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH entries AS (
    SELECT m.id,m.starts_at,kordos_meetings.summary(m) AS value FROM public.meetings m
    WHERE (m.workspace_id,m.project_id) = (kordos_identity.workspace_id(),p_project)
      AND (p_cursor IS NULL OR (m.starts_at,m.id) < (SELECT starts_at,id FROM public.meetings
        WHERE (workspace_id,project_id,id)=(m.workspace_id,m.project_id,p_cursor)))
    ORDER BY m.starts_at DESC,m.id DESC LIMIT 31
  )
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(value ORDER BY starts_at DESC,id DESC)
    FROM (SELECT * FROM entries LIMIT 30) page),'[]'),
    'nextCursor',CASE WHEN (SELECT count(*) FROM entries)>30 THEN (SELECT id FROM entries OFFSET 29 LIMIT 1) END)
  WHERE kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE FUNCTION kordos_meetings.segment(p_workspace uuid,p_project uuid,p_meeting uuid,p_revision int,p_segment uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT segment FROM public.meeting_transcripts t CROSS JOIN LATERAL jsonb_array_elements(t.segments) segment
  WHERE (t.workspace_id,t.project_id,t.meeting_id,t.revision)=(p_workspace,p_project,p_meeting,p_revision)
    AND (segment->>'id')::uuid=p_segment
$$;

CREATE FUNCTION kordos_meetings.source(m public.meetings,anchor jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('kind','meeting','projectId',m.project_id,'id',m.id,'anchor',anchor)
$$;

CREATE FUNCTION kordos_meetings.item_unchanged(i public.meeting_items,m public.meetings) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT i.transcript_revision=m.transcript_revision OR
    kordos_meetings.segment(i.workspace_id,i.project_id,i.meeting_id,i.transcript_revision,
      (i.suggestion->'anchor'->>'segmentId')::uuid)
    IS NOT DISTINCT FROM kordos_meetings.segment(i.workspace_id,i.project_id,i.meeting_id,m.transcript_revision,
      (i.suggestion->'anchor'->>'segmentId')::uuid)
$$;

CREATE FUNCTION kordos_meetings.item_view(i public.meeting_items,m public.meetings) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id',i.id,'version',i.version,
    'values',coalesce(i.reviewed_values,i.suggestion),'anchor',i.suggestion->'anchor',
    'ownerExplicit',i.suggestion->'ownerExplicit','dateExplicit',i.suggestion->'dateExplicit',
    'status',CASE WHEN i.status='submitted' AND EXISTS (
      SELECT 1 FROM public.proposals p JOIN public.proposal_revisions r
        ON (r.workspace_id,r.project_id,r.proposal_id,r.revision)=(p.workspace_id,p.project_id,p.id,p.revision)
      WHERE p.id=i.proposal_id AND (p.status IN ('failed','expired','stale') OR
        (p.status IN ('draft','pending') AND r.expires_at<=statement_timestamp()))
    ) THEN 'stale' ELSE i.status END,
    'proposalId',(SELECT p.id FROM public.proposals p WHERE p.id=i.proposal_id AND kordos_reviews.can_read(p)),
    'workId',i.work_id,'decisionId',i.decision_id,
    'completedAt',(SELECT completed_at FROM public.work_items w WHERE w.id=i.work_id),
    'sourceChanged',NOT kordos_meetings.item_unchanged(i,m))
$$;

CREATE FUNCTION kordos_meetings.detail(p_project uuid,p_id uuid,p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_meetings.summary(m) || jsonb_build_object('version',m.version,'agenda',m.agenda,
    'timeZone',m.time_zone,'retentionDays',m.retention_days,'attempt',m.attempt,'failure',m.failure,
    'revision',m.transcript_revision,'audio',CASE WHEN available.id IS NOT NULL THEN 'available'
      WHEN EXISTS (SELECT 1 FROM public.meeting_media media WHERE media.meeting_id=m.id
        AND media.available_at IS NULL AND media.removed_at IS NULL AND media.expires_at>statement_timestamp()) THEN 'pending'
      WHEN EXISTS (SELECT 1 FROM public.meeting_media media WHERE media.meeting_id=m.id AND media.available_at IS NOT NULL)
        THEN 'unavailable' ELSE 'none' END,
    'expiresAt',available.expires_at,
    'transcript',CASE WHEN t.revision IS NOT NULL THEN jsonb_build_object('revision',t.revision,
      'createdAt',t.created_at,'author',kordos_collaboration.person(t.author_id),'segments',t.segments,
      'recordingId',CASE WHEN t.media_id=available.id THEN available.id END) END,
    'history',coalesce((SELECT jsonb_agg(jsonb_build_object('revision',entry.revision,'createdAt',entry.created_at)
      ORDER BY entry.revision DESC) FROM public.meeting_transcripts entry
      WHERE (entry.workspace_id,entry.project_id,entry.meeting_id)=(m.workspace_id,m.project_id,m.id)),'[]'),
    'items',coalesce((SELECT jsonb_agg(kordos_meetings.item_view(i,m) ORDER BY i.transcript_revision,i.key)
      FROM public.meeting_items i WHERE (i.workspace_id,i.project_id,i.meeting_id)=(m.workspace_id,m.project_id,m.id)),'[]'),
    'canManage',project.archived_at IS NULL AND kordos_meetings.manage(m),
    'canSubmit',project.archived_at IS NULL AND kordos_planning.project_access(p_project) IN ('contributor','lead'),
    'canReject',project.archived_at IS NULL AND kordos_planning.project_access(p_project)='lead')
  FROM public.meetings m JOIN public.projects project ON (project.workspace_id,project.id)=(m.workspace_id,m.project_id)
  LEFT JOIN public.meeting_media available ON (available.workspace_id,available.project_id,available.meeting_id)
    =(m.workspace_id,m.project_id,m.id) AND kordos_meetings.available(available)
  LEFT JOIN public.meeting_transcripts t ON (t.workspace_id,t.project_id,t.meeting_id,t.revision)
    =(m.workspace_id,m.project_id,m.id,coalesce(p_revision,m.transcript_revision))
  WHERE (m.workspace_id,m.project_id,m.id)=(kordos_identity.workspace_id(),p_project,p_id)
    AND kordos_planning.project_access(p_project) IS NOT NULL AND (p_revision IS NULL OR t.revision IS NOT NULL)
$$;

CREATE FUNCTION kordos_meetings.write(p_project uuid,p_id uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  action text := p_input->>'action';
  mutation uuid := (p_input->>'mutationId')::uuid;
  request jsonb := kordos_meetings.request(p_input,action);
  problem text;
  repeated jsonb;
  m public.meetings;
  t public.meeting_transcripts;
  previous_segment jsonb;
  corrected_segment jsonb;
  updated_segments jsonb;
  event_kind text;
BEGIN
  problem := kordos_knowledge.open_write(p_project,mutation);
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('result',problem); END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO m FROM public.meetings WHERE (workspace_id,project_id,id)=(tenant,p_project,p_id);
    IF NOT FOUND OR NOT kordos_meetings.manage(m) THEN RETURN jsonb_build_object('result','unavailable'); END IF;
  END IF;
  repeated := kordos_planning.replay(request,p_project,p_id);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;

  IF action='create' AND p_id IS NULL THEN
    INSERT INTO public.meetings (workspace_id,project_id,organizer_id,job_actor_id,title,agenda,starts_at,time_zone,retention_days)
    SELECT tenant,p_project,actor,actor,p_input->>'title',p_input->>'agenda',(p_input->>'startsAt')::timestamptz,time_zone,
      (p_input->>'retentionDays')::int FROM public.projects WHERE (workspace_id,id)=(tenant,p_project) RETURNING * INTO m;
    event_kind := 'meeting.created';
  ELSIF p_id IS NULL OR p_input->>'expectedVersion' IS NULL THEN
    RETURN jsonb_build_object('result','invalid_state');
  ELSIF m.version <> (p_input->>'expectedVersion')::int THEN
    RETURN jsonb_build_object('result','conflict');
  ELSIF action='remove-audio' THEN
    UPDATE public.meeting_media SET removed_at=clock_timestamp()
      WHERE (workspace_id,project_id,meeting_id)=(tenant,p_project,m.id) AND removed_at IS NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
    UPDATE public.meetings SET version=version+1,
      status=CASE WHEN mode='transcribe' AND transcript_revision=0 THEN 'empty' ELSE status END,
      failure=CASE WHEN mode='transcribe' THEN NULL ELSE failure END,
      lease=CASE WHEN mode='transcribe' THEN NULL ELSE lease END,
      lease_until=CASE WHEN mode='transcribe' THEN NULL ELSE lease_until END,
      mode=CASE WHEN mode='transcribe' THEN NULL ELSE mode END
      WHERE id=m.id RETURNING * INTO m;
    event_kind := 'meeting.audio_removed';
  ELSIF m.status IN ('queued','processing') THEN
    RETURN jsonb_build_object('result','invalid_state');
  ELSIF action='edit' THEN
    IF m.starts_at IS DISTINCT FROM (p_input->>'startsAt')::timestamptz THEN
      UPDATE public.meeting_items SET status='stale',version=version+1
        WHERE (workspace_id,project_id,meeting_id)=(tenant,p_project,m.id) AND status IN ('suggested','submitted');
    END IF;
    UPDATE public.meetings SET title=p_input->>'title',agenda=p_input->>'agenda',
      starts_at=(p_input->>'startsAt')::timestamptz,retention_days=(p_input->>'retentionDays')::int,version=version+1
      WHERE id=m.id RETURNING * INTO m;
    UPDATE public.meeting_media SET expires_at=created_at+make_interval(days=>m.retention_days)
      WHERE (workspace_id,project_id,meeting_id)=(tenant,p_project,m.id) AND removed_at IS NULL
        AND expires_at>clock_timestamp();
    event_kind := 'meeting.edited';
  ELSIF (action='paste' AND m.transcript_revision=0)
    OR (action='retry' AND m.status='failed' AND m.attempt<3)
    OR (action='reprocess' AND m.transcript_revision>0) THEN
    IF action='retry' AND (m.mode IS NULL OR (m.mode='transcribe' AND NOT EXISTS (
      SELECT 1 FROM public.meeting_media media WHERE media.meeting_id=m.id AND kordos_meetings.available(media)
    ))) THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
    UPDATE public.meetings SET status='queued',failure=NULL,version=version+1,generation=generation+1,
      job_actor_id=actor,attempt=CASE WHEN action='retry' THEN attempt+1 ELSE 1 END,
      mode=CASE action WHEN 'paste' THEN 'paste' WHEN 'reprocess' THEN 'extract' ELSE mode END,
      pending_text=CASE WHEN action='paste' THEN p_input->>'content' ELSE pending_text END
      WHERE id=m.id RETURNING * INTO m;
    event_kind := 'meeting.queued';
  ELSIF action='correct' AND m.transcript_revision>0 THEN
    SELECT * INTO STRICT t FROM public.meeting_transcripts WHERE (workspace_id,project_id,meeting_id,revision)
      =(tenant,p_project,m.id,m.transcript_revision);
    SELECT entry INTO previous_segment FROM jsonb_array_elements(t.segments) entry
      WHERE entry->>'id'=p_input->>'segmentId';
    IF previous_segment IS NULL THEN RETURN jsonb_build_object('result','unavailable'); END IF;
    corrected_segment := previous_segment || jsonb_build_object('text',p_input->>'text','speaker',p_input->>'speaker');
    IF corrected_segment=previous_segment THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
    SELECT jsonb_agg(CASE WHEN segment=previous_segment THEN corrected_segment ELSE segment END ORDER BY position)
      INTO updated_segments FROM jsonb_array_elements(t.segments) WITH ORDINALITY entries(segment,position);
    IF (SELECT sum(length(segment->>'text')) FROM jsonb_array_elements(updated_segments) segment)>80000 THEN
      RETURN jsonb_build_object('result','invalid_input');
    END IF;
    INSERT INTO public.meeting_transcripts (workspace_id,project_id,meeting_id,revision,media_id,author_id,segments)
      VALUES (tenant,p_project,m.id,m.transcript_revision+1,t.media_id,actor,updated_segments);
    UPDATE public.meeting_items SET status='stale',version=version+1
      WHERE (workspace_id,project_id,meeting_id)=(tenant,p_project,m.id)
        AND suggestion->'anchor'->>'segmentId'=p_input->>'segmentId' AND status IN ('suggested','submitted');
    UPDATE public.meetings SET transcript_revision=transcript_revision+1,version=version+1,status='ready',failure=NULL
      WHERE id=m.id RETURNING * INTO m;
    event_kind := 'meeting.transcript_corrected';
  ELSE
    RETURN jsonb_build_object('result','invalid_state');
  END IF;
  PERFORM kordos_planning.emit(p_project,m.id,event_kind,request,NULL,
    jsonb_build_object('version',m.version,'transcriptRevision',m.transcript_revision,'attempt',m.attempt));
  RETURN jsonb_build_object('result','saved','id',m.id);
END
$$;

CREATE FUNCTION kordos_meetings.upload(p_project uuid,p_id uuid,p_input jsonb,p_finish boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  request jsonb := kordos_meetings.request(p_input,'audio');
  m public.meetings;
  media public.meeting_media;
  prior jsonb;
  problem text;
BEGIN
  problem := kordos_knowledge.open_write(p_project,mutation);
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('result',problem); END IF;
  SELECT * INTO m FROM public.meetings WHERE (workspace_id,project_id,id)=(tenant,p_project,p_id);
  IF NOT FOUND OR NOT kordos_meetings.manage(m) THEN RETURN jsonb_build_object('result','unavailable'); END IF;
  prior := kordos_planning.replay(request,p_project,p_id);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO media FROM public.meeting_media WHERE (workspace_id,actor_id,mutation_id)=(tenant,actor,mutation);
  IF FOUND THEN
    IF (media.project_id,media.meeting_id,media.digest,media.size,media.extension) IS DISTINCT FROM
      (p_project,p_id,p_input->>'digest',(p_input->>'size')::int,p_input->>'extension') THEN
      RETURN jsonb_build_object('result','mutation_conflict');
    END IF;
    IF media.removed_at IS NOT NULL OR media.expires_at<=clock_timestamp() THEN
      RETURN jsonb_build_object('result','invalid_state');
    END IF;
  ELSIF p_finish THEN RETURN jsonb_build_object('result','invalid_state');
  ELSE
    IF m.version<>(p_input->>'expectedVersion')::int THEN RETURN jsonb_build_object('result','conflict'); END IF;
    IF m.transcript_revision<>0 OR m.status IN ('queued','processing') OR EXISTS (
      SELECT 1 FROM public.meeting_media other WHERE other.meeting_id=m.id AND other.removed_at IS NULL
    ) THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
    INSERT INTO public.meeting_media (workspace_id,project_id,meeting_id,actor_id,mutation_id,extension,digest,size,expires_at)
    VALUES (tenant,p_project,p_id,actor,mutation,p_input->>'extension',p_input->>'digest',(p_input->>'size')::int,
      clock_timestamp()+make_interval(days=>m.retention_days)) RETURNING * INTO media;
  END IF;
  IF NOT p_finish THEN
    RETURN jsonb_build_object('result','pending','key',kordos_meetings.key(media),'id',media.id);
  END IF;
  IF m.version<>(p_input->>'expectedVersion')::int OR m.status IN ('queued','processing') OR m.transcript_revision<>0 THEN
    UPDATE public.meeting_media SET removed_at=clock_timestamp() WHERE id=media.id;
    RETURN jsonb_build_object('result','conflict');
  END IF;
  UPDATE public.meeting_media SET available_at=clock_timestamp() WHERE id=media.id;
  UPDATE public.meetings SET version=version+1,generation=generation+1,status='queued',mode='transcribe',
    attempt=1,job_actor_id=actor,failure=NULL,pending_text=NULL WHERE id=m.id RETURNING * INTO m;
  PERFORM kordos_planning.emit(p_project,m.id,'meeting.audio_queued',request,NULL,jsonb_build_object('mediaId',media.id));
  RETURN jsonb_build_object('result','saved','id',m.id);
END
$$;

CREATE FUNCTION kordos_meetings.pending() RETURNS TABLE(id uuid,generation int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT m.id,m.generation FROM public.meetings m WHERE status='queued' OR
    (status='processing' AND lease_until<=statement_timestamp())
  ORDER BY lease_until NULLS LAST,id LIMIT 40
$$;

CREATE FUNCTION kordos_meetings.set_actor(m public.meetings) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM set_config('kordos.workspace_id',m.workspace_id::text,true);
  PERFORM set_config('kordos.actor_id',m.job_actor_id::text,true);
  PERFORM kordos_planning.lock_workspace(gen_random_uuid());
  PERFORM kordos_reviews.lock_projects(m.project_id,'[]');
END
$$;

CREATE FUNCTION kordos_meetings.can_process(m public.meetings) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT kordos_meetings.manage(m) AND EXISTS (SELECT 1 FROM public.projects p
    WHERE (p.workspace_id,p.id)=(m.workspace_id,m.project_id) AND p.archived_at IS NULL)
$$;

CREATE FUNCTION kordos_meetings.fail_job(m public.meetings,p_failure text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.meetings SET status='failed',failure=p_failure,lease=NULL,lease_until=NULL,version=version+1 WHERE id=m.id;
  PERFORM kordos_planning.emit(m.project_id,m.id,'meeting.processing_failed',
    jsonb_build_object('mutationId',gen_random_uuid()),NULL,
    jsonb_build_object('failure',p_failure,'attempt',m.attempt,'executor',true));
END
$$;

CREATE FUNCTION kordos_meetings.claim(p_id uuid,p_generation int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  m public.meetings;
  t public.meeting_transcripts;
  media public.meeting_media;
BEGIN
  SELECT * INTO m FROM public.meetings WHERE id=p_id AND generation=p_generation;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM kordos_meetings.set_actor(m);
  SELECT * INTO m FROM public.meetings WHERE id=p_id AND generation=p_generation
    AND (status='queued' OR (status='processing' AND lease_until<=clock_timestamp())) FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT kordos_meetings.can_process(m) OR m.status='processing' THEN
    PERFORM kordos_meetings.fail_job(m,CASE WHEN m.status='processing' THEN 'interrupted' ELSE 'access_changed' END);
    RETURN NULL;
  END IF;
  IF m.mode='transcribe' THEN
    SELECT * INTO media FROM public.meeting_media entry WHERE entry.meeting_id=m.id AND kordos_meetings.available(entry);
    IF NOT FOUND THEN PERFORM kordos_meetings.fail_job(m,'media_unavailable'); RETURN NULL; END IF;
  ELSIF m.mode='extract' THEN
    SELECT * INTO STRICT t FROM public.meeting_transcripts WHERE (workspace_id,project_id,meeting_id,revision)
      =(m.workspace_id,m.project_id,m.id,m.transcript_revision);
  END IF;
  UPDATE public.meetings SET status='processing',lease=gen_random_uuid(),
    lease_until=clock_timestamp()+interval '150 seconds',version=version+1
    WHERE id=m.id RETURNING * INTO m;
  PERFORM kordos_planning.emit(m.project_id,m.id,'meeting.processing',
    jsonb_build_object('mutationId',gen_random_uuid()),NULL,jsonb_build_object('attempt',m.attempt,'executor',true));
  RETURN jsonb_build_object('lease',m.lease,'mode',m.mode,'startsAt',m.starts_at,'timeZone',m.time_zone,
    'owners',kordos_planning.people(m.project_id)->'owners','text',m.pending_text,'transcript',t.segments,
    'revision',CASE WHEN m.mode='extract' THEN m.transcript_revision ELSE m.transcript_revision+1 END,
    'audio',CASE WHEN media.id IS NOT NULL THEN jsonb_build_object('key',kordos_meetings.key(media),
      'extension',media.extension,'size',media.size) END);
END
$$;

CREATE FUNCTION kordos_meetings.finish(p_id uuid,p_lease uuid,p_segments jsonb,p_items jsonb,p_failure text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  m public.meetings;
  media_id uuid;
  target_revision int;
  item jsonb;
BEGIN
  SELECT * INTO m FROM public.meetings WHERE id=p_id AND lease=p_lease AND status='processing';
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM kordos_meetings.set_actor(m);
  SELECT * INTO m FROM public.meetings WHERE id=p_id AND lease=p_lease AND status='processing' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT kordos_meetings.can_process(m) THEN
    PERFORM kordos_meetings.fail_job(m,'access_changed');
    RETURN;
  END IF;
  IF m.mode='transcribe' THEN
    SELECT entry.id INTO media_id FROM public.meeting_media entry WHERE entry.meeting_id=m.id AND kordos_meetings.available(entry);
    IF NOT FOUND THEN PERFORM kordos_meetings.fail_job(m,'media_unavailable'); RETURN; END IF;
  END IF;
  IF p_failure IS NOT NULL THEN PERFORM kordos_meetings.fail_job(m,p_failure); RETURN; END IF;

  target_revision := m.transcript_revision;
  IF m.mode<>'extract' THEN
    target_revision := target_revision+1;
    INSERT INTO public.meeting_transcripts (workspace_id,project_id,meeting_id,revision,media_id,author_id,segments)
      VALUES (m.workspace_id,m.project_id,m.id,target_revision,media_id,m.job_actor_id,p_segments);
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.meeting_items prior WHERE prior.meeting_id=m.id AND prior.status='accepted'
        AND prior.suggestion->'anchor'->>'segmentId'=item->'anchor'->>'segmentId'
        AND prior.suggestion->>'kind'=item->>'kind'
        AND lower(prior.suggestion->>'title')=lower(item->>'title')
    ) THEN
      INSERT INTO public.meeting_items (workspace_id,project_id,meeting_id,key,transcript_revision,suggestion)
      VALUES (m.workspace_id,m.project_id,m.id,item->>'key',target_revision,item)
      ON CONFLICT ON CONSTRAINT meeting_items_key_unique DO UPDATE SET
        suggestion=EXCLUDED.suggestion,transcript_revision=EXCLUDED.transcript_revision,
        version=public.meeting_items.version+1,status='suggested',reviewed_values=NULL,proposal_id=NULL
      WHERE public.meeting_items.status IN ('suggested','stale') OR (public.meeting_items.status='submitted' AND EXISTS (
        SELECT 1 FROM public.proposals p JOIN public.proposal_revisions r
          ON (r.workspace_id,r.project_id,r.proposal_id,r.revision)=(p.workspace_id,p.project_id,p.id,p.revision)
        WHERE p.id=public.meeting_items.proposal_id AND
          (p.status IN ('failed','stale','expired') OR r.expires_at<=clock_timestamp())
      ));
    END IF;
  END LOOP;
  UPDATE public.meetings SET status='ready',transcript_revision=target_revision,version=version+1,mode=NULL,
    failure=NULL,pending_text=NULL,lease=NULL,lease_until=NULL WHERE id=m.id;
  PERFORM kordos_planning.emit(m.project_id,m.id,'meeting.ready',
    jsonb_build_object('mutationId',gen_random_uuid()),NULL,jsonb_build_object('revision',target_revision,'executor',true));
END
$$;

CREATE FUNCTION kordos_meetings.cleanup() RETURNS TABLE(id uuid,key text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH due AS (
    SELECT media.id FROM public.meeting_media media WHERE media.deleted_at IS NULL
      AND ((media.removed_at IS NOT NULL AND (media.available_at IS NOT NULL OR media.removed_at<=clock_timestamp()-interval '1 minute'))
        OR media.expires_at<=clock_timestamp()
        OR (media.available_at IS NULL AND media.created_at<=clock_timestamp()-interval '1 hour'))
    ORDER BY coalesce(media.removed_at,media.expires_at),media.id FOR UPDATE SKIP LOCKED LIMIT 20
  )
  UPDATE public.meeting_media media SET removed_at=coalesce(media.removed_at,clock_timestamp())
  FROM due WHERE media.id=due.id RETURNING media.id,kordos_meetings.key(media)
$$;

CREATE FUNCTION kordos_meetings.cleaned(p_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE public.meeting_media SET deleted_at=clock_timestamp() WHERE id=p_id AND removed_at IS NOT NULL AND deleted_at IS NULL
$$;

CREATE FUNCTION kordos_meetings.citation(p_source jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('source',p_source,'title',m.title,
    'excerpt',substring(segment->>'text' FROM anchor.first_char+1 FOR anchor.last_char-anchor.first_char),
    'author',kordos_collaboration.person(t.author_id),'capturedAt',t.created_at,'newer',m.transcript_revision>t.revision,
    'subject',jsonb_build_object('kind','meeting','id',m.id),
    'clip',CASE WHEN segment->>'startMs' IS NOT NULL THEN jsonb_build_object(
      'recordingId',media.id,'startMs',segment->'startMs','endMs',segment->'endMs','speaker',segment->'speaker') END)
  FROM public.meetings m
  JOIN public.meeting_transcripts t ON (t.workspace_id,t.project_id,t.meeting_id)=(m.workspace_id,m.project_id,m.id)
  LEFT JOIN public.meeting_media media ON (media.workspace_id,media.project_id,media.meeting_id,media.id)
    =(t.workspace_id,t.project_id,t.meeting_id,t.media_id) AND kordos_meetings.available(media)
  CROSS JOIN LATERAL jsonb_array_elements(t.segments) segment
  CROSS JOIN LATERAL (SELECT (p_source->'anchor'->>'start')::int AS first_char,
    (p_source->'anchor'->>'end')::int AS last_char) anchor
  WHERE (m.workspace_id,m.project_id,m.id)=(kordos_identity.workspace_id(),(p_source->>'projectId')::uuid,(p_source->>'id')::uuid)
    AND kordos_planning.project_access(m.project_id) IS NOT NULL
    AND t.revision=(p_source->'anchor'->>'revision')::int AND segment->>'id'=p_source->'anchor'->>'segmentId'
    AND anchor.first_char>=0 AND anchor.last_char>anchor.first_char AND anchor.last_char<=length(segment->>'text')
$$;

CREATE FUNCTION kordos_meetings.valid_values(p_project uuid,i public.meeting_items,p_values jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(p_values->>'kind'=i.suggestion->>'kind'
    AND length(btrim(p_values->>'title')) BETWEEN 1 AND 160 AND coalesce(length(p_values->>'detail'),0)<=2000
    AND (p_values->>'ownerId' IS NULL OR kordos_planning.owner_eligible(p_project,(p_values->>'ownerId')::uuid))
    AND (p_values->>'kind'<>'decision' OR (p_values->>'ownerId' IS NOT NULL AND nullif(btrim(p_values->>'detail'),'') IS NOT NULL))
    AND (p_values->>'date' IS NULL OR (p_values->>'date')::date BETWEEN '0001-01-01'::date AND '9999-12-31'::date),false)
$$;

CREATE FUNCTION kordos_meetings.current_item(p public.proposals,r public.proposal_revisions) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.meeting_items i
    JOIN public.meetings m ON (m.workspace_id,m.project_id,m.id)=(i.workspace_id,i.project_id,i.meeting_id)
    WHERE (i.workspace_id,i.project_id,i.id)=(p.workspace_id,p.project_id,p.meeting_item_id)
      AND i.proposal_id=p.id AND i.version=r.target_version AND i.status='submitted'
      AND kordos_meetings.item_unchanged(i,m)
  )
$$;

CREATE FUNCTION kordos_meetings.write_item(p_project uuid,p_meeting uuid,p_item uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  action text := p_input->>'action';
  request jsonb := kordos_meetings.request(p_input,'item_'||action);
  m public.meetings;
  i public.meeting_items;
  p public.proposals;
  problem text;
  evidence jsonb;
  response jsonb;
  existing public.outbox;
BEGIN
  problem := kordos_knowledge.open_write(p_project,mutation);
  IF problem IS NOT NULL THEN RETURN jsonb_build_object('result',problem); END IF;
  IF action='reject' AND kordos_planning.project_access(p_project)<>'lead' THEN
    RETURN jsonb_build_object('result','forbidden');
  END IF;
  SELECT * INTO m FROM public.meetings WHERE (workspace_id,project_id,id)=(tenant,p_project,p_meeting);
  IF NOT FOUND THEN RETURN jsonb_build_object('result','unavailable'); END IF;
  SELECT * INTO i FROM public.meeting_items WHERE (workspace_id,project_id,meeting_id,id)=(tenant,p_project,p_meeting,p_item);
  IF NOT FOUND THEN RETURN jsonb_build_object('result','unavailable'); END IF;

  SELECT * INTO existing FROM public.outbox WHERE (workspace_id,actor_id,mutation_id)=(tenant,actor,mutation);
  IF FOUND THEN
    IF (existing.project_id,existing.target_id,existing.request) IS DISTINCT FROM (p_project,p_item,request) THEN
      RETURN jsonb_build_object('result','mutation_conflict');
    END IF;
    RETURN (SELECT details->'after'->'response' FROM public.audit_events WHERE id=existing.id);
  END IF;
  IF i.version<>(p_input->>'expectedVersion')::int THEN RETURN jsonb_build_object('result','conflict'); END IF;
  response := jsonb_build_object('result','saved','id',i.id);
  IF action='reject' AND i.status IN ('suggested','stale') THEN
    UPDATE public.meeting_items SET status='rejected',version=version+1 WHERE id=i.id;
  ELSIF action='submit' AND i.status='suggested' THEN
    IF NOT kordos_meetings.valid_values(p_project,i,p_input->'values') THEN
      RETURN jsonb_build_object('result','invalid_input');
    END IF;
    IF NOT kordos_meetings.item_unchanged(i,m) THEN RETURN jsonb_build_object('result','conflict'); END IF;
    evidence := kordos_meetings.source(m,i.suggestion->'anchor');
    IF kordos_meetings.citation(evidence) IS NULL THEN RETURN jsonb_build_object('result','conflict'); END IF;
    INSERT INTO public.proposals (workspace_id,project_id,meeting_item_id,requester_id,status,submitted_at)
      VALUES (tenant,p_project,i.id,actor,'pending',clock_timestamp()) RETURNING * INTO p;
    UPDATE public.meeting_items SET status='submitted',reviewed_values=p_input->'values',proposal_id=p.id,version=version+1
      WHERE id=i.id RETURNING * INTO i;
    INSERT INTO public.proposal_revisions (workspace_id,project_id,proposal_id,revision,author_id,target_version,command,before,evidence,expires_at)
      VALUES (tenant,p_project,p.id,1,actor,i.version,jsonb_build_object('kind','meeting.accept','item',p_input->'values'),
        jsonb_build_object('meetingId',m.id,'title',p_input->'values'->>'title'),jsonb_build_array(jsonb_build_object('source',evidence)),
        clock_timestamp()+interval '7 days');
    PERFORM kordos_reviews.event(p,'proposal.submitted',jsonb_build_object('mutationId',gen_random_uuid()));
    response := response || jsonb_build_object('id',p.id,'proposalId',p.id);
  ELSE RETURN jsonb_build_object('result','invalid_state'); END IF;
  PERFORM kordos_planning.emit(p_project,i.id,CASE WHEN action='submit' THEN 'meeting.item_submitted' ELSE 'meeting.item_rejected' END,
    request,NULL,jsonb_build_object('response',response,'meetingId',m.id));
  RETURN response;
END
$$;

CREATE FUNCTION kordos_meetings.apply_item(p public.proposals,r public.proposal_revisions,p_mutation uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  i public.meeting_items;
  m public.meetings;
  item jsonb := r.command->'item';
  outcome jsonb;
  result_work uuid;
  result_decision uuid;
  effect uuid;
BEGIN
  SELECT * INTO STRICT i FROM public.meeting_items WHERE id=p.meeting_item_id;
  SELECT * INTO STRICT m FROM public.meetings WHERE id=i.meeting_id;
  IF NOT kordos_meetings.valid_values(p.project_id,i,item) THEN RETURN NULL; END IF;
  BEGIN
    CASE item->>'kind'
      WHEN 'action' THEN
        outcome := kordos_planning.save_work(p.project_id,NULL,jsonb_build_object('kind','task','status','backlog',
          'title',item->'title','description',item->'detail','ownerId',item->'ownerId','deadline',item->'date','mutationId',gen_random_uuid()));
        IF outcome->>'result' IS DISTINCT FROM 'saved' THEN RAISE SQLSTATE 'KMA01'; END IF;
        result_work := (outcome->>'id')::uuid;
      WHEN 'decision' THEN
        outcome := kordos_knowledge.save_decision(p.project_id,NULL,jsonb_build_object('action','draft',
          'question',item->'title','conclusion',item->'detail','accountableId',item->'ownerId',
          'effectiveDate',coalesce((item->>'date')::date,(m.starts_at AT TIME ZONE m.time_zone)::date),
          'evidence',jsonb_build_array(r.evidence->0->'source'),'mutationId',gen_random_uuid()));
        IF outcome->>'result' IS DISTINCT FROM 'saved' THEN RAISE SQLSTATE 'KMA01'; END IF;
        result_decision := (outcome->>'id')::uuid;
        outcome := kordos_knowledge.save_decision(p.project_id,result_decision,jsonb_build_object('action','confirm',
          'expectedVersion',1,'mutationId',gen_random_uuid()));
        IF outcome->>'result' IS DISTINCT FROM 'saved' THEN RAISE SQLSTATE 'KMA01'; END IF;
      WHEN 'question' THEN NULL;
      ELSE RAISE SQLSTATE 'KMA01';
    END CASE;
    UPDATE public.meeting_items SET status='accepted',version=version+1,work_id=result_work,decision_id=result_decision
      WHERE id=i.id;
    PERFORM kordos_planning.emit(p.project_id,p.id,'proposal.meeting_accepted',
      jsonb_build_object('mutationId',p_mutation),NULL,
      jsonb_build_object('revision',p.revision,'meetingId',m.id,'itemId',i.id,'workId',result_work,'decisionId',result_decision,'executor',true));
    SELECT id INTO STRICT effect FROM public.outbox WHERE (workspace_id,actor_id,mutation_id)
      =(p.workspace_id,kordos_identity.actor_id(),p_mutation);
    RETURN effect;
  EXCEPTION WHEN SQLSTATE 'KMA01' THEN RETURN NULL;
  END;
END
$$;

CREATE FUNCTION kordos_meetings.work_origin(p_project uuid,p_work uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('origin',(
    SELECT jsonb_build_object('meetingId',m.id,'title',m.title,'anchor',i.suggestion->'anchor','proposalId',i.proposal_id)
    FROM public.meeting_items i JOIN public.meetings m ON (m.workspace_id,m.project_id,m.id)=(i.workspace_id,i.project_id,i.meeting_id)
    WHERE (i.workspace_id,i.project_id,i.work_id)=(kordos_identity.workspace_id(),p_project,p_work)
  ))
  WHERE kordos_planning.project_access(p_project) IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.work_items WHERE (workspace_id,project_id,id)=(kordos_identity.workspace_id(),p_project,p_work)
  )
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kordos_meetings FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_meetings.directory(uuid,uuid), kordos_meetings.detail(uuid,uuid,int),
  kordos_meetings.write(uuid,uuid,jsonb), kordos_meetings.write_item(uuid,uuid,uuid,jsonb),
  kordos_meetings.upload(uuid,uuid,jsonb,boolean), kordos_meetings.audio(uuid,uuid,uuid),
  kordos_meetings.work_origin(uuid,uuid) TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_meetings.pending(), kordos_meetings.claim(uuid,int),
  kordos_meetings.finish(uuid,uuid,jsonb,jsonb,text), kordos_meetings.cleanup(), kordos_meetings.cleaned(uuid)
  TO kordos_brief_worker;

CREATE OR REPLACE FUNCTION kordos_collaboration.subject_open(p_project uuid, p_kind text, p_subject uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_kind = 'project' AND p_subject = p_project THEN p.archived_at IS NULL
    WHEN p_kind = 'task' AND w.id IS NOT NULL THEN p.archived_at IS NULL AND w.archived_at IS NULL
    WHEN p_kind = 'meeting' AND meeting.id IS NOT NULL THEN p.archived_at IS NULL
    WHEN p_kind = 'document' AND d.id IS NOT NULL THEN p.archived_at IS NULL AND d.archived_at IS NULL
  END
  FROM public.projects p
  LEFT JOIN public.work_items w ON p_kind = 'task'
    AND (w.workspace_id, w.project_id, w.id) = (p.workspace_id, p.id, p_subject)
  LEFT JOIN public.documents d ON p_kind = 'document'
    AND (d.workspace_id, d.project_id, d.id) = (p.workspace_id, p.id, p_subject)
  LEFT JOIN public.meetings meeting ON p_kind='meeting'
    AND (meeting.workspace_id,meeting.project_id,meeting.id)=(p.workspace_id,p.id,p_subject)
  WHERE p.workspace_id = kordos_identity.workspace_id() AND p.id = p_project
    AND kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION kordos_knowledge.citation(p_source jsonb) RETURNS jsonb
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
    WHEN 'meeting' THEN RETURN kordos_meetings.citation(p_source);
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

CREATE OR REPLACE FUNCTION kordos_reviews.summary(
  p public.proposals, project public.projects, w public.work_items, r public.proposal_revisions
) RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id', p.id, 'projectId', p.project_id, 'projectName', project.name,
    'workId', w.id, 'briefId', p.brief_id, 'meetingId', r.before->>'meetingId', 'meetingItemId', p.meeting_item_id,
    'title', coalesce(w.title, r.before->>'title'), 'kind', coalesce(w.kind::text, CASE WHEN p.meeting_item_id IS NOT NULL THEN 'meeting' ELSE 'plan' END), 'revision', r.revision,
    'status', kordos_reviews.effective_status(p, r), 'requester', kordos_collaboration.person(p.requester_id),
    'requestedAt', CASE WHEN p.status = 'draft' THEN r.created_at ELSE coalesce(p.submitted_at, r.created_at) END)
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.detail_before_risks(p_id uuid, p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_reviews.summary(p, project, w, r) || jsonb_build_object(
    'version', p.version, 'revisionHead', p.revision, 'targetVersion', r.target_version, 'currentTargetVersion', coalesce(w.version, r.target_version),
    'expiresAt', r.expires_at, 'author', kordos_collaboration.person(r.author_id),
    'status', CASE WHEN current_revision THEN current_status ELSE coalesce(e.status, 'stale') END,
    'reviewer', kordos_collaboration.person(coalesce(e.reviewer_id, CASE WHEN current_revision THEN p.reviewer_id END)),
    'reviewedAt', coalesce(e.approved_at, CASE WHEN current_revision THEN p.reviewed_at END),
    'reason', CASE WHEN current_revision AND all_visible THEN p.reason END,
    'evidence', visibility.evidence, 'evidenceRestricted', NOT all_visible,
    'before', CASE WHEN all_visible AND p.work_id IS NOT NULL THEN r.before END,
    'plan', CASE WHEN all_visible THEN r.command->'plan' END,
    'createdWork', CASE WHEN p.brief_id IS NOT NULL AND all_visible THEN coalesce(effect.details->'after'->'workIds', '{}') END,
    'meetingItem', CASE WHEN all_visible THEN r.command->'item' END,
    'meetingWorkId', CASE WHEN p.meeting_item_id IS NOT NULL AND all_visible THEN effect.details->'after'->>'workId' END,
    'meetingDecisionId', CASE WHEN p.meeting_item_id IS NOT NULL AND all_visible THEN effect.details->'after'->>'decisionId' END,
    'after', CASE WHEN all_visible THEN r.command->'values' END,
    'owners', CASE WHEN all_visible THEN (
      SELECT coalesce(jsonb_agg(kordos_collaboration.person(u.id) ORDER BY u.id), '[]')
      FROM (SELECT DISTINCT id::uuid FROM unnest(ARRAY[
        r.before->>'ownerId', r.before->>'blockerOwnerId',
        r.command->'values'->>'ownerId', r.command->'values'->>'blockerOwnerId', r.command->'item'->>'ownerId']) id WHERE id IS NOT NULL
      UNION SELECT (task->>'ownerId')::uuid AS id FROM jsonb_array_elements(r.command->'plan'->'tasks') task
      WHERE task->>'ownerId' IS NOT NULL) u
    ) ELSE '[]'::jsonb END,
    'canEdit', p.meeting_item_id IS NULL AND editable AND current_status NOT IN ('applied', 'rejected', 'reconciliation_required'),
    'canSubmit', p.meeting_item_id IS NULL AND editable AND current_status = 'draft' AND p.reviewer_id IS NULL AND (p.brief_id IS NOT NULL OR w.version = r.target_version) AND all_visible,
    'canReview', writable AND access = 'lead' AND current_status = 'pending' AND current_revision
      AND all_visible,
    'receipt', CASE WHEN e.id IS NOT NULL THEN jsonb_build_object(
      'id', e.id, 'status', e.status, 'reviewer', kordos_collaboration.person(e.reviewer_id),
      'approvedAt', e.approved_at, 'finishedAt', e.finished_at, 'issue', e.issue,
      'effectEventId', e.effect_event_id, 'auditId', coalesce(e.outcome_audit_id, e.approval_audit_id)) END)
  FROM public.proposals p
  JOIN public.projects project ON (project.workspace_id, project.id) = (p.workspace_id, p.project_id)
  LEFT JOIN public.work_items w ON (w.workspace_id, w.project_id, w.id) = (p.workspace_id, p.project_id, p.work_id)
  JOIN public.proposal_revisions r ON (r.workspace_id, r.project_id, r.proposal_id, r.revision)
    = (p.workspace_id, p.project_id, p.id, coalesce(p_revision, p.revision))
  LEFT JOIN public.executions e ON (e.workspace_id, e.project_id, e.proposal_id, e.revision)
    = (r.workspace_id, r.project_id, r.proposal_id, r.revision)
  LEFT JOIN public.audit_events effect ON effect.id = e.effect_event_id
  CROSS JOIN LATERAL (SELECT kordos_planning.project_access(p.project_id) AS access,
    kordos_reviews.effective_status(p, r) AS current_status, p.revision = r.revision AS current_revision,
    project.archived_at IS NULL AND w.archived_at IS NULL AS writable,
    kordos_reviews.citations(r.evidence) AS evidence) visibility
  CROSS JOIN LATERAL (SELECT jsonb_array_length(visibility.evidence) = jsonb_array_length(r.evidence) AS all_visible,
    writable AND current_revision AND (access = 'lead' OR
      (access = 'contributor' AND p.requester_id = kordos_identity.actor_id())) AS editable) permissions
  WHERE p.id = p_id AND kordos_reviews.can_read(p)
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.mutate_before_risks(p_project uuid, p_id uuid, p_action text, p_input jsonb)
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
  b public.brief_jobs;
  target_brief uuid;
  problem text;
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
    sources := coalesce(p_input->'evidence', '[]');
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

  target_brief := coalesce(p.brief_id, CASE WHEN p_action = 'create' THEN (p_input->>'briefId')::uuid END);
  IF p.meeting_item_id IS NOT NULL THEN
    IF p_action IN ('revise','submit') THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
    IF p_action='approve' AND NOT kordos_meetings.current_item(p,r) THEN
      RETURN jsonb_build_object('result','evidence_changed');
    END IF;
  ELSIF target_brief IS NOT NULL THEN
    SELECT * INTO b FROM public.brief_jobs WHERE (workspace_id, project_id, id) = (tenant, project, target_brief);
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
    IF p_action = 'create' AND NOT kordos_briefs.editable(b) THEN RETURN jsonb_build_object('result', 'forbidden'); END IF;
    IF p_action = 'create' AND EXISTS (SELECT 1 FROM public.proposals WHERE proposals.brief_id = b.id) THEN
      RETURN jsonb_build_object('result', 'conflict');
    END IF;
    target_version := b.source_revision;
  ELSE
    SELECT * INTO w FROM public.work_items WHERE (workspace_id, project_id, id)
      = (tenant, project, coalesce(p.work_id, (p_input->>'workId')::uuid));
    IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;
  END IF;
  SELECT archived_at IS NULL AND w.archived_at IS NULL INTO STRICT writable
    FROM public.projects WHERE id = project AND workspace_id = tenant;
  IF NOT writable THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;

  IF p_action IN ('create', 'revise') THEN
    IF p.status IN ('applied', 'rejected', 'reconciliation_required') THEN
      RETURN jsonb_build_object('result', 'invalid_state');
    END IF;
    IF b.id IS NOT NULL THEN
      problem := kordos_briefs.plan_issue(project, p_input->'plan');
      IF problem IS NOT NULL THEN RETURN jsonb_build_object('result', problem); END IF;
      sources := kordos_briefs.sources(b, p_input->'plan');
      IF sources IS NULL THEN RETURN jsonb_build_object('result', 'evidence_changed'); END IF;
    ELSE
      IF w.version IS DISTINCT FROM target_version THEN RETURN jsonb_build_object('result', 'target_changed'); END IF;
      IF p_input->'command'->>'kind' IS DISTINCT FROM 'work.edit'
        OR p_input->'command'->'values'->>'kind' IS DISTINCT FROM w.kind::text THEN
        RETURN jsonb_build_object('result', 'invalid_state');
      END IF;
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
      INSERT INTO public.proposals (workspace_id, project_id, work_id, brief_id, requester_id)
        VALUES (tenant, project, w.id, b.id, actor) RETURNING * INTO p;
    ELSE
      SELECT * INTO e FROM public.executions WHERE (workspace_id, project_id, proposal_id, revision)
        = (tenant, project, p.id, p.revision) AND status IN ('approved', 'applying') FOR UPDATE;
      IF FOUND THEN PERFORM kordos_reviews.finish(e, p, 'stale', 'superseded'); END IF;
      UPDATE public.proposals SET revision = revision + 1, version = version + 1, status = 'draft',
        reviewed_at = NULL, reviewer_id = NULL, reason = NULL WHERE id = p.id RETURNING * INTO p;
    END IF;
    INSERT INTO public.proposal_revisions (workspace_id, project_id, proposal_id, revision, author_id,
      target_version, command, before, evidence, expires_at)
    VALUES (tenant, project, p.id, p.revision, actor, target_version,
      CASE WHEN b.id IS NULL THEN p_input->'command' ELSE jsonb_build_object('kind', 'plan.create', 'plan', p_input->'plan') END,
      CASE WHEN b.id IS NULL THEN kordos_planning.work_snapshot(w) ELSE (
        SELECT jsonb_build_object('title', title) FROM public.document_versions
        WHERE (workspace_id, project_id, document_id, revision) = (tenant, project, b.document_id, b.source_revision)
      ) END, links, expires);

  ELSIF (p_action = 'submit' AND p.status = 'draft' AND p.reviewer_id IS NULL) OR
      (p_action IN ('approve', 'request_edit', 'reject') AND p.status = 'pending') THEN
    IF r.expires_at <= clock_timestamp() THEN RETURN jsonb_build_object('result', 'expired'); END IF;
    IF p_action IN ('approve', 'submit') THEN
      IF b.id IS NULL AND p.meeting_item_id IS NULL AND w.version <> r.target_version THEN RETURN jsonb_build_object('result', 'target_changed'); END IF;
      IF b.id IS NOT NULL THEN
        problem := kordos_briefs.plan_issue(project, r.command->'plan');
        IF problem IS NOT NULL THEN RETURN jsonb_build_object('result', problem); END IF;
      END IF;
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

  IF p.meeting_item_id IS NOT NULL AND p_action IN ('reject','request_edit') THEN
    UPDATE public.meeting_items SET status=CASE WHEN p_action='reject' THEN 'rejected' ELSE 'suggested' END,
      version=version+1,reviewed_values=CASE WHEN p_action='reject' THEN reviewed_values END,
      proposal_id=CASE WHEN p_action='reject' THEN proposal_id END
    WHERE id=p.meeting_item_id AND proposal_id=p.id AND status='submitted';
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

CREATE OR REPLACE FUNCTION kordos_reviews.run_before_risks(p_execution uuid, p_step text) RETURNS boolean
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

  IF p.meeting_item_id IS NOT NULL THEN
    IF NOT kordos_meetings.current_item(p,r) THEN
      PERFORM kordos_reviews.finish(e,p,'stale','evidence_changed');
      RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM public.projects WHERE (workspace_id,id)=(p.workspace_id,p.project_id) AND archived_at IS NOT NULL) THEN
      PERFORM kordos_reviews.finish(e,p,'stale','target_unavailable');
      RETURN false;
    END IF;
    effect_id := kordos_meetings.apply_item(p,r,e.write_mutation_id);
    IF effect_id IS NULL THEN
      PERFORM kordos_reviews.finish(e,p,'failed','invalid_change');
      RETURN false;
    END IF;
    PERFORM kordos_reviews.finish(e,p,'applied',NULL,effect_id);
    RETURN true;
  END IF;

  IF p.brief_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.projects WHERE workspace_id = p.workspace_id AND id = p.project_id AND archived_at IS NOT NULL) THEN
      PERFORM kordos_reviews.finish(e, p, 'stale', 'target_unavailable');
      RETURN false;
    END IF;
    effect_id := kordos_briefs.apply_plan(p, r.command->'plan', e.write_mutation_id);
    IF effect_id IS NULL THEN
      PERFORM kordos_reviews.finish(e, p, 'failed', 'invalid_change');
      RETURN false;
    END IF;
    PERFORM kordos_reviews.finish(e, p, 'applied', NULL, effect_id);
    RETURN true;
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

CREATE OR REPLACE FUNCTION kordos_reviews.effective_status(p public.proposals, r public.proposal_revisions)
RETURNS public.proposal_status LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p.status IN ('draft','pending') AND r.expires_at <= statement_timestamp() THEN 'expired'::public.proposal_status
    WHEN p.status IN ('draft','pending','approved','applying') AND EXISTS (
      SELECT 1 FROM public.risk_replans binding JOIN public.risk_findings f ON f.id = binding.finding_id
      JOIN public.comments c ON (c.workspace_id,c.project_id,c.id) = (f.workspace_id,f.project_id,f.comment_id)
      WHERE binding.proposal_id = p.id AND (NOT kordos_risks.current_finding(f)
        OR (r.evidence->0->>'version')::int IS DISTINCT FROM c.version)
    ) THEN 'stale'::public.proposal_status
    WHEN p.meeting_item_id IS NOT NULL AND p.status IN ('pending','approved','applying')
      AND NOT kordos_meetings.current_item(p,r) THEN 'stale'::public.proposal_status
    ELSE p.status END
$$;

CREATE OR REPLACE FUNCTION kordos_reviews.audit(p_filter jsonb) RETURNS jsonb
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
      'actorType', CASE WHEN e.id IS NOT NULL OR (CASE WHEN a.action LIKE 'brief.%' OR a.action LIKE 'risk.%' OR a.action LIKE 'meeting.%' THEN a.details->'after' ELSE meta END)->>'executor' = 'true' THEN 'service' ELSE 'user' END,
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
