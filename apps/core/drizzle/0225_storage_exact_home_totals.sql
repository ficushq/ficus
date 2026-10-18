ALTER TABLE "storage_scan_items" DROP CONSTRAINT "storage_scan_items_path";--> statement-breakpoint
ALTER TABLE "storage_home_results" ADD COLUMN "total_exact" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_scan_items" ADD COLUMN "kind" varchar(8) DEFAULT 'tree' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_scan_items" ADD CONSTRAINT "storage_scan_items_path" UNIQUE("pass_id","kind","path");--> statement-breakpoint
-- Existing home results are marked approximate (total_exact defaults to false) until the next pass
-- measures them again, since which of them were measured split is no longer known.
-- Home growth samples written before exact totals may hold inflated sums of separately measured
-- folders; drop them so growth only ever compares exact totals (host df samples are kept).
DELETE FROM "storage_usage_samples" WHERE "subject" <> 'host';
