/* eslint-disable react-refresh/only-export-components -- provider and matching hook form one injection seam */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { mergeDefined } from '../../api/mergeDefined'
import {
  getTokenRegistrationOptions,
  verifyTokenRegistration,
  requestPasskeyRecovery,
  sendVerificationEmail,
  getRegistrationOptions,
  verifyRegistration,
  getLoginOptions,
  verifyLogin,
  demoPair,
  getAddPasskeyOptions,
  verifyAddPasskey,
} from '../../api/auth'

const actualAuthApi = {
  getTokenRegistrationOptions,
  verifyTokenRegistration,
  requestPasskeyRecovery,
  sendVerificationEmail,
  getRegistrationOptions,
  verifyRegistration,
  getLoginOptions,
  verifyLogin,
  demoPair,
  getAddPasskeyOptions,
  verifyAddPasskey,
}
export type AuthApi = typeof actualAuthApi
const AuthApiContext = createContext(actualAuthApi)

export function AuthApiProvider({ api, children }: { api: Partial<AuthApi>; children: ReactNode }) {
  const value = useMemo(() => mergeDefined(actualAuthApi, api), [api])
  return <AuthApiContext.Provider value={value}>{children}</AuthApiContext.Provider>
}

export function useAuthApi(): AuthApi {
  return useContext(AuthApiContext)
}
