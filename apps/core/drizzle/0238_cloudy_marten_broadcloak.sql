CREATE TABLE "machine_capacity_claims" (
	"owner_key" text NOT NULL,
	"kind" text NOT NULL,
	"machine_id" uuid NOT NULL,
	"sandbox_id" text NOT NULL,
	"stream_id" uuid,
	"work_stream_id" uuid,
	"execution_id" uuid,
	"provision_attempt_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_capacity_claims_owner_key_machine_id_sandbox_id_pk" PRIMARY KEY("owner_key","machine_id","sandbox_id"),
	CONSTRAINT "machine_capacity_claims_owner_check" CHECK (
      ("machine_capacity_claims"."kind" = 'stream' AND "machine_capacity_claims"."stream_id" IS NOT NULL AND "machine_capacity_claims"."execution_id" IS NULL AND "machine_capacity_claims"."provision_attempt_id" IS NULL)
      OR ("machine_capacity_claims"."kind" = 'execution' AND "machine_capacity_claims"."stream_id" IS NULL AND "machine_capacity_claims"."execution_id" IS NOT NULL AND "machine_capacity_claims"."provision_attempt_id" IS NULL)
      OR ("machine_capacity_claims"."kind" = 'provision' AND "machine_capacity_claims"."stream_id" IS NULL AND "machine_capacity_claims"."provision_attempt_id" IS NOT NULL AND "machine_capacity_claims"."execution_id" IS NULL)
    )
);
--> statement-breakpoint
ALTER TABLE "machine_capacity_claims" ADD CONSTRAINT "machine_capacity_claims_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_capacity_claims" ADD CONSTRAINT "machine_capacity_claims_stream_id_work_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_capacity_claims" ADD CONSTRAINT "machine_capacity_claims_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_capacity_claims" ADD CONSTRAINT "machine_capacity_claims_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_capacity_claims" ADD CONSTRAINT "machine_capacity_claims_provision_attempt_id_vm_box_provision_attempts_id_fk" FOREIGN KEY ("provision_attempt_id") REFERENCES "public"."vm_box_provision_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_capacity_claims_machine_idx" ON "machine_capacity_claims" USING btree ("machine_id");