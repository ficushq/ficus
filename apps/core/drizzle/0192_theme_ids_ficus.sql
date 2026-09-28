-- Ficus rename: move stored built-in theme ids forward. Forest became the default Ficus theme and the purple theme
-- became Iris under a new id. A plain selection of either old id lands on the new default (Iris is opt-in). A custom
-- theme keeps its look: a purple base becomes 'iris', a Forest base 'ficus', and an account selection that carries a
-- custom theme follows its base (the preference contract requires themeId = customTheme.base). Iris and custom ids
-- are left alone.
-- Rollback: a rolled-back Core and web read a plain 'ficus' selection as unknown and fall back to their own default.
-- They reject custom themes and presets that carry the new marker or base ('iris'), so those are ignored on screen
-- (old web keeps its device-local theme; old Core refuses to update or re-save a migrated preset) until roll-forward.
-- Nothing is lost: the old web never overwrites a server row it cannot validate.
-- Paths: the account selection's themeId (normalizeStoredThemeSelection's themeId), and a custom-theme document's
-- base and format marker, both in the account's customTheme snapshot and in each saved preset's document.
UPDATE "user_preferences"
SET "theme" = jsonb_set("theme", '{themeId}', CASE
  WHEN jsonb_typeof("theme"->'customTheme') = 'object' AND "theme"->>'themeId' = 'tau' THEN '"iris"'::jsonb
  ELSE '"ficus"'::jsonb END)
WHERE "theme"->>'themeId' IN ('tau', 'forest');
--> statement-breakpoint
UPDATE "user_preferences"
SET "theme" = jsonb_set("theme", '{customTheme,base}', CASE "theme"->'customTheme'->>'base'
  WHEN 'tau' THEN '"iris"'::jsonb ELSE '"ficus"'::jsonb END)
WHERE jsonb_typeof("theme"->'customTheme') = 'object' AND "theme"->'customTheme'->>'base' IN ('tau', 'forest');
--> statement-breakpoint
UPDATE "user_preferences" SET "theme" = jsonb_set("theme", '{customTheme,format}', '"ficus-custom-theme"')
WHERE jsonb_typeof("theme"->'customTheme') = 'object' AND "theme"->'customTheme'->>'format' = 'tau-custom-theme';
--> statement-breakpoint
UPDATE "theme_presets"
SET "document" = jsonb_set("document", '{base}', CASE "document"->>'base'
  WHEN 'tau' THEN '"iris"'::jsonb ELSE '"ficus"'::jsonb END)
WHERE "document"->>'base' IN ('tau', 'forest');
--> statement-breakpoint
UPDATE "theme_presets" SET "document" = jsonb_set("document", '{format}', '"ficus-custom-theme"')
WHERE "document"->>'format' = 'tau-custom-theme';
