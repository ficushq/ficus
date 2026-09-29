-- Ficus rename, Task 36c: stored user and agent prose keeps no pre-rename names. Pre-rename entity references
-- (work streams and agents, exact reader grammar, outside code and URLs) in rendered prose become `ficus:ws:` /
-- `ficus:agent:`, and the provenance marker in stored memory_search results becomes `<!--ficus:memory-provenance`.
-- Verbatim tool I/O (arguments, file contents, command output) is never rewritten.
-- The rewrite is TypeScript (src/db/stored-text-backfill.ts, which lists the tables and columns): the
-- migrator runs it just before the statement below, inside this migration's transaction. It pages by key,
-- writes only changed values, touches no timestamp, and finds nothing on a second run.
-- Rollback: the previous release reads both spellings, so it renders the rewritten rows unchanged.
-- Agent session files and squad memory files are rewritten once by the worker at startup (home-text-rewrite.ts).
SELECT 'stored text uses Ficus names' AS "0196_ficus_stored_text";
