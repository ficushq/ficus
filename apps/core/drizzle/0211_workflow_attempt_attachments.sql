CREATE TABLE "workflow_attempt_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_stream_id" uuid NOT NULL,
	"attempt_id" integer NOT NULL,
	"filename" varchar(255) NOT NULL,
	"path" text NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_path" text NOT NULL,
	"uploaded_by_agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_attempt_attachments" ADD CONSTRAINT "workflow_attempt_attachments_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_attempt_attachments_attempt" ON "workflow_attempt_attachments" USING btree ("work_stream_id","attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_attempt_attachments_path" ON "workflow_attempt_attachments" USING btree ("work_stream_id","attempt_id","path");