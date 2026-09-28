import type { VoiceInputMode } from '../voice/useRealtimeVoiceAssistant'
import { VOICE_INPUT_MODE_STORAGE_KEY } from '@ficus/shared/browser-keys'

export { VOICE_INPUT_MODE_STORAGE_KEY }

export function getStoredVoiceInputMode(storage: Pick<Storage, 'getItem'> | undefined): VoiceInputMode {
  try {
    const stored = storage?.getItem(VOICE_INPUT_MODE_STORAGE_KEY)
    return stored === 'manual' || stored === 'automatic' ? stored : 'automatic'
  } catch {
    return 'automatic'
  }
}

export function setStoredVoiceInputMode(storage: Pick<Storage, 'setItem'> | undefined, mode: VoiceInputMode): void {
  try {
    storage?.setItem(VOICE_INPUT_MODE_STORAGE_KEY, mode)
  } catch {
    // Ignore storage failures so voice mode selection still works in restricted browsers.
  }
}

export function isVoiceHoldShortcutEditableTarget(target: unknown): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null
  const tagName = element?.tagName?.toUpperCase()
  return Boolean(
    element?.isContentEditable ||
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    tagName === 'BUTTON'
  )
}

export interface VoiceHoldKeyboardEvent {
  code?: string
  key?: string
  repeat?: boolean
  target: unknown
  preventDefault: () => void
}

export function isManualHoldShortcutKey(event: Pick<VoiceHoldKeyboardEvent, 'code' | 'key'>): boolean {
  return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar'
}

export function handleManualHoldKeyDown(
  event: VoiceHoldKeyboardEvent,
  isHolding: boolean,
  onStart: () => void
): boolean {
  if (!isManualHoldShortcutKey(event) || event.repeat || isVoiceHoldShortcutEditableTarget(event.target) || isHolding) {
    return false
  }
  event.preventDefault()
  onStart()
  return true
}

export function handleManualHoldKeyUp(event: VoiceHoldKeyboardEvent, isHolding: boolean, onEnd: () => void): boolean {
  if (!isManualHoldShortcutKey(event) || isVoiceHoldShortcutEditableTarget(event.target) || !isHolding) return false
  event.preventDefault()
  onEnd()
  return true
}

export interface VoiceOrbPointerEvent {
  pointerId: number
  preventDefault: () => void
  currentTarget: {
    setPointerCapture: (pointerId: number) => void
  }
}

export function handleManualVoiceOrbPointerDown(
  event: VoiceOrbPointerEvent,
  canManualHold: boolean,
  onStart: () => void
): boolean {
  if (!canManualHold) return false
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  onStart()
  return true
}

export function handleManualVoiceOrbPointerUp(
  event: Pick<VoiceOrbPointerEvent, 'preventDefault'>,
  canSubmitSpeech: boolean,
  onEnd: () => void
): boolean {
  if (!canSubmitSpeech) return false
  event.preventDefault()
  onEnd()
  return true
}
