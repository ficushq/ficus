-- Ficus rename, one release: copy the four retained TAU_ secret-store rows to FICUS_.
-- A copy, not a rename: migrations are forward-only, so a rolled-back Core must still find its TAU_ rows
-- (they are removed by the bridge-removal release). Ciphertext and IV are copied verbatim: the store's
-- AES-256-GCM binds no key name (no AAD), so the copy decrypts under its new name, and no plaintext is
-- ever written. updated_at/updated_by are kept, so an env-seeded row keeps following its env value.
-- An existing FICUS_ row always wins; the migrator names any differing pair (never its value) first.
INSERT INTO "secrets" ("key", "encrypted_value", "iv", "updated_at", "updated_by")
SELECT 'FICUS_' || substr("key", 5), "encrypted_value", "iv", "updated_at", "updated_by"
FROM "secrets"
WHERE "key" IN ('TAU_PASSWORD', 'TAU_PUSH_RELAY_TOKEN', 'TAU_PLATFORM_INSTANCE_TOKEN', 'TAU_PLATFORM_USAGE_TOKEN')
ON CONFLICT ("key") DO NOTHING;
