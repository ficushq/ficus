ALTER TABLE "agent_questions" ADD COLUMN "flow_work_stream_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "flow_attempt_id" integer;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_delivery_forward" jsonb;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_flow_work_stream_id_work_streams_id_fk" FOREIGN KEY ("flow_work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE set null ON UPDATE no action;