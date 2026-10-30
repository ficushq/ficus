CREATE TABLE "retained_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_id" uuid NOT NULL,
	"blob_owner" varchar(255) NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"squad_id" uuid,
	"delete_requested_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_stream_asset_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_stream_id" uuid NOT NULL,
	"attempt_id" integer,
	"retained_asset_id" uuid,
	"source_kind" varchar(32) NOT NULL,
	"source_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"byte_size" integer NOT NULL,
	"created_by_type" varchar(32) NOT NULL,
	"created_by_id" varchar(200) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"removed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "work_stream_asset_attachments" ADD CONSTRAINT "work_stream_asset_attachments_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_stream_asset_attachments" ADD CONSTRAINT "work_stream_asset_attachments_retained_asset_id_retained_assets_id_fk" FOREIGN KEY ("retained_asset_id") REFERENCES "public"."retained_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_retained_assets_source" ON "retained_assets" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX "idx_work_stream_asset_attachments_stream" ON "work_stream_asset_attachments" USING btree ("work_stream_id");--> statement-breakpoint
CREATE INDEX "idx_work_stream_asset_attachments_asset" ON "work_stream_asset_attachments" USING btree ("retained_asset_id");