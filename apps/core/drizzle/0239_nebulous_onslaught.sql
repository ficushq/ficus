ALTER TABLE "executions" ADD COLUMN "startup_capacity_wait_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vm_box_provision_attempts" ADD COLUMN "capacity_failure" jsonb;