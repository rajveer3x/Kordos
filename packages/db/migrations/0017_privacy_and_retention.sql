CREATE TABLE "workspace_retention" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"audio_days" integer DEFAULT 90 NOT NULL,
	"transcript_days" integer DEFAULT 365 NOT NULL,
	"imported_days" integer DEFAULT 365 NOT NULL,
	"log_days" integer DEFAULT 90 NOT NULL,
	"access_epoch" bigint DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone,
	CONSTRAINT "workspace_retention_days" CHECK (
      "workspace_retention"."audio_days" BETWEEN 1 AND 90 AND "workspace_retention"."transcript_days" BETWEEN 1 AND 3650
      AND "workspace_retention"."imported_days" BETWEEN 1 AND 3650 AND "workspace_retention"."log_days" BETWEEN 1 AND 365)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_shares" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_revisions" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_retention" ADD CONSTRAINT "workspace_retention_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_events_retention_idx" ON "audit_events" USING btree ("workspace_id","created_at","id") WHERE "audit_events"."redacted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "connector_shares_retention_idx" ON "connector_shares" USING btree ("workspace_id","revoked_at","id") WHERE "connector_shares"."purged_at" IS NULL AND "connector_shares"."revoked_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "meeting_transcripts_retention_idx" ON "meeting_transcripts" USING btree ("workspace_id","created_at","meeting_id","revision") WHERE "meeting_transcripts"."purged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "source_revisions_retention_idx" ON "source_revisions" USING btree ("workspace_id","observed_at","source_id","revision") WHERE "source_revisions"."purged_at" IS NULL AND "source_revisions"."title" IS NOT NULL;
--> statement-breakpoint
CREATE SCHEMA kordos_retention;
REVOKE ALL ON SCHEMA kordos_retention FROM PUBLIC;
GRANT USAGE ON SCHEMA kordos_retention TO kordos_app, kordos_brief_worker;
ALTER TABLE public.workspace_retention ENABLE ROW LEVEL SECURITY;

INSERT INTO public.workspace_retention (workspace_id) SELECT id FROM public.workspaces;
CREATE FUNCTION kordos_retention.create_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.workspace_retention (workspace_id) VALUES (NEW.id);
  RETURN NEW;
END
$$;
CREATE TRIGGER workspace_retention_defaults AFTER INSERT ON public.workspaces
FOR EACH ROW EXECUTE FUNCTION kordos_retention.create_policy();

CREATE FUNCTION kordos_retention.audio_expiry(m public.meeting_media) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT least(m.expires_at,m.created_at + make_interval(days => r.audio_days))
  FROM public.workspace_retention r WHERE r.workspace_id=m.workspace_id
$$;

CREATE FUNCTION kordos_retention.transcript_visible(t public.meeting_transcripts) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT t.purged_at IS NULL AND t.created_at > statement_timestamp() - make_interval(days => r.transcript_days)
  FROM public.workspace_retention r WHERE r.workspace_id=t.workspace_id
$$;

CREATE FUNCTION kordos_retention.import_visible(s public.source_revisions) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT s.purged_at IS NULL AND s.title IS NOT NULL
    AND s.observed_at > statement_timestamp() - make_interval(days => r.imported_days)
  FROM public.workspace_retention r WHERE r.workspace_id=s.workspace_id
$$;

CREATE FUNCTION kordos_retention.access_epoch() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT access_epoch::text FROM public.workspace_retention
  WHERE workspace_id=kordos_identity.workspace_id() AND kordos_identity.current_role() IS NOT NULL
$$;

CREATE FUNCTION kordos_retention.bump(p_workspace uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog AS $$
  UPDATE public.workspace_retention SET access_epoch=access_epoch+1 WHERE workspace_id=p_workspace
$$;

CREATE FUNCTION kordos_retention.access_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM kordos_retention.bump(NEW.workspace_id);
  RETURN NEW;
END
$$;
CREATE TRIGGER retention_share_access AFTER UPDATE OF revoked_at ON public.connector_shares
FOR EACH ROW WHEN (OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
EXECUTE FUNCTION kordos_retention.access_changed();
CREATE TRIGGER retention_mapping_access AFTER UPDATE ON public.connector_mappings
FOR EACH ROW WHEN (
  OLD.revoked_at IS DISTINCT FROM NEW.revoked_at OR OLD.audience IS DISTINCT FROM NEW.audience
  OR OLD.provider_audience IS DISTINCT FROM NEW.provider_audience
  OR (OLD.verified_until IS NOT NULL AND NEW.verified_until IS NULL)
) EXECUTE FUNCTION kordos_retention.access_changed();
CREATE TRIGGER retention_installation_access AFTER UPDATE ON public.connector_installations
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state
  OR (OLD.issue = 'credential_revoked') IS DISTINCT FROM (NEW.issue = 'credential_revoked'))
EXECUTE FUNCTION kordos_retention.access_changed();
CREATE TRIGGER retention_workspace_member_access AFTER UPDATE ON public.memberships
FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.removed_at IS DISTINCT FROM NEW.removed_at)
EXECUTE FUNCTION kordos_retention.access_changed();
CREATE TRIGGER retention_project_member_access AFTER UPDATE ON public.project_members
FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.removed_at IS DISTINCT FROM NEW.removed_at)
EXECUTE FUNCTION kordos_retention.access_changed();

