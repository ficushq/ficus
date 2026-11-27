-- Validates 0265's NOT VALID constraints. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so the
-- scan of existing rows does not block reads or writes. 0266 runs on its own, which keeps this
-- in a separate transaction from 0265's exclusive locks.
ALTER TABLE "work_stream_waits" VALIDATE CONSTRAINT "work_stream_waits_resolved_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "work_stream_waits" VALIDATE CONSTRAINT "work_stream_waits_resolved_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "squad_activity" VALIDATE CONSTRAINT "squad_activity_lane_check";--> statement-breakpoint
ALTER TABLE "squad_activity" VALIDATE CONSTRAINT "squad_activity_lane_kind_check";--> statement-breakpoint
ALTER TABLE "squad_activity" VALIDATE CONSTRAINT "squad_activity_lane_scope_check";
