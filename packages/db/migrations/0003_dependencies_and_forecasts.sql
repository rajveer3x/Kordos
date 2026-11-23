CREATE TABLE "dependency_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"predecessor_id" uuid NOT NULL,
	"successor_id" uuid NOT NULL,
	CONSTRAINT "dependency_edges_pair" UNIQUE("workspace_id","project_id","predecessor_id","successor_id"),
	CONSTRAINT "dependency_edges_distinct_items" CHECK ("dependency_edges"."predecessor_id" <> "dependency_edges"."successor_id")
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"comparison" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenarios_actor_mutation" UNIQUE("workspace_id","actor_id","mutation_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "graph_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "dependency_edges" ADD CONSTRAINT "dependency_edges_predecessor_fk" FOREIGN KEY ("workspace_id","project_id","predecessor_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_edges" ADD CONSTRAINT "dependency_edges_successor_fk" FOREIGN KEY ("workspace_id","project_id","successor_id") REFERENCES "public"."work_items"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dependency_edges_incoming_idx" ON "dependency_edges" USING btree ("workspace_id","project_id","successor_id");
ALTER TABLE public.dependency_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY dependency_edges_read ON public.dependency_edges FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND kordos_planning.project_access(project_id) IS NOT NULL
);
CREATE POLICY scenarios_read ON public.scenarios FOR SELECT TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND actor_id = kordos_identity.actor_id()
  AND kordos_planning.project_access(project_id) IS NOT NULL
);
CREATE POLICY scenarios_create ON public.scenarios FOR INSERT TO kordos_app WITH CHECK (
  workspace_id = kordos_identity.workspace_id() AND actor_id = kordos_identity.actor_id()
  AND kordos_planning.project_access(project_id) IN ('contributor', 'lead')
);
CREATE POLICY scenarios_discard ON public.scenarios FOR DELETE TO kordos_app USING (
  workspace_id = kordos_identity.workspace_id() AND actor_id = kordos_identity.actor_id()
  AND kordos_planning.project_access(project_id) IS NOT NULL
);
GRANT SELECT ON public.dependency_edges TO kordos_app;
GRANT SELECT, INSERT, DELETE ON public.scenarios TO kordos_app;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.lock_schedule(p_project uuid, p_mutation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF coalesce(kordos_planning.project_access(p_project) IN ('contributor', 'lead'), false) THEN
    PERFORM kordos_planning.lock_workspace(p_mutation);
    PERFORM 1 FROM public.projects
    WHERE workspace_id = kordos_identity.workspace_id() AND id = p_project FOR UPDATE;
    RETURN coalesce(kordos_planning.project_access(p_project) IN ('contributor', 'lead'), false);
  END IF;
  RETURN false;
END
$$;
--> statement-breakpoint
CREATE FUNCTION kordos_planning.save_dependency(p_project uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  tenant uuid := kordos_identity.workspace_id();
  predecessor uuid := (p_input->>'predecessorId')::uuid;
  successor uuid := (p_input->>'successorId')::uuid;
  graph public.projects;
  edge_id uuid;
  adding boolean := p_input->>'action' = 'add';
  request jsonb := p_input || jsonb_build_object('_command', 'dependency.change');
  repeated jsonb;
  edge jsonb := jsonb_build_object('predecessorId', predecessor, 'successorId', successor);
BEGIN
  IF NOT kordos_planning.lock_schedule(p_project, (p_input->>'mutationId')::uuid) THEN
    RETURN jsonb_build_object('result', 'unavailable');
  END IF;
  repeated := kordos_planning.replay(request, p_project, NULL);
  IF repeated IS NOT NULL THEN RETURN repeated; END IF;
  SELECT * INTO graph FROM public.projects WHERE workspace_id = tenant AND id = p_project;
  IF graph.archived_at IS NOT NULL OR adding IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_state');
  END IF;

  IF adding THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.work_items WHERE workspace_id = tenant AND project_id = p_project
        AND id = predecessor AND archived_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM public.work_items WHERE workspace_id = tenant AND project_id = p_project
        AND id = successor AND archived_at IS NULL
    ) THEN RETURN jsonb_build_object('result', 'unavailable'); END IF;

    -- Include dormant edges. Restoring archived work must also leave a DAG.
    IF EXISTS (
      WITH RECURSIVE reachable(id) AS (
        SELECT successor
        UNION
        SELECT e.successor_id FROM reachable r JOIN public.dependency_edges e
          ON e.workspace_id = tenant AND e.project_id = p_project AND e.predecessor_id = r.id
      )
      SELECT 1 FROM reachable WHERE id = predecessor
    ) THEN RETURN jsonb_build_object('result', 'cycle'); END IF;
  END IF;

  IF graph.graph_version IS DISTINCT FROM (p_input->>'expectedVersion')::integer THEN
    RETURN jsonb_build_object('result', 'conflict', 'graphVersion', graph.graph_version);
  END IF;
  IF adding THEN
    INSERT INTO public.dependency_edges (workspace_id, project_id, predecessor_id, successor_id)
    VALUES (tenant, p_project, predecessor, successor) ON CONFLICT ON CONSTRAINT dependency_edges_pair DO NOTHING
    RETURNING id INTO edge_id;
  ELSE
    DELETE FROM public.dependency_edges WHERE workspace_id = tenant AND project_id = p_project
      AND predecessor_id = predecessor AND successor_id = successor RETURNING id INTO edge_id;
  END IF;
  IF edge_id IS NULL THEN RETURN jsonb_build_object('result', 'invalid_state'); END IF;

  UPDATE public.projects SET graph_version = graph_version + 1 WHERE workspace_id = tenant AND id = p_project;
  PERFORM kordos_planning.emit(p_project, edge_id, CASE WHEN adding THEN 'dependency.added' ELSE 'dependency.removed' END,
    request, CASE WHEN NOT adding THEN edge END, CASE WHEN adding THEN edge END);
  RETURN jsonb_build_object('result', 'saved', 'id', edge_id);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kordos_planning.lock_schedule(uuid, uuid), kordos_planning.save_dependency(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kordos_planning.lock_schedule(uuid, uuid), kordos_planning.save_dependency(uuid, jsonb) TO kordos_app;
