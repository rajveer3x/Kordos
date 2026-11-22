CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "foundation_job_effects" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"effect" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foundation_job_effect_value" CHECK ("foundation_job_effects"."effect" = 'synthetic-job-processed')
);
--> statement-breakpoint
CREATE TABLE "foundation_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "foundation_job_effects" ADD CONSTRAINT "foundation_job_effects_job_id_foundation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."foundation_jobs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT, INSERT ON "foundation_jobs", "foundation_job_effects" TO kordos_app;
