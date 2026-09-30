CREATE TABLE "work_stream_observers" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"work_stream_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "work_stream_observers_work_stream_id_agent_id_pk" PRIMARY KEY("work_stream_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "work_stream_observers" ADD CONSTRAINT "work_stream_observers_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_observers" ADD CONSTRAINT "work_stream_observers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;