import { useCallback, useEffect, useRef, useState } from 'react'
import type { FarmLayout } from '../farm/types'
import { playChime, readSoundPreference, writeSoundPreference } from './chimes'
import { chimeFor, tallyFarm, type FarmTally } from './farmSounds'

/** Sound on/off plus chimes when the live farm changes. */
export function useFarmSounds(layout: FarmLayout, needsYou: number) {
  const [on, setOn] = useState(readSoundPreference)
  const previous = useRef<FarmTally | null>(null)

  useEffect(() => {
    const tally = tallyFarm(layout, needsYou)
    const chime = chimeFor(previous.current, tally)
    previous.current = tally
    if (on && chime) playChime(chime)
  }, [layout, needsYou, on])

  const toggle = useCallback(() => {
    setOn((was) => {
      writeSoundPreference(!was)
      if (!was) playChime('planted')
      return !was
    })
  }, [])

  return { on, toggle }
}
