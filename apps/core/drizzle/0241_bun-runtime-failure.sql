-- Nullable metadata only; do not wait indefinitely for a busy live table.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "machine_boxes" ADD COLUMN "bun_runtime_failure_spec_hash" text;
--> statement-breakpoint
ALTER TABLE "machine_boxes" ADD COLUMN "bun_runtime_adopting_spec_hash" text;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
