# Semantic colors

Iris's light/dark colors are unchanged, except for intentional text-selection styling. Status meanings and precedence still come from `packages/shared/src/status-presentation.ts`, which is unchanged.

## Compatibility

Badge colors deliberately preserve their own appearance rather than sharing a single foreground/surface pair with role text: role text uses shade 700/400 while badges use 800/200, and role surfaces use 50/900 at 20% while badges use 100/900 at 30% (70% on hover). Merging them would produce a visible change to one or the other.

Each role therefore keeps its four plain slots alongside dedicated `badge-fg`, `badge-surface`, and `badge-hover` slots. `validateThemeTokenOverrides` rejects an override containing any status token unless it supplies all 162 status tokens (nine roles × seven semantic slots plus eleven tone steps). Full built-in definitions must provide every active token. The custom-theme importer calls this shared override validator **before merging with the base**; validating only the final inherited set would hide partial status overrides.

Values remain in `apps/web/src/index.css`, the source of truth used by the existing class-based web registry. All Tailwind-mapped tokens use bare RGB channels; translucent surfaces have separate `--opacity-*` metadata multiplied by Tailwind modifiers. The original `--opacity-input-border` and `--opacity-panel-border` remain unchanged. Theme adapters must carry opacity metadata along with color channels. CSS-only scrollbar colors retain embedded alpha.

## Badge call-site inventory

Every caller of the shared `Badge` component is classified below. The color prop now accepts status roles or explicit decorative accent slots, not arbitrary Tailwind color names. Existing labels, mappings, and interactions are preserved; this is not a semantic reclassification of squad/deployment states or priority.

| Call site (`apps/web/src/`)                                                           | Classification / treatment                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `components/AgentConversationBody.tsx`, `lib/execution-status.ts`                     | Execution status → shared execution role map                                                                                                                                                                 |
| `components/WorkStreamStatusBadges.tsx`, `lib/workStreamStatusPresentation.ts`        | Stored/derived work status → shared work role map; Parked → neutral                                                                                                                                          |
| `components/WorkStreamDetailModal.tsx`                                                | Wait reason → externalWait/humanWait/review/danger; priority critical/high/normal/low preserves red/orange/gray via danger/externalWait/neutral; completion **mode** → decorative accents 2/3/4/5 or neutral |
| `components/WorkStreamList.tsx`                                                       | Status/priority → above maps; assignee and squad identity → accent-1; PR identity → accent-2; queue position → neutral                                                                                       |
| `components/WorkStreamGraph.tsx`                                                      | Status and priority badges/legends → above maps                                                                                                                                                              |
| `components/squads/AgentWorkStreamsPanel.tsx`, `components/squads/WorkStreamList.tsx` | Delegate status badges to WorkStreamStatusBadges                                                                                                                                                             |
| `components/AssistantCommandCenter.tsx`                                               | Entity kind → accent-1; work status delegates to WorkStreamStatusBadges                                                                                                                                      |
| `components/EntityReferencePreview.tsx`                                               | Agent type identity → accent-1; work status delegates to WorkStreamStatusBadges                                                                                                                              |
| `components/SquadDetailPage.tsx`, `components/squads/SquadList.tsx`                   | Existing active/paused/archived status palette preserved as success/review/neutral                                                                                                                           |
| `components/WorkStreamTrackedResources.tsx`                                           | Merge outcome merged/closed → success/neutral; delivery designation → accent-1                                                                                                                               |
| `components/recommendations/RecommendationCard.tsx`, `RecommendationDetail.tsx`       | Existing confidence/risk high/medium/low → danger/attention/neutral; recommendation status remains neutral                                                                                                   |
| `components/schedules/SchedulesList.tsx`                                              | Health → neutral/success/danger; **action kind** → accent-2/1/3; squad/agent **scope** identity → accent-6/7                                                                                                 |
| `components/squads/LocalDeploymentsPanel.tsx`                                         | Existing starting/running/restarting/unhealthy/crashed/stopped status and filter palette → review/success/progress/externalWait/danger/neutral                                                               |

The seven decorative accents are purple, blue, green, violet, orange, amber, and cyan: Iris's values, which the default Ficus theme and the other recolors keep. They have independent tokens, so recoloring a lifecycle role does not recolor unrelated entity/mode badges. Neutral decoration shares the neutral role treatment. Only used decorative colors are registered; the legacy entries lime, emerald, teal, sky, indigo, fuchsia, pink, and rose are not. Simplification of the used decorative colors is a separate, deferred effort.

Other components whose names contain “Badge” but do not use the shared `Badge` API are not part of this table; sandbox status components already delegate to the shared web status adapter.

## Miscellaneous chrome

- `::selection` uses `--color-selection-bg` with `--color-text-primary`: a soft accent-tinted background (leaf-green in Ficus, lavender in Iris) and readable primary text in both appearances, replacing the unstyled browser default. `--color-selection-border` remains for bordered selection controls; CSS selection highlights do not support borders.
- The WebKit thin scrollbar remains RGB 156/163/175 at 50% opacity, now via `--scrollbar-thumb`.
- The custom dark checkbox check remains white, now via `--checkbox-check`.
- Verified `bg-accent` fills use `text-on-accent` (including the primary button component rule and its 8% inset highlight). Active tab count pills use the same foreground token at 20% for their overlay. Filled-control ink, paper surfaces, scrims, highlights and switch thumbs now have independent tokens; only image/document canvases retain bounded content exceptions. ChatView's custom `sendButtonClassName` takes the filled-control ink token; its default accent fill takes the accent ink token.
- Status marker colors for canvas/Three.js are read lazily as numeric comma-form RGB, never passed as unsupported `var(...)`. [Graph colors](graph-colors.md) owns reactive graph snapshots and remaining graph colors.

## Verification and coverage boundary

`theme/semanticParity.test.ts` compiles the real new and old Tailwind utilities and compares fully substituted colors for both appearances, including hover and neutral special cases. `theme-color-opacity.test.ts` also checks `/25`, `/50`, and `/100` without double alpha. Identity contrast remains ≥4.5:1 on both original and actual app surfaces. Component tests pin token routing, not concrete palette utility names.

No legacy-file waiver remains: every app-owned color resolves through a registered token. Status tone steps retain the exact old control palette without changing lifecycle classifications; decorative ramps remain separate for indigo/pink/rose/emerald/violet identity surfaces. Voice material, log viewers, brand assets and black/white chrome are also tokenized. See [complete coverage](complete-coverage.md) for the closed exception list and verification boundary.
