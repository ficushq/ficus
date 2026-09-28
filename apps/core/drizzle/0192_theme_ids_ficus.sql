-- Ficus rename: move stored built-in theme ids forward. Forest became the default Ficus theme and the purple theme
-- became Iris under a new id, so both old ids land on the new default (Iris is opt-in). Iris and custom ids are left
-- alone. A rolled-back Core reads 'ficus' as unknown and falls back to its own default.
-- Paths: the account selection's themeId (normalizeStoredThemeSelection's themeId), and a custom-theme document's
-- base and format marker, both in the account's customTheme snapshot and in each saved preset's document.
UPDATE "user_preferences" SET "theme" = jsonb_set("theme", '{themeId}', '"ficus"')
WHERE "theme"->>'themeId' IN ('tau', 'forest');
--> statement-breakpoint
UPDATE "user_preferences" SET "theme" = jsonb_set("theme", '{customTheme,base}', '"ficus"')
WHERE jsonb_typeof("theme"->'customTheme') = 'object' AND "theme"->'customTheme'->>'base' IN ('tau', 'forest');
--> statement-breakpoint
UPDATE "user_preferences" SET "theme" = jsonb_set("theme", '{customTheme,format}', '"ficus-custom-theme"')
WHERE jsonb_typeof("theme"->'customTheme') = 'object' AND "theme"->'customTheme'->>'format' = 'tau-custom-theme';
--> statement-breakpoint
UPDATE "theme_presets" SET "document" = jsonb_set("document", '{base}', '"ficus"')
WHERE "document"->>'base' IN ('tau', 'forest');
--> statement-breakpoint
UPDATE "theme_presets" SET "document" = jsonb_set("document", '{format}', '"ficus-custom-theme"')
WHERE "document"->>'format' = 'tau-custom-theme';
