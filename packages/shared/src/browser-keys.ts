/**
 * Browser-side names shared by every Ficus web surface served from one origin
 * (the web app, the embedded docs at /docs, and any sibling app such as the
 * farm UI): localStorage/sessionStorage keys, in-page event and postMessage
 * names, and service-worker cache prefixes. Same-origin apps share these
 * stores, so import the names from here rather than repeating the strings.
 *
 * There is no read of the pre-rename names: browser-local state resets once.
 */

// --- localStorage ---------------------------------------------------------

/** Pre-cookie bearer token; only cleared now (auth is an HttpOnly session cookie). */
export const AUTH_TOKEN_STORAGE_KEY = 'ficus_password'

/** Pre-paint theme selection, read synchronously by the inline script in apps/web/index.html. */
export const THEME_ID_STORAGE_KEY = 'ficus-theme-id'
export const APPEARANCE_STORAGE_KEY = 'ficus-appearance'
/** Older single-key selection holding bare 'light' | 'dark'; read, then removed on the next write. */
export const LEGACY_THEME_STORAGE_KEY = 'ficus-theme'
/** Plain resolved-surface color, still written beside the state-keyed snapshot. */
export const LEGACY_SURFACE_COLOR_STORAGE_KEY = 'ficus-surface-color'
/** State-keyed resolved-surface snapshot: `{ theme, appearance, surface }`. */
export const THEME_SURFACE_STORAGE_KEY = 'ficus-theme-surface'
/** The active custom theme document (JSON). */
export const CUSTOM_THEME_STORAGE_KEY = 'ficus-custom-theme'
/** Last resolved custom-theme properties, so the pre-paint script can paint without deriving. */
export const CUSTOM_THEME_RESOLVED_STORAGE_KEY = 'ficus-custom-theme-resolved'
/** Library preset the active custom theme came from, and that preset's owner. */
export const THEME_PRESET_ID_STORAGE_KEY = 'ficus-theme-preset-id'
export const THEME_PRESET_OWNER_ID_STORAGE_KEY = 'ficus-theme-preset-owner-id'
/** Retired per-device "keep my own theme" flag; only ever removed. */
export const LEGACY_THEME_LOCAL_OVERRIDE_STORAGE_KEY = 'ficus-theme-local-override'

/** Work stream list/kanban/graph choice: `${prefix}${squadId}` and `${prefix}home.${squadId}`. */
export const WORK_STREAM_VIEW_STORAGE_PREFIX = 'ficus.wsView.'
/** Remembered skeleton counts: `${prefix}.${scope}.${surface}`. */
export const LOADING_SHAPE_STORAGE_PREFIX = 'ficus.loadingShape.v1'
export const DEV_BACKEND_SHAPE_SCOPE_STORAGE_KEY = 'ficus.devBackend.shapeScope'
export const ASSISTANT_POSITION_STORAGE_KEY = 'ficus-assistant-position'
export const ASSISTANT_SIZE_STORAGE_KEY = 'ficus-assistant-size'
export const SQUAD_CHAT_SIDEBAR_WIDTH_STORAGE_KEY = 'ficus-squad-chat-sidebar-width'
export const VOICE_INPUT_MODE_STORAGE_KEY = 'ficus_voice_workspace_input_mode'
export const PUSH_SUBSCRIPTION_ID_STORAGE_KEY = 'ficus_push_subscription_id'
/** Unsent workflow drafts: `${prefix}${JSON.stringify([apiUrl, identityType, owner, draftId])}`. */
export const WORKFLOW_DRAFT_STORAGE_PREFIX = 'ficus:workflow-draft:'
/** Set by the docs site's inline head script (apps/docs/src/scripts/docs-mode.js inlines this value). */
export const DOCS_MODE_STORAGE_KEY = 'ficus-docs-mode'

// --- localStorage and sessionStorage -------------------------------------

/** Flag of the pre-version-anchored PWA update flow; cleared from both stores on boot. */
export const PWA_JUST_APPLIED_STORAGE_KEY = 'ficus-pwa-just-applied'

// --- sessionStorage -------------------------------------------------------

/** `${fromVersion}->${toVersion}` of the last automatic PWA update, to stop reload loops. */
export const PWA_AUTO_APPLY_TRANSITION_STORAGE_KEY = 'ficus-pwa-auto-apply-transition'
/** Provider an OAuth flow started with, consumed once by the callback page. */
export const OAUTH_PROVIDER_HINT_SESSION_KEY = 'ficusOAuthProviderHint'

// --- history.state (OAuth callback page) ----------------------------------

/** Keys the OAuth callback bootstrap writes into `history.state` before the app boots. */
export const OAUTH_COMPLETION_STATE_KEY = 'ficusOAuthCompletion'
export const OAUTH_LOCAL_CALLBACK_STATE_KEY = 'ficusOAuthLocalCallback'
export const OAUTH_CALLBACK_OUTCOME_STATE_KEY = 'ficusOAuthCallbackOutcome'
export const OAUTH_CALLBACK_PROVIDER_STATE_KEY = 'ficusOAuthCallbackProvider'

// --- in-page events (window) and postMessage types ------------------------

/** window Event: an entity reference preview opened, so other open previews close. */
export const REFERENCE_PREVIEW_OPEN_EVENT = 'ficus:reference-preview-open'
/** window Event: a work stream view choice changed in this tab. */
export const WORK_STREAM_VIEW_CHANGED_EVENT = 'ficus:work-stream-view-changed'
/** postMessage `type` from artifact frames to the voice workspace (push-to-talk key held/released). */
export const VOICE_HOLD_KEYDOWN_MESSAGE = 'ficus:voice-hold-keydown'
export const VOICE_HOLD_KEYUP_MESSAGE = 'ficus:voice-hold-keyup'
/** postMessage `type` from a presentation HTML block frame reporting its content height. */
export const PRESENTATION_HTML_HEIGHT_MESSAGE = 'ficus:presentation-html-height'
/** window Events that open or toggle the assistant panel, and open the voice companion. */
export const OPEN_ASSISTANT_EVENT = 'open-ficus-assistant'
export const TOGGLE_ASSISTANT_EVENT = 'toggle-ficus-assistant'
export const OPEN_VOICE_EVENT = 'open-ficus-voice'

// --- service-worker Cache Storage -----------------------------------------

/** Runtime cache names are `${prefix}${buildVersion}`; activation deletes older versions. */
export const SW_CACHE_PREFIX = 'ficus-cache-'
export const SW_API_CACHE_PREFIX = 'ficus-api-cache-'
export const SW_RUNTIME_CACHE_PREFIXES = [SW_CACHE_PREFIX, SW_API_CACHE_PREFIX] as const
/** Page-side cache of signed images, keyed by image id (not managed by the service worker). */
export const IMAGE_CACHE_NAME = 'ficus-images-v1'
