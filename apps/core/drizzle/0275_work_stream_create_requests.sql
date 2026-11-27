CREATE TABLE "work_stream_create_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"requester_key" varchar(100) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"claim_token" uuid NOT NULL,
	"lease_expires_at" timestamp NOT NULL,
	"work_stream_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_stream_create_requests" ADD CONSTRAINT "work_stream_create_requests_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_create_requests" ADD CONSTRAINT "work_stream_create_requests_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_stream_create_requests_key" ON "work_stream_create_requests" USING btree ("squad_id","requester_key","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_work_stream_create_requests_created_at" ON "work_stream_create_requests" USING btree ("created_at");