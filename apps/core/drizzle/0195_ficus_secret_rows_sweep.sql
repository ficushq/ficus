-- Ficus rename, Wave 3: the secret store keeps no TAU_ rows. Core reads FICUS_ names only from this release on.
-- The copied rows: FICUS_ twins exist since 0190.
DELETE FROM "secrets" t WHERE t."key" IN ('TAU_PASSWORD','TAU_PUSH_RELAY_TOKEN','TAU_PLATFORM_INSTANCE_TOKEN','TAU_PLATFORM_USAGE_TOKEN')
  AND EXISTS (SELECT 1 FROM "secrets" f WHERE f."key" = 'FICUS_' || substr(t."key", 5));
--> statement-breakpoint
-- Custom TAU_ rows nobody re-saved (R9): rename in place; the ciphertext is not bound to the key name (Task 9 report).
UPDATE "secrets" t SET "key" = 'FICUS_' || substr(t."key", 5)
  WHERE t."key" LIKE 'TAU\_%' ESCAPE '\'
  AND NOT EXISTS (SELECT 1 FROM "secrets" f WHERE f."key" = 'FICUS_' || substr(t."key", 5));
-- Pairs where both exist and differ are left alone; GATE C item 9 had owners resolve them.
