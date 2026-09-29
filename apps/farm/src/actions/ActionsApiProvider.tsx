import { createContext, useContext, type ReactNode } from 'react'
import { client } from '../api/client'
import { createActionsApi, type ActionsApi } from './api'

const defaultApi = createActionsApi(client)
const ActionsApiContext = createContext<ActionsApi>(defaultApi)

/** Swap the server calls the action forms make (tests pass stubs; the app uses the real client). */
export function ActionsApiProvider({ api, children }: { api: ActionsApi; children: ReactNode }) {
  return <ActionsApiContext.Provider value={api}>{children}</ActionsApiContext.Provider>
}

export function useActionsApi(): ActionsApi {
  return useContext(ActionsApiContext)
}
