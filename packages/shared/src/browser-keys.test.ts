import { expect, test } from 'bun:test'
import * as keys from './browser-keys'

test('browser storage keys use the ficus names', () => {
  expect(keys.AUTH_TOKEN_STORAGE_KEY).toBe('ficus_password')
  expect(keys.THEME_ID_STORAGE_KEY).toBe('ficus-theme-id')
  expect(keys.APPEARANCE_STORAGE_KEY).toBe('ficus-appearance')
  expect(keys.LEGACY_THEME_STORAGE_KEY).toBe('ficus-theme')
  expect(keys.LEGACY_SURFACE_COLOR_STORAGE_KEY).toBe('ficus-surface-color')
  expect(keys.THEME_SURFACE_STORAGE_KEY).toBe('ficus-theme-surface')
  expect(keys.CUSTOM_THEME_STORAGE_KEY).toBe('ficus-custom-theme')
  expect(keys.CUSTOM_THEME_RESOLVED_STORAGE_KEY).toBe('ficus-custom-theme-resolved')
  expect(keys.THEME_PRESET_ID_STORAGE_KEY).toBe('ficus-theme-preset-id')
  expect(keys.THEME_PRESET_OWNER_ID_STORAGE_KEY).toBe('ficus-theme-preset-owner-id')
  expect(keys.LEGACY_THEME_LOCAL_OVERRIDE_STORAGE_KEY).toBe('ficus-theme-local-override')
  expect(keys.WORK_STREAM_VIEW_STORAGE_PREFIX).toBe('ficus.wsView.')
  expect(keys.LOADING_SHAPE_STORAGE_PREFIX).toBe('ficus.loadingShape.v1')
  expect(keys.DEV_BACKEND_SHAPE_SCOPE_STORAGE_KEY).toBe('ficus.devBackend.shapeScope')
  expect(keys.ASSISTANT_POSITION_STORAGE_KEY).toBe('ficus-assistant-position')
  expect(keys.SQUAD_CHAT_CONSULTANTS_COLLAPSED_STORAGE_KEY).toBe('ficus-squad-chat-consultants-collapsed')
  expect(keys.VOICE_INPUT_MODE_STORAGE_KEY).toBe('ficus_voice_workspace_input_mode')
  expect(keys.PUSH_SUBSCRIPTION_ID_STORAGE_KEY).toBe('ficus_push_subscription_id')
  expect(keys.PWA_JUST_APPLIED_STORAGE_KEY).toBe('ficus-pwa-just-applied')
  expect(keys.PWA_AUTO_APPLY_TRANSITION_STORAGE_KEY).toBe('ficus-pwa-auto-apply-transition')
  expect(keys.WORKFLOW_DRAFT_STORAGE_PREFIX).toBe('ficus:workflow-draft:')
  expect(keys.OAUTH_PROVIDER_HINT_SESSION_KEY).toBe('ficusOAuthProviderHint')
  expect(keys.DOCS_MODE_STORAGE_KEY).toBe('ficus-docs-mode')
})

test('in-page event and message names use the ficus names', () => {
  expect(keys.REFERENCE_PREVIEW_OPEN_EVENT).toBe('ficus:reference-preview-open')
  expect(keys.WORK_STREAM_VIEW_CHANGED_EVENT).toBe('ficus:work-stream-view-changed')
  expect(keys.VOICE_HOLD_KEYDOWN_MESSAGE).toBe('ficus:voice-hold-keydown')
  expect(keys.VOICE_HOLD_KEYUP_MESSAGE).toBe('ficus:voice-hold-keyup')
  expect(keys.PRESENTATION_HTML_HEIGHT_MESSAGE).toBe('ficus:presentation-html-height')
  expect(keys.OPEN_ASSISTANT_EVENT).toBe('open-ficus-assistant')
  expect(keys.TOGGLE_ASSISTANT_EVENT).toBe('toggle-ficus-assistant')
  expect(keys.OPEN_VOICE_EVENT).toBe('open-ficus-voice')
})

test('OAuth callback history-state keys use the ficus names', () => {
  expect(keys.OAUTH_COMPLETION_STATE_KEY).toBe('ficusOAuthCompletion')
  expect(keys.OAUTH_LOCAL_CALLBACK_STATE_KEY).toBe('ficusOAuthLocalCallback')
  expect(keys.OAUTH_CALLBACK_OUTCOME_STATE_KEY).toBe('ficusOAuthCallbackOutcome')
  expect(keys.OAUTH_CALLBACK_PROVIDER_STATE_KEY).toBe('ficusOAuthCallbackProvider')
})

test('service-worker runtime cache prefixes are exactly the two ficus prefixes', () => {
  expect(keys.SW_CACHE_PREFIX).toBe('ficus-cache-')
  expect(keys.SW_API_CACHE_PREFIX).toBe('ficus-api-cache-')
  expect([...keys.SW_RUNTIME_CACHE_PREFIXES]).toEqual(['ficus-cache-', 'ficus-api-cache-'])
  expect(keys.IMAGE_CACHE_NAME).toBe('ficus-images-v1')
})

test('every exported name is a ficus name', () => {
  for (const value of Object.values(keys)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      expect(item).toMatch(/^ficus|-ficus-/)
    }
  }
})
