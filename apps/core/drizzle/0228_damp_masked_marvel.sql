CREATE TABLE "setting_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(255) NOT NULL,
	"previous_value" text,
	"new_value" text,
	"actor" varchar(100) NOT NULL,
	"source" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_setting_audit_log_key_created" ON "setting_audit_log" USING btree ("key","created_at");