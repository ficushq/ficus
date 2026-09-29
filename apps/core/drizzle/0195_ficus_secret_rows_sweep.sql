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
--> statement-breakpoint
-- Exposure allowlists name secret keys, so they follow the rows above. An exposure whose TAU_ row is gone
-- is renamed to the FICUS_ name; when the scope already exposes that FICUS_ name, the TAU_ entry is a
-- duplicate and is dropped (the unique constraints hold). An exposure whose TAU_ row survived (a differing
-- pair) still points at a real row and is left alone.
DELETE FROM "squad_secret_exposures" t WHERE t."secret_key" LIKE 'TAU\_%' ESCAPE '\'
  AND NOT EXISTS (SELECT 1 FROM "secrets" s WHERE s."key" = t."secret_key")
  AND EXISTS (SELECT 1 FROM "squad_secret_exposures" f
    WHERE f."squad_id" = t."squad_id" AND f."secret_key" = 'FICUS_' || substr(t."secret_key", 5));
--> statement-breakpoint
UPDATE "squad_secret_exposures" t SET "secret_key" = 'FICUS_' || substr(t."secret_key", 5), "updated_at" = now()
  WHERE t."secret_key" LIKE 'TAU\_%' ESCAPE '\'
  AND NOT EXISTS (SELECT 1 FROM "secrets" s WHERE s."key" = t."secret_key")
  AND NOT EXISTS (SELECT 1 FROM "squad_secret_exposures" f
    WHERE f."squad_id" = t."squad_id" AND f."secret_key" = 'FICUS_' || substr(t."secret_key", 5));
--> statement-breakpoint
DELETE FROM "global_secret_exposures" t WHERE t."secret_key" LIKE 'TAU\_%' ESCAPE '\'
  AND NOT EXISTS (SELECT 1 FROM "secrets" s WHERE s."key" = t."secret_key")
  AND EXISTS (SELECT 1 FROM "global_secret_exposures" f WHERE f."secret_key" = 'FICUS_' || substr(t."secret_key", 5));
--> statement-breakpoint
UPDATE "global_secret_exposures" t SET "secret_key" = 'FICUS_' || substr(t."secret_key", 5), "updated_at" = now()
  WHERE t."secret_key" LIKE 'TAU\_%' ESCAPE '\'
  AND NOT EXISTS (SELECT 1 FROM "secrets" s WHERE s."key" = t."secret_key")
  AND NOT EXISTS (SELECT 1 FROM "global_secret_exposures" f WHERE f."secret_key" = 'FICUS_' || substr(t."secret_key", 5));
