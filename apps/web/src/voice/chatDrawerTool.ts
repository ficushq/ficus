import { setQueryParamInPath } from '../lib/urlStateUtils'

export type ChatDrawerToolState = 'open' | 'closed' | 'expanded' | 'toggle'

export function getChatDrawerPath(currentPath: string, state: ChatDrawerToolState): string {
  const current = new URL(currentPath, 'http://ficus.local').searchParams.get('chat')
  const nextState = state === 'toggle' ? (current === 'open' || current === 'expanded' ? 'closed' : 'open') : state
  return setQueryParamInPath(currentPath, 'chat', nextState === 'closed' ? null : nextState)
}
