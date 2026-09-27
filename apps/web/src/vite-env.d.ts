/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __TAU_APP_URL__: string
declare const __TAU_APP_BASE_PATH__: string
/** Build id shared by the page bundle and the service worker; undefined outside vite builds (tests). */
declare const __FICUS_SW_CACHE_VERSION__: string | undefined
/** True only while the Vite development server exposes its local backend controls. */
declare const __TAU_DEV_BACKEND_BAR__: boolean | undefined
/** Hash of index.css's + builtins.css's own content; injected identically by
 * vite.config.ts (the main bundle) and generate-theme-flash.ts (the pre-paint
 * script bundle) — see theme/builtinFingerprint.ts. Undefined outside a real
 * build (tests, an unbuilt dev import). */
declare const __TAU_BUILTIN_CSS_FINGERPRINT__: string | undefined
