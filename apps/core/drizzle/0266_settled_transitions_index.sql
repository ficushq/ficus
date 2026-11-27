CREATE INDEX CONCURRENTLY "idx_work_stream_flow_transitions_created" ON "work_stream_flow_transitions" USING btree ("created_at");
