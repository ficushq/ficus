CREATE TABLE "storage_home_results" (
	"machine_id" uuid NOT NULL,
	"home" text NOT NULL,
	"generation" integer NOT NULL,
	"bytes" bigint,
	"status" varchar(16) NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"folder" jsonb NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "storage_home_results_machine_id_home_pk" PRIMARY KEY("machine_id","home")
);
--> statement-breakpoint
CREATE TABLE "storage_scan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pass_id" uuid NOT NULL,
	"home" text NOT NULL,
	"path" text NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"bytes" bigint,
	"details" jsonb,
	"error" varchar(32),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_scan_items_path" UNIQUE("pass_id","path")
);
--> statement-breakpoint
CREATE TABLE "storage_scan_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"status" varchar(16) DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"homes" integer DEFAULT 0 NOT NULL,
	"used_bytes" bigint,
	"total_bytes" bigint,
	"disk_measured_at" timestamp with time zone,
	"last_error" varchar(32),
	"last_error_at" timestamp with time zone,
	CONSTRAINT "storage_scan_passes_generation" UNIQUE("machine_id","generation")
);
--> statement-breakpoint
CREATE TABLE "storage_usage_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"machine_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"bytes" bigint NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_scan_items" ADD CONSTRAINT "storage_scan_items_pass_id_storage_scan_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."storage_scan_passes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_scan_items_state" ON "storage_scan_items" USING btree ("pass_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_storage_scan_passes_running" ON "storage_scan_passes" USING btree ("machine_id") WHERE "storage_scan_passes"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_storage_usage_samples_subject" ON "storage_usage_samples" USING btree ("machine_id","subject","measured_at");