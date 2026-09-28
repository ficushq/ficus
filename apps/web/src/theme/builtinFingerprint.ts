/** Build-time hash of index.css's + builtins.css's own content (see
 * apps/web/vite.config.ts and apps/web/scripts/generate-theme-flash.ts,
 * which both compute and inject the IDENTICAL value for the same source via
 * `__FICUS_BUILTIN_CSS_FINGERPRINT__`) — included in a persisted resolved-theme
 * snapshot's storage key (custom.ts's persistResolvedSnapshot/
 * readResolvedSnapshot) so a deploy that changes a built-in token's value
 * invalidates every previously persisted snapshot on next read, instead of
 * flashing an outdated derived color before the next real repaint corrects
 * it. 'dev' outside a real build (bun test, an unbuilt dev import). */
export const BUILTIN_CSS_FINGERPRINT =
  typeof __FICUS_BUILTIN_CSS_FINGERPRINT__ === 'string' && __FICUS_BUILTIN_CSS_FINGERPRINT__.length > 0
    ? __FICUS_BUILTIN_CSS_FINGERPRINT__
    : 'dev'