CREATE FUNCTION kordos_retention.read() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'version',p.version,'audioDays',p.audio_days,'transcriptDays',p.transcript_days,
    'importedDays',p.imported_days,'logDays',p.log_days,'checkedAt',p.checked_at,
    'pending',jsonb_build_object(
      'audio',(SELECT count(*) FROM public.meeting_media m WHERE m.workspace_id=p.workspace_id AND m.deleted_at IS NULL
        AND (m.removed_at IS NOT NULL OR kordos_retention.audio_expiry(m)<=statement_timestamp()
          OR (m.available_at IS NULL AND m.created_at<=statement_timestamp()-interval '1 hour'))),
      'transcripts',(SELECT count(*) FROM public.meeting_transcripts t WHERE t.workspace_id=p.workspace_id
        AND t.purged_at IS NULL AND NOT kordos_retention.transcript_visible(t)),
      'imports',(SELECT count(*) FROM public.source_revisions s WHERE s.workspace_id=p.workspace_id
        AND s.title IS NOT NULL AND NOT kordos_retention.import_visible(s)),
      'shares',(SELECT count(*) FROM public.connector_shares s WHERE s.workspace_id=p.workspace_id
        AND s.revoked_at IS NOT NULL AND s.purged_at IS NULL),
      'logs',(SELECT count(*) FROM public.audit_events a WHERE a.workspace_id=p.workspace_id AND a.redacted_at IS NULL
        AND a.created_at<=statement_timestamp()-make_interval(days=>p.log_days))),
    'removed',jsonb_build_object(
      'audio',(SELECT count(*) FROM public.meeting_media m WHERE m.workspace_id=p.workspace_id AND m.deleted_at IS NOT NULL),
      'transcripts',(SELECT count(*) FROM public.meeting_transcripts t WHERE t.workspace_id=p.workspace_id AND t.purged_at IS NOT NULL),
      'imports',(SELECT count(*) FROM public.source_revisions s WHERE s.workspace_id=p.workspace_id AND s.purged_at IS NOT NULL),
      'shares',(SELECT count(*) FROM public.connector_shares s WHERE s.workspace_id=p.workspace_id AND s.purged_at IS NOT NULL),
      'logs',(SELECT count(*) FROM public.audit_events a WHERE a.workspace_id=p.workspace_id AND a.redacted_at IS NOT NULL)))
  FROM public.workspace_retention p WHERE p.workspace_id=kordos_identity.workspace_id()
    AND kordos_identity.current_role()='admin'
$$;

