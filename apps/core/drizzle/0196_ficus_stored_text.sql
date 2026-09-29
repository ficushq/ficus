-- Ficus rename, Task 36c: stored user and agent text keeps no pre-rename names. Pre-rename entity references
-- (work streams and agents, exact reader grammar, outside code and URLs) become `ficus:ws:` / `ficus:agent:`,
-- and the memory_search provenance marker in stored tool results becomes `<!--ficus:memory-provenance`.
-- The rewrite is TypeScript (src/db/stored-text-backfill.ts, which lists the tables and columns): the
-- migrator runs it just before the statement below, inside this migration's transaction. It pages by key,
-- writes only changed values, touches no timestamp, and finds nothing on a second run.
-- Rollback: the previous release reads both spellings, so it renders the rewritten rows unchanged.
-- Agent session files and squad memory files are rewritten once by the worker at startup (home-text-rewrite.ts).
SELECT 'stored text uses Ficus names' AS "0196_ficus_stored_text";
