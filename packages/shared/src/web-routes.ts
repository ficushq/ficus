/**
 * First path segments of the web app's own routes (`apps/web/src/App.tsx`
 * `<Route path>` entries, its `location.pathname === '/…'` gates and the farm
 * sign-in path).
 *
 * Core never strips a public-address base path whose first segment is one of
 * these, because doing so would shadow that page at the local root address
 * (a public address of `https://host/settings` would otherwise turn
 * `http://localhost:3000/settings` into the feed). `apps/web/src/webRoutes.test.ts`
 * keeps this list in sync with the router.
 */
export const WEB_APP_ROUTE_SEGMENTS: readonly string[] = [
  'actions',
  'activity',
  'add-passkey',
  'chat',
  'demo',
  'farm-sign-in',
  'feed',
  'inbox',
  'onboarding',
  'recommendations',
  'register',
  'schedules',
  'settings',
  'squads',
  'voice',
  'work-streams',
]
