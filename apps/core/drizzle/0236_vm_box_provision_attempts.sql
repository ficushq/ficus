CREATE TABLE "vm_box_provision_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vm_box_provision_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"sandbox_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"failure_class" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "vm_box_provision_attempts_sandbox_idx" ON "vm_box_provision_attempts" USING btree ("sandbox_id","id");--> statement-breakpoint
CREATE INDEX "vm_box_provision_attempts_completed_idx" ON "vm_box_provision_attempts" USING btree ("completed_at");