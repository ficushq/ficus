import { expect, test } from 'bun:test'
import { VOICE_INPUT_MODE_STORAGE_KEY, getStoredVoiceInputMode } from './voiceWorkspaceInputMode'

test('the voice input mode is stored under the ficus key', () => {
  expect(VOICE_INPUT_MODE_STORAGE_KEY).toBe('ficus_voice_workspace_input_mode')
  const storage = { getItem: (key: string) => (key === 'ficus_voice_workspace_input_mode' ? 'manual' : null) }
  expect(getStoredVoiceInputMode(storage)).toBe('manual')
})
