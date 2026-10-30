DROP INDEX "idx_workflow_attempt_attachments_path";--> statement-breakpoint
ALTER TABLE "workflow_attempt_attachments" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_attempt_attachments_path" ON "workflow_attempt_attachments" USING btree ("work_stream_id","attempt_id","revision","path");