CREATE FUNCTION kordos_retention.policy_lock(p_workspace uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT hashtextextended('kordos.retention:' || p_workspace,0)
$$;

CREATE FUNCTION kordos_retention.save(p_input jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  actor uuid := kordos_identity.actor_id();
  mutation uuid := (p_input->>'mutationId')::uuid;
  digest text := encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
  prior text;
BEGIN
  IF kordos_identity.current_role() IS DISTINCT FROM 'admin' THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(kordos_retention.policy_lock(tenant));
  -- Serialize authorization with workspace member changes.
  PERFORM 1 FROM public.memberships WHERE (workspace_id,user_id)=(tenant,actor)
    AND role='admin' AND removed_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT a.details->>'fingerprint' INTO prior FROM public.audit_events a
    WHERE (a.workspace_id,a.actor_id,a.action)=(tenant,actor,'retention.policy_updated')
      AND a.details->>'mutationId'=mutation::text;
  IF FOUND THEN RETURN CASE WHEN prior=digest THEN 'saved' ELSE 'conflict' END; END IF;
  UPDATE public.workspace_retention SET version=version+1,access_epoch=access_epoch+1,
    audio_days=(p_input->>'audioDays')::int, transcript_days=(p_input->>'transcriptDays')::int,
    imported_days=(p_input->>'importedDays')::int, log_days=(p_input->>'logDays')::int,checked_at=NULL
  WHERE workspace_id=tenant AND version=(p_input->>'expectedVersion')::int;
  IF NOT FOUND THEN RETURN 'conflict'; END IF;
  INSERT INTO public.audit_events (workspace_id,actor_id,action,target_id,details)
  VALUES (tenant,actor,'retention.policy_updated',tenant,
    jsonb_build_object('mutationId',mutation,'fingerprint',digest,
      'after',(p_input-'mutationId'-'expectedVersion') || jsonb_build_object('version',(p_input->>'expectedVersion')::int+1)));
  RETURN 'saved';
END
$$;

-- Allowlist audit metadata. Preserve replay keys, IDs, and work history ordering.
CREATE FUNCTION kordos_retention.audit_facts(p_value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(p_value)='object' THEN coalesce((
    SELECT jsonb_object_agg(key,value) FROM jsonb_each(p_value)
    WHERE key IN ('mutationId','fingerprint','response','id','workId','workIds','proposalId','revision',
      'documentId','meetingId','decisionId','receiptId','mediaId','executor','version','transcriptRevision',
      'kind','status','archived','completedAt','graphVersion','outcome','audioDays','transcriptDays',
      'importedDays','logDays')
  ),'{}'::jsonb) ELSE p_value END
$$;

-- Keep the work history DTO valid after removing its free-text fields.
CREATE FUNCTION kordos_retention.work_facts(p_value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(p_value)='object' THEN kordos_retention.audit_facts(p_value)
    || jsonb_build_object('title','Retained work history','description',NULL,
      'ownerId',p_value->'ownerId','estimateDays',p_value->'estimateDays',
      'deadline',p_value->'deadline','commitment',p_value->'commitment',
      'blockerReason',NULL,'blockerOwnerId',NULL,'blockerResolution',NULL)
    ELSE p_value END
$$;

CREATE FUNCTION kordos_retention.pending_transcript_expired(m public.meetings) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT m.pending_text IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.outbox o JOIN public.workspace_retention p ON p.workspace_id=o.workspace_id
    WHERE (o.workspace_id,o.project_id,o.target_id)=(m.workspace_id,m.project_id,m.id)
      AND o.kind='meeting.queued' AND o.request->>'_command'='meeting.paste'
      AND o.created_at>statement_timestamp()-make_interval(days=>p.transcript_days)
  )
$$;

CREATE FUNCTION kordos_retention.purge() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  policy public.workspace_retention;
  n int := 0;
  changed int;
  access_changed boolean := false;
BEGIN
  SELECT p.* INTO policy FROM public.workspace_retention p
  WHERE p.checked_at IS NULL OR p.checked_at <= statement_timestamp()-interval '5 seconds'
  ORDER BY p.checked_at NULLS FIRST,p.workspace_id LIMIT 1;
  IF NOT FOUND OR NOT pg_try_advisory_xact_lock(kordos_retention.policy_lock(policy.workspace_id)) THEN RETURN 0; END IF;
  SELECT * INTO STRICT policy FROM public.workspace_retention WHERE workspace_id=policy.workspace_id;
  IF policy.checked_at>statement_timestamp()-interval '5 seconds' THEN RETURN 0; END IF;

  WITH due AS (
    SELECT t.workspace_id,t.project_id,t.meeting_id,t.revision FROM public.meeting_transcripts t
    WHERE t.workspace_id=policy.workspace_id AND t.purged_at IS NULL
      AND t.created_at<=statement_timestamp()-make_interval(days=>policy.transcript_days)
    ORDER BY t.created_at,t.meeting_id,t.revision LIMIT 25 FOR UPDATE SKIP LOCKED
  ), scrubbed AS (
    UPDATE public.meeting_transcripts t SET segments='[]'::jsonb,purged_at=clock_timestamp()
    FROM due d WHERE (t.workspace_id,t.project_id,t.meeting_id,t.revision)=(d.workspace_id,d.project_id,d.meeting_id,d.revision)
    RETURNING t.*
  ), items AS (
    UPDATE public.meeting_items i SET
      suggestion=CASE WHEN i.status='accepted' THEN i.suggestion - ARRAY['title','detail','ownerId','date']
        ELSE jsonb_build_object('anchor',i.suggestion->'anchor') END,
      reviewed_values=CASE WHEN i.status='accepted' THEN i.reviewed_values END,
      status=CASE WHEN i.status='accepted' THEN i.status ELSE 'stale' END,
      version=i.version+1
    FROM scrubbed t WHERE (i.workspace_id,i.project_id,i.meeting_id,i.transcript_revision)
      =(t.workspace_id,t.project_id,t.meeting_id,t.revision)
    RETURNING i.*
  ), redact_reviews AS (
    UPDATE public.proposal_revisions r SET command=jsonb_build_object('kind','meeting.accept'),
      before=r.before-'title'
    FROM public.proposals p JOIN items i ON (i.workspace_id,i.project_id,i.id)=(p.workspace_id,p.project_id,p.meeting_item_id)
    WHERE (r.workspace_id,r.project_id,r.proposal_id)=(p.workspace_id,p.project_id,p.id)
      AND i.status<>'accepted'
  ), deactivate_extraction AS (
    UPDATE public.meetings m SET status='empty',mode=NULL,failure=NULL,pending_text=NULL,
      lease=NULL,lease_until=NULL,version=version+1
    FROM scrubbed t WHERE (m.workspace_id,m.project_id,m.id,m.transcript_revision)
      =(t.workspace_id,t.project_id,t.meeting_id,t.revision)
      AND (m.mode='extract' OR m.status='ready')
  ), queued AS (
    INSERT INTO public.search_outbox (workspace_id,project_id,kind,source_id)
    SELECT DISTINCT workspace_id,project_id,'meeting'::public.search_kind,meeting_id FROM scrubbed
    ON CONFLICT (workspace_id,project_id,kind,source_id) DO UPDATE SET queued_at=excluded.queued_at
  )
  SELECT count(*) INTO n FROM scrubbed;
  access_changed := n>0;

  WITH due AS (
    SELECT m.id FROM public.meetings m WHERE m.workspace_id=policy.workspace_id
      AND m.pending_text IS NOT NULL AND kordos_retention.pending_transcript_expired(m)
    ORDER BY m.id LIMIT 25 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.meetings m SET status='empty',mode=NULL,failure=NULL,pending_text=NULL,
    lease=NULL,lease_until=NULL,version=version+1 FROM due WHERE m.id=due.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  n := n+changed;
  access_changed := access_changed OR changed>0;

  WITH due AS (
    SELECT workspace_id,project_id,source_id,revision FROM public.source_revisions s
    WHERE s.workspace_id=policy.workspace_id AND s.title IS NOT NULL AND s.purged_at IS NULL
      AND s.observed_at<=statement_timestamp()-make_interval(days=>policy.imported_days)
    ORDER BY s.observed_at,s.source_id,s.revision LIMIT 25 FOR UPDATE SKIP LOCKED
  ), scrubbed AS (
    UPDATE public.source_revisions s SET title=NULL,body=NULL,url=NULL,github=NULL,calendar_start=NULL,purged_at=clock_timestamp()
    FROM due d WHERE (s.workspace_id,s.project_id,s.source_id,s.revision)=(d.workspace_id,d.project_id,d.source_id,d.revision)
    RETURNING s.workspace_id,s.project_id,s.source_id,s.revision
  ), redact_reviews AS (
    UPDATE public.proposal_revisions r SET before=r.before-'title'
    FROM public.proposals p
    WHERE (r.workspace_id,r.project_id,r.proposal_id)=(p.workspace_id,p.project_id,p.id)
      AND r.before ? 'title' AND EXISTS (
        SELECT FROM scrubbed s WHERE (s.workspace_id,s.project_id,s.source_id)=(p.workspace_id,p.project_id,p.github_source_id))
  ), queued AS (
    INSERT INTO public.search_outbox (workspace_id,project_id,kind,source_id)
    SELECT DISTINCT s.workspace_id,s.project_id,'github'::public.search_kind,s.source_id FROM scrubbed s
    JOIN public.source_objects o ON (o.workspace_id,o.project_id,o.id,o.revision)=(s.workspace_id,s.project_id,s.source_id,s.revision)
    JOIN public.connector_installations i ON (i.workspace_id,i.id)=(o.workspace_id,o.installation_id)
    WHERE i.provider='github'
    ON CONFLICT (workspace_id,project_id,kind,source_id) DO UPDATE SET queued_at=excluded.queued_at
  )
  SELECT count(*) INTO changed FROM scrubbed;
  n := n+changed;
  access_changed := access_changed OR changed>0;

  WITH due AS (
    SELECT id FROM public.connector_shares s WHERE s.workspace_id=policy.workspace_id
      AND s.revoked_at IS NOT NULL AND s.purged_at IS NULL
    ORDER BY s.revoked_at,s.id LIMIT 25 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.connector_shares s SET title='',excerpt='',url=NULL,purged_at=clock_timestamp()
    FROM due WHERE s.id=due.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  n := n+changed;

  WITH due AS (
    SELECT id FROM public.audit_events a WHERE a.workspace_id=policy.workspace_id AND a.redacted_at IS NULL
      AND a.created_at<=statement_timestamp()-make_interval(days=>policy.log_days)
    ORDER BY a.created_at,a.id LIMIT 100 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.audit_events a SET redacted_at=clock_timestamp(),
    details=kordos_retention.audit_facts(a.details) || jsonb_build_object(
      'before',CASE WHEN a.action LIKE 'work.%' THEN kordos_retention.work_facts(a.details->'before')
        ELSE kordos_retention.audit_facts(a.details->'before') END,
      'after',CASE WHEN a.action LIKE 'work.%' THEN kordos_retention.work_facts(a.details->'after')
        ELSE kordos_retention.audit_facts(a.details->'after') END)
    FROM due WHERE a.id=due.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  n := n+changed;
  -- Provider delivery receipts keep their IDs and hashes for deduplication.
  WITH due AS (
    SELECT j.id FROM public.connector_jobs j WHERE j.workspace_id=policy.workspace_id AND j.payload IS NOT NULL
      AND j.created_at<=statement_timestamp()-make_interval(days=>policy.log_days)
    ORDER BY j.created_at,j.id LIMIT 25 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.connector_jobs j SET payload=NULL, lease=NULL, lease_until=NULL,
    state=CASE WHEN j.state IN ('running','queued') THEN 'failed' ELSE j.state END,
    finished_at=coalesce(j.finished_at,clock_timestamp())
    FROM due WHERE j.id=due.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  n := n+changed;

  UPDATE public.workspace_retention SET checked_at=clock_timestamp(),
    access_epoch=access_epoch+access_changed::int WHERE workspace_id=policy.workspace_id;
  RETURN n;
END
$$;

CREATE OR REPLACE FUNCTION kordos_meetings.available(media public.meeting_media) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT media.available_at IS NOT NULL AND media.removed_at IS NULL AND kordos_retention.audio_expiry(media) > statement_timestamp()
$$;

CREATE OR REPLACE FUNCTION kordos_meetings.cleanup() RETURNS TABLE(id uuid,key text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH due AS (
    SELECT media.id FROM public.meeting_media media WHERE media.deleted_at IS NULL
      AND ((media.removed_at IS NOT NULL AND (media.available_at IS NOT NULL OR media.removed_at<=clock_timestamp()-interval '1 minute'))
        OR kordos_retention.audio_expiry(media)<=clock_timestamp()
        OR (media.available_at IS NULL AND media.created_at<=clock_timestamp()-interval '1 hour'))
    ORDER BY coalesce(media.removed_at,kordos_retention.audio_expiry(media)),media.id FOR UPDATE SKIP LOCKED LIMIT 20
  )
  UPDATE public.meeting_media media SET removed_at=coalesce(media.removed_at,clock_timestamp())
  FROM due WHERE media.id=due.id RETURNING media.id,kordos_meetings.key(media)
$$;

CREATE OR REPLACE FUNCTION kordos_meetings.segment(p_workspace uuid,p_project uuid,p_meeting uuid,p_revision int,p_segment uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT segment FROM public.meeting_transcripts t CROSS JOIN LATERAL jsonb_array_elements(t.segments) segment
  WHERE (t.workspace_id,t.project_id,t.meeting_id,t.revision)=(p_workspace,p_project,p_meeting,p_revision)
    AND kordos_retention.transcript_visible(t) AND (segment->>'id')::uuid=p_segment
$$;

CREATE OR REPLACE FUNCTION kordos_meetings.item_unchanged(i public.meeting_items,m public.meetings) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT source IS NOT NULL AND source = kordos_meetings.segment(
    i.workspace_id,i.project_id,i.meeting_id,m.transcript_revision,(i.suggestion->'anchor'->>'segmentId')::uuid)
  FROM kordos_meetings.segment(i.workspace_id,i.project_id,i.meeting_id,i.transcript_revision,
    (i.suggestion->'anchor'->>'segmentId')::uuid) AS passage(source)
$$;

CREATE OR REPLACE FUNCTION kordos_meetings.citation(p_source jsonb) RETURNS jsonb
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
    AND kordos_retention.transcript_visible(t) AND t.revision=(p_source->'anchor'->>'revision')::int AND segment->>'id'=p_source->'anchor'->>'segmentId'
    AND anchor.first_char>=0 AND anchor.last_char>anchor.first_char AND anchor.last_char<=length(segment->>'text')
$$;

CREATE FUNCTION kordos_retention.has_transcript(m public.meetings) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT FROM public.meeting_transcripts t
    WHERE (t.workspace_id,t.project_id,t.meeting_id,t.revision)=(m.workspace_id,m.project_id,m.id,m.transcript_revision)
      AND kordos_retention.transcript_visible(t))
$$;

CREATE OR REPLACE FUNCTION kordos_meetings.detail(p_project uuid,p_id uuid,p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT kordos_meetings.summary(m) || jsonb_build_object('version',m.version,'agenda',m.agenda,
    'timeZone',m.time_zone,'retentionDays',m.retention_days,'attempt',m.attempt,'failure',m.failure,
    'revision',CASE WHEN kordos_retention.has_transcript(m) THEN m.transcript_revision ELSE 0 END,
    'audio',CASE WHEN available.id IS NOT NULL THEN 'available'
      WHEN EXISTS (SELECT 1 FROM public.meeting_media media WHERE media.meeting_id=m.id
        AND media.available_at IS NULL AND media.removed_at IS NULL AND kordos_retention.audio_expiry(media)>statement_timestamp()) THEN 'pending'
      WHEN EXISTS (SELECT 1 FROM public.meeting_media media WHERE media.meeting_id=m.id AND media.available_at IS NOT NULL)
        THEN 'unavailable' ELSE 'none' END,
    'expiresAt',kordos_retention.audio_expiry(available),
    'transcript',CASE WHEN t.revision IS NOT NULL THEN jsonb_build_object('revision',t.revision,
      'createdAt',t.created_at,'author',kordos_collaboration.person(t.author_id),'segments',t.segments,
      'recordingId',CASE WHEN t.media_id=available.id THEN available.id END) END,
    'history',coalesce((SELECT jsonb_agg(jsonb_build_object('revision',entry.revision,'createdAt',entry.created_at)
      ORDER BY entry.revision DESC) FROM public.meeting_transcripts entry
      WHERE (entry.workspace_id,entry.project_id,entry.meeting_id)=(m.workspace_id,m.project_id,m.id) AND kordos_retention.transcript_visible(entry)),'[]'),
    'items',coalesce((SELECT jsonb_agg(kordos_meetings.item_view(i,m) ORDER BY i.transcript_revision,i.key)
      FROM public.meeting_items i WHERE (i.workspace_id,i.project_id,i.meeting_id)=(m.workspace_id,m.project_id,m.id)
        AND (i.status='accepted' OR EXISTS (
          SELECT FROM public.meeting_transcripts src
          WHERE (src.workspace_id,src.project_id,src.meeting_id,src.revision)
            =(i.workspace_id,i.project_id,i.meeting_id,i.transcript_revision)
            AND kordos_retention.transcript_visible(src)))),'[]'),
    'canManage',project.archived_at IS NULL AND kordos_meetings.manage(m),
    'canSubmit',project.archived_at IS NULL AND kordos_planning.project_access(p_project) IN ('contributor','lead'),
    'canReject',project.archived_at IS NULL AND kordos_planning.project_access(p_project)='lead')
  FROM public.meetings m JOIN public.projects project ON (project.workspace_id,project.id)=(m.workspace_id,m.project_id)
  LEFT JOIN public.meeting_media available ON (available.workspace_id,available.project_id,available.meeting_id)
    =(m.workspace_id,m.project_id,m.id) AND kordos_meetings.available(available)
  LEFT JOIN public.meeting_transcripts t ON (t.workspace_id,t.project_id,t.meeting_id,t.revision)
    =(m.workspace_id,m.project_id,m.id,coalesce(p_revision,m.transcript_revision)) AND kordos_retention.transcript_visible(t)
  WHERE (m.workspace_id,m.project_id,m.id)=(kordos_identity.workspace_id(),p_project,p_id)
    AND kordos_planning.project_access(p_project) IS NOT NULL AND (p_revision IS NULL OR t.revision IS NOT NULL)
$$;

CREATE OR REPLACE FUNCTION kordos_meetings.write(p_project uuid,p_id uuid,p_input jsonb) RETURNS jsonb
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
        AND kordos_retention.audio_expiry(meeting_media)>clock_timestamp();
    event_kind := 'meeting.edited';
  ELSIF (action='paste' AND NOT kordos_retention.has_transcript(m))
    OR (action='retry' AND m.status='failed' AND m.attempt<3)
    OR (action='reprocess' AND kordos_retention.has_transcript(m)) THEN
    IF action='retry' AND (m.mode IS NULL OR (m.mode='transcribe' AND NOT EXISTS (
      SELECT 1 FROM public.meeting_media media WHERE media.meeting_id=m.id AND kordos_meetings.available(media)
    ))) THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
    UPDATE public.meetings SET status='queued',failure=NULL,version=version+1,generation=generation+1,
      job_actor_id=actor,attempt=CASE WHEN action='retry' THEN attempt+1 ELSE 1 END,
      mode=CASE action WHEN 'paste' THEN 'paste' WHEN 'reprocess' THEN 'extract' ELSE mode END,
      pending_text=CASE WHEN action='paste' THEN p_input->>'content' ELSE pending_text END
      WHERE id=m.id RETURNING * INTO m;
    event_kind := 'meeting.queued';
  ELSIF action='correct' AND kordos_retention.has_transcript(m) THEN
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

CREATE OR REPLACE FUNCTION kordos_meetings.upload(p_project uuid,p_id uuid,p_input jsonb,p_finish boolean) RETURNS jsonb
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
    IF media.removed_at IS NOT NULL OR kordos_retention.audio_expiry(media)<=clock_timestamp() THEN
      RETURN jsonb_build_object('result','invalid_state');
    END IF;
  ELSIF p_finish THEN RETURN jsonb_build_object('result','invalid_state');
  ELSE
    IF m.version<>(p_input->>'expectedVersion')::int THEN RETURN jsonb_build_object('result','conflict'); END IF;
    IF kordos_retention.has_transcript(m) OR m.status IN ('queued','processing') OR EXISTS (
      SELECT 1 FROM public.meeting_media other WHERE other.meeting_id=m.id AND other.removed_at IS NULL
    ) THEN RETURN jsonb_build_object('result','invalid_state'); END IF;
    INSERT INTO public.meeting_media (workspace_id,project_id,meeting_id,actor_id,mutation_id,extension,digest,size,expires_at)
    VALUES (tenant,p_project,p_id,actor,mutation,p_input->>'extension',p_input->>'digest',(p_input->>'size')::int,
      clock_timestamp()+make_interval(days=>m.retention_days)) RETURNING * INTO media;
  END IF;
  IF NOT p_finish THEN
    RETURN jsonb_build_object('result','pending','key',kordos_meetings.key(media),'id',media.id);
  END IF;
  IF m.version<>(p_input->>'expectedVersion')::int OR m.status IN ('queued','processing') OR kordos_retention.has_transcript(m) THEN
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

CREATE OR REPLACE FUNCTION kordos_meetings.claim(p_id uuid,p_generation int) RETURNS jsonb
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
  ELSIF m.mode='paste' AND kordos_retention.pending_transcript_expired(m) THEN
    UPDATE public.meetings SET pending_text=NULL WHERE id=m.id;
    PERFORM kordos_meetings.fail_job(m,'invalid_transcript');
    RETURN NULL;
  ELSIF m.mode='extract' THEN
    IF NOT kordos_retention.has_transcript(m) THEN
      PERFORM kordos_meetings.fail_job(m,'invalid_transcript');
      RETURN NULL;
    END IF;
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

CREATE OR REPLACE FUNCTION kordos_meetings.finish(p_id uuid,p_lease uuid,p_segments jsonb,p_items jsonb,p_failure text) RETURNS void
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
  IF (m.mode='paste' AND kordos_retention.pending_transcript_expired(m))
    OR (m.mode='extract' AND NOT kordos_retention.has_transcript(m)) THEN
    UPDATE public.meetings SET pending_text=NULL WHERE id=m.id;
    PERFORM kordos_meetings.fail_job(m,'invalid_transcript');
    RETURN;
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

CREATE OR REPLACE FUNCTION kordos_connectors.mirror_allowed(s public.source_objects) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(s.withdrawn_at IS NULL AND EXISTS (
    SELECT FROM public.connector_mappings m
    JOIN public.connector_installations i ON (i.workspace_id,i.id) = (m.workspace_id,m.installation_id)
    WHERE (m.workspace_id,m.installation_id,m.id,m.project_id) = (s.workspace_id,s.installation_id,s.mapping_id,s.project_id)
      AND m.revoked_at IS NULL AND m.verified_until > statement_timestamp()
      AND i.state <> 'disconnected' AND i.issue IS DISTINCT FROM 'credential_revoked'
      AND kordos_connectors.owner_authorized(i,m)
      AND ((i.provider NOT IN ('calendar','gmail') AND m.audience = 'project' AND m.provider_audience = 'project') OR i.owner_id = kordos_identity.actor_id())
  ),false)
  AND EXISTS (SELECT FROM public.source_revisions r
    WHERE (r.workspace_id,r.project_id,r.source_id,r.revision)=(s.workspace_id,s.project_id,s.id,s.revision)
      AND kordos_retention.import_visible(r))
  AND s.workspace_id = kordos_identity.workspace_id() AND kordos_planning.project_access(s.project_id) IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION kordos_connectors.source_before_github(p_project uuid, p_id uuid, p_revision int) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('id',s.id,'sourceId',s.id,'kind','mirror','revision',r.revision,
    'title',r.title,'body',r.body,'url',r.url,'observedAt',r.observed_at,'sharedBy',NULL,'canRevoke',false,
    'canShare',i.owner_id = kordos_identity.actor_id() AND r.revision = s.revision
      AND kordos_planning.project_access(p_project) IN ('lead','contributor'))
  FROM public.source_objects s
  JOIN public.source_revisions r ON (r.workspace_id,r.project_id,r.source_id,r.revision)
    = (s.workspace_id,s.project_id,s.id,coalesce(p_revision,s.revision))
  JOIN public.connector_installations i ON (i.workspace_id,i.id) = (s.workspace_id,s.installation_id)
  WHERE (s.workspace_id,s.project_id,s.id) = (kordos_identity.workspace_id(),p_project,p_id)
    AND kordos_retention.import_visible(r) AND r.body IS NOT NULL AND kordos_connectors.mirror_allowed(s)
  UNION ALL
  SELECT jsonb_build_object('id',sh.id,'sourceId',sh.source_id,'kind','share','revision',sh.revision,
    'title',sh.title,'body',sh.excerpt,'url',sh.url,'observedAt',sh.created_at,'sharedBy',u.name,'canShare',false,
    'canRevoke',sh.sharer_id = kordos_identity.actor_id() OR kordos_planning.project_access(p_project) = 'lead')
  FROM public.connector_shares sh JOIN public.users u ON u.id = sh.sharer_id
  WHERE (sh.workspace_id,sh.project_id,sh.id) = (kordos_identity.workspace_id(),p_project,p_id)
    AND (p_revision IS NULL OR sh.revision = p_revision)
    AND sh.revoked_at IS NULL AND kordos_planning.project_access(p_project) IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION kordos_connectors.apply_change(m public.connector_mappings, change jsonb, p_rebuild boolean) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  source public.source_objects;
  current_revision public.source_revisions;
  incoming_at timestamptz := (change->>'observedAt')::timestamptz;
  incoming_key text := change->>'revisionKey';
  gone boolean := change->>'kind' = 'delete';
BEGIN
  INSERT INTO public.source_objects (workspace_id,installation_id,mapping_id,project_id,external_id)
  VALUES (m.workspace_id,m.installation_id,m.id,m.project_id,change->>'externalId')
  ON CONFLICT (mapping_id,external_id) DO NOTHING;
  SELECT * INTO STRICT source FROM public.source_objects
  WHERE (mapping_id,external_id) = (m.id,change->>'externalId');
  SELECT * INTO current_revision FROM public.source_revisions
  WHERE (workspace_id,project_id,source_id,revision) = (m.workspace_id,m.project_id,source.id,source.revision);

  IF source.revision > 0 AND (CASE WHEN m.github_repository IS NOT NULL
    THEN incoming_at < current_revision.observed_at AND source.withdrawn_at IS NULL
    ELSE (incoming_at,incoming_key) < (current_revision.observed_at,current_revision.revision_key) END)
    THEN RETURN; END IF;
  IF m.github_repository IS NOT NULL THEN
    -- GitHub timestamps have one-second resolution. Workers serialize canonical reads,
    -- so the later read wins ties. A repeated delete is already reflected in the mirror.
    IF gone AND (source.withdrawn_at IS NOT NULL OR source.revision = 0) THEN
      DELETE FROM public.source_objects WHERE id=source.id AND revision=0;
      RETURN;
    END IF;
    IF NOT gone AND incoming_key = split_part(current_revision.revision_key,':',1) THEN
      UPDATE public.source_objects SET withdrawn_at=NULL WHERE id=source.id AND withdrawn_at IS NOT NULL;
      RETURN;
    END IF;
    incoming_key := incoming_key || ':' || (source.revision + 1)::text;
  END IF;
  IF EXISTS (SELECT FROM public.source_revisions r WHERE r.source_id = source.id AND r.revision_key = incoming_key) THEN
    IF EXISTS (SELECT FROM public.source_revisions r WHERE r.source_id = source.id AND r.revision_key = incoming_key
      AND r.purged_at IS NULL AND (r.observed_at,r.title,r.body,r.url) IS DISTINCT FROM (incoming_at,change->>'title',change->>'body',change->>'url')) THEN
      RAISE EXCEPTION 'Conflicting source revision' USING ERRCODE = '22023';
    END IF;
    -- A complete rescan can restore a source that was withdrawn by an earlier rescan.
    IF incoming_key = current_revision.revision_key AND p_rebuild AND NOT gone THEN
      UPDATE public.source_objects SET withdrawn_at = NULL WHERE id = source.id;
    END IF;
    RETURN;
  END IF;
  INSERT INTO public.source_revisions (workspace_id,project_id,source_id,revision,revision_key,observed_at,title,body,url,github)
  VALUES (m.workspace_id,m.project_id,source.id,source.revision + 1,incoming_key,incoming_at,
    change->>'title',change->>'body',change->>'url',CASE WHEN m.github_repository IS NOT NULL THEN change->'github' END);
  UPDATE public.source_objects SET revision = revision + 1,
    withdrawn_at = CASE WHEN gone THEN clock_timestamp() END WHERE id = source.id;
END
$$;

CREATE OR REPLACE FUNCTION kordos_connectors.refresh_calendar_meetings(mapping public.connector_mappings, owner_id uuid)
RETURNS void LANGUAGE sql SET search_path=pg_catalog AS $$
  WITH changed AS (
    UPDATE public.meetings m
    SET calendar_revision=s.revision,calendar_canceled=s.withdrawn_at IS NOT NULL,version=m.version+1,
      title=CASE WHEN s.withdrawn_at IS NULL AND m.calendar_revision<>s.revision THEN r.title ELSE m.title END,
      starts_at=CASE WHEN s.withdrawn_at IS NULL AND m.calendar_revision<>s.revision THEN r.calendar_start ELSE m.starts_at END
    FROM public.source_objects s JOIN public.source_revisions r ON r.source_id=s.id AND r.revision=s.revision
    WHERE (m.workspace_id,m.project_id,m.calendar_source_id)=(s.workspace_id,s.project_id,s.id)
      AND (s.workspace_id,s.project_id,s.mapping_id)=(mapping.workspace_id,mapping.project_id,mapping.id)
      AND (s.withdrawn_at IS NOT NULL OR kordos_retention.import_visible(r))
      AND (m.calendar_revision,m.calendar_canceled) IS DISTINCT FROM (s.revision,s.withdrawn_at IS NOT NULL)
    RETURNING m.workspace_id,m.project_id,m.id,m.calendar_canceled
  )
  INSERT INTO public.audit_events (workspace_id,project_id,actor_id,target_id,action,details)
  SELECT workspace_id,project_id,owner_id,id,
    CASE WHEN calendar_canceled THEN 'meeting.calendar_canceled' ELSE 'meeting.calendar_updated' END,
    jsonb_build_object('after',jsonb_build_object('executor',true))
  FROM changed
$$;

CREATE OR REPLACE VIEW kordos_search.sources AS
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
    = (m.workspace_id,m.project_id,m.id,m.transcript_revision) AND kordos_retention.transcript_visible(t)
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
    AND m.revoked_at IS NULL AND r.github IS NOT NULL AND kordos_retention.import_visible(r)
  UNION ALL
  SELECT sh.workspace_id,sh.project_id,'email',sh.id,sh.revision,sh.title,sh.excerpt,sh.sharer_id,u.name,
    (sh.created_at AT TIME ZONE 'UTC')::date,NULL,ARRAY[sh.id::text],'project',NULL,NULL
  FROM public.connector_shares sh JOIN public.users u ON u.id = sh.sharer_id
  JOIN public.source_objects s ON (s.workspace_id,s.project_id,s.id) = (sh.workspace_id,sh.project_id,sh.source_id)
  JOIN public.connector_installations i ON (i.workspace_id,i.id) = (s.workspace_id,s.installation_id)
  WHERE sh.revoked_at IS NULL AND i.provider = 'gmail';

CREATE FUNCTION kordos_retention.search_visible(c public.search_chunks) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN c.kind='meeting' AND c.citation IS NOT NULL THEN EXISTS (
      SELECT FROM public.meeting_transcripts t
      WHERE (t.workspace_id,t.project_id,t.meeting_id,t.revision) =
        (c.workspace_id,c.project_id,c.source_id,(c.citation->'anchor'->>'revision')::int)
        AND kordos_retention.transcript_visible(t))
    WHEN c.kind='github' THEN EXISTS (
      SELECT FROM public.source_revisions r
      WHERE (r.workspace_id,r.project_id,r.source_id,r.revision)=(c.workspace_id,c.project_id,c.source_id,c.revision)
        AND kordos_retention.import_visible(r))
    ELSE true END
$$;

CREATE OR REPLACE FUNCTION kordos_search.query(p_input jsonb,p_exact text,p_model text,p_vector public.vector)
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
      AND kordos_search.allowed(c.project_id,c.kind,c.source_id) AND kordos_retention.search_visible(c)
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

CREATE OR REPLACE FUNCTION kordos_search.can_embed(c public.search_chunks) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT c.audience = 'project' AND kordos_retention.search_visible(c)
    AND (c.kind <> 'email' OR EXISTS (SELECT FROM public.connector_shares s
      WHERE (s.workspace_id,s.project_id,s.id)=(c.workspace_id,c.project_id,c.source_id) AND s.revoked_at IS NULL))
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

-- Old provider revisions remain tombstones so reconciliation cannot restore their text.
CREATE FUNCTION kordos_retention.redact_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.title IS NOT NULL AND NOT kordos_retention.import_visible(NEW) THEN
      NEW.title := NULL;
      NEW.body := NULL;
      NEW.url := NULL;
      NEW.github := NULL;
      NEW.calendar_start := NULL;
      NEW.purged_at := clock_timestamp();
    END IF;
  ELSIF OLD.title IS NOT NULL AND NEW.title IS NULL THEN
    NEW.purged_at := coalesce(NEW.purged_at,clock_timestamp());
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER retention_import_content BEFORE INSERT OR UPDATE OF title ON public.source_revisions
FOR EACH ROW EXECUTE FUNCTION kordos_retention.redact_import();

CREATE TRIGGER retention_mirror_access AFTER UPDATE OF withdrawn_at ON public.source_objects
FOR EACH ROW WHEN (OLD.withdrawn_at IS DISTINCT FROM NEW.withdrawn_at)
EXECUTE FUNCTION kordos_retention.access_changed();
CREATE TRIGGER retention_project_access AFTER UPDATE OF visibility,archived_at ON public.projects
FOR EACH ROW WHEN (OLD.visibility IS DISTINCT FROM NEW.visibility OR OLD.archived_at IS DISTINCT FROM NEW.archived_at)
EXECUTE FUNCTION kordos_retention.access_changed();
CREATE TRIGGER retention_audio_access AFTER UPDATE OF removed_at ON public.meeting_media
FOR EACH ROW WHEN (OLD.removed_at IS DISTINCT FROM NEW.removed_at)
EXECUTE FUNCTION kordos_retention.access_changed();

CREATE OR REPLACE FUNCTION kordos_reviews.summary_before_health(
  p public.proposals, project public.projects, w public.work_items, r public.proposal_revisions
) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',p.id,'projectId',p.project_id,'projectName',project.name,
    'workId',w.id,'briefId',p.brief_id,'meetingId',r.before->>'meetingId','meetingItemId',p.meeting_item_id,
    'githubSourceId',s.id,
    'title',CASE WHEN p.github_source_id IS NOT NULL THEN coalesce(mirror.title,'GitHub comment')
      WHEN p.meeting_item_id IS NOT NULL AND NOT EXISTS (
        SELECT FROM public.meeting_items i JOIN public.meeting_transcripts t
          ON (t.workspace_id,t.project_id,t.meeting_id,t.revision)=(i.workspace_id,i.project_id,i.meeting_id,i.transcript_revision)
        WHERE (i.workspace_id,i.project_id,i.id)=(p.workspace_id,p.project_id,p.meeting_item_id)
          AND kordos_retention.transcript_visible(t)
      ) THEN 'Meeting follow-up'
      ELSE coalesce(w.title,r.before->>'title') END,
    'kind',coalesce(w.kind::text,CASE WHEN p.meeting_item_id IS NOT NULL THEN 'meeting'
      WHEN p.github_source_id IS NOT NULL THEN 'github' ELSE 'plan' END),
    'revision',r.revision,'status',kordos_reviews.effective_status(p,r),
    'requester',kordos_collaboration.person(p.requester_id),
    'requestedAt',CASE WHEN p.status='draft' THEN r.created_at ELSE coalesce(p.submitted_at,r.created_at) END)
  FROM (SELECT 1) base
  LEFT JOIN public.source_objects s ON s.id=p.github_source_id AND kordos_connectors.mirror_allowed(s)
  LEFT JOIN public.source_revisions mirror
    ON (mirror.workspace_id,mirror.project_id,mirror.source_id,mirror.revision)=(s.workspace_id,s.project_id,s.id,s.revision)
$$;

CREATE OR REPLACE FUNCTION kordos_inbox.review_ready(
  p public.proposals, r public.proposal_revisions, w public.work_items
) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT r.revision = p.revision AND kordos_planning.project_access(p.project_id) = 'lead'
    AND kordos_reviews.effective_status(p, r) = 'pending'
    AND (p.github_source_id IS NULL OR EXISTS (
      SELECT FROM public.source_objects s
      WHERE (s.workspace_id,s.project_id,s.id)=(p.workspace_id,p.project_id,p.github_source_id)
        AND kordos_github.destination_allowed(s)))
    AND (p.work_id IS NULL OR (w.archived_at IS NULL AND w.version = r.target_version))
    AND jsonb_array_length(kordos_reviews.citations(r.evidence)) = jsonb_array_length(r.evidence)
$$;

CREATE OR REPLACE FUNCTION kordos_inbox.target(e public.inbox_entries)
RETURNS TABLE(title text, deadline date, active boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN e.reason = 'mention' THEN 'You were mentioned in a comment'
    WHEN e.reason = 'review' THEN coalesce(kordos_reviews.summary(p,project,w,r)->>'title', 'Proposal')
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

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA kordos_retention FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_retention.read(),kordos_retention.save(jsonb),
  kordos_retention.access_epoch() TO kordos_app;
GRANT EXECUTE ON FUNCTION kordos_retention.purge() TO kordos_brief_worker;
