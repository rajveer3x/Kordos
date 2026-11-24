-- Run through psql on a restricted operator connection to a read-only clone.
-- Bind workspace and ref with psql --set. Output contains IDs and states only.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';

WITH input AS (
  SELECT :'workspace'::uuid AS workspace_id, :'ref'::uuid AS id
), related_proposals AS (
  SELECT p.workspace_id, p.project_id, p.id, p.status,
         p.work_id, b.id AS brief_id, b.document_id, b.source_revision,
         m.meeting_id, m.id AS meeting_item_id, m.transcript_revision,
         p.github_source_id, f.comment_id, f.id AS risk_finding_id
  FROM input i
  JOIN public.proposals p ON p.workspace_id = i.workspace_id
  LEFT JOIN public.brief_jobs b ON b.id = p.brief_id AND b.workspace_id = p.workspace_id
  LEFT JOIN public.meeting_items m ON m.id = p.meeting_item_id AND m.workspace_id = p.workspace_id
  LEFT JOIN public.risk_replans rr ON rr.proposal_id = p.id AND rr.workspace_id = p.workspace_id
  LEFT JOIN public.risk_findings f ON f.id = rr.finding_id AND f.workspace_id = p.workspace_id
  WHERE i.id IN (p.id, p.work_id, b.id, b.document_id, m.meeting_id, m.id, p.github_source_id, f.id, f.comment_id)
    OR EXISTS (
      SELECT 1 FROM public.executions e WHERE (e.workspace_id, e.project_id, e.proposal_id) = (p.workspace_id, p.project_id, p.id)
        AND i.id IN (e.id, e.approval_audit_id, e.outcome_audit_id, e.effect_event_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.proposal_revisions pr
      CROSS JOIN LATERAL jsonb_array_elements(pr.evidence) ev
      WHERE (pr.workspace_id, pr.project_id, pr.proposal_id) = (p.workspace_id, p.project_id, p.id)
        AND ev->'source'->>'id' = i.id::text
    )
)
SELECT p.project_id, p.id AS proposal_id, p.status AS proposal_status,
       e.revision AS executed_revision, e.id AS execution_id, e.status AS execution_status,
       p.work_id, p.brief_id, p.document_id, p.source_revision, p.meeting_id,
       p.meeting_item_id, p.transcript_revision, p.github_source_id, p.comment_id, p.risk_finding_id,
       e.approval_audit_id, e.effect_event_id, e.outcome_audit_id,
       e.approved_at, e.finished_at, e.github_attempts
FROM related_proposals p LEFT JOIN public.executions e
  ON (e.workspace_id, e.project_id, e.proposal_id) = (p.workspace_id, p.project_id, p.id)
ORDER BY p.id, e.revision;

SELECT id AS receipt_id, installation_id, mapping_id, kind, state, attempts, created_at, finished_at
FROM public.connector_jobs
WHERE workspace_id = :'workspace'::uuid AND id = :'ref'::uuid;

COMMIT;
