import { createContext, useContext } from 'react'
import type { Agent, Squad } from '@ficus/shared'
import type { FarmInput } from '../layout'
import type { FarmLayout } from '../types'
import type { Selection } from '../selection'

/** What every card needs to know about the farm, and how it can move the player around. */
export interface FarmCardEnv {
  layout: FarmLayout
  input: FarmInput
  agentsById: ReadonlyMap<string, Agent>
  squadsById: ReadonlyMap<string, Squad>
  halted: ReadonlySet<string>
  select: (selection: Selection) => void
  openChat: (agentId: string) => void
  startConsultant: (squadId: string) => void
  openAssistant: (conversationId?: string) => void
  /** A brand-new Assistant conversation. */
  startAssistant: () => void
  /** Opens the farm chat on your DM with someone. */
  messagePerson: (userId: string) => void
  /** Opens the character builder (how you look on the farm). */
  changeLook: () => void
  /** Selects something and glides the camera to it (a chip in chat). */
  flyTo: (selection: Selection) => void
  /** Opens farm chat with this added to what you're writing (e.g. a reference to a plant). */
  shareInChat: (text: string) => void
}

export const FarmCardContext = createContext<FarmCardEnv | null>(null)

export function useFarmCard(): FarmCardEnv {
  const env = useContext(FarmCardContext)
  if (!env) throw new Error('useFarmCard outside FarmCardContext')
  return env
}
