import { useCallback, useEffect, useRef, useState } from 'react'
import type { FarmLayout } from '../farm/types'
import { useAccountSettings } from '../settings/useAccountSettings'
import { playChime, readSoundPreference, writeSoundPreference } from './chimes'
import { chimeFor, tallyFarm, type FarmTally } from './farmSounds'
import { haptic } from '../embed/embed'

/**
 * Sound on/off plus chimes when the live farm changes. The choice follows the
 * signed-in account (see settings/useAccountSettings.ts) and is remembered in
 * this browser too.
 */
export function useFarmSounds(layout: FarmLayout, needsYou: number) {
  const [on, setOn] = useState(readSoundPreference)
  const { saved, save } = useAccountSettings()
  const previous = useRef<FarmTally | null>(null)

  // The account's choice wins when it loads, or changes on another device.
  const accountOn = saved?.sound
  useEffect(() => {
    if (accountOn === undefined) return
    setOn(accountOn)
    writeSoundPreference(accountOn)
  }, [accountOn])

  useEffect(() => {
    const tally = tallyFarm(layout, needsYou)
    const chime = chimeFor(previous.current, tally)
    previous.current = tally
    if (on && chime) playChime(chime)
    // Inside Ficus Mobile a harvest is felt too, whatever the sound setting.
    if (chime === 'harvested') haptic('harvest')
  }, [layout, needsYou, on])

  const toggle = useCallback(() => {
    const next = !on
    setOn(next)
    writeSoundPreference(next)
    if (next) playChime('planted')
    void save({ sound: next })
  }, [on, save])

  return { on, toggle }
}
