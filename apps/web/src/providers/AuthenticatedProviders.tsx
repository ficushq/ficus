import { useCallback, type ReactNode } from 'react'
import { useAuth } from './AuthProvider'
import { WebSocketProvider } from './WebSocketProvider'
import { QueryInvalidator } from '../components/QueryInvalidator'
import { getWsUrl } from '../api/client'
import { fetchWsTicket } from '../api/auth'
import { ConversationClientProvider } from '@ficus/client-react'
import { LiveConversationProvider } from './LiveConversationProvider'
import { client } from '../api/clientInstance'
import { LoadingShapeScopeProvider } from '../hooks/useLoadingShapeCount'

export function AuthenticatedProviders({ children }: { children: ReactNode }) {
  const { isAuthenticated, authRequired, needsFirstAdminSetup, needsAdminCompletion } = useAuth()

  // Resolve the WS URL per connection. When auth is required, exchange the
  // session for a single-use ticket so the long-lived session bearer never
  // travels in the WS URL. When auth is disabled, connect without one.
  const getUrl = useCallback(async () => {
    if (authRequired) {
      const { ticket } = await fetchWsTicket()
      return `${getWsUrl()}?ticket=${encodeURIComponent(ticket)}`
    }
    return getWsUrl()
  }, [authRequired])

  // Stay on the lightweight tree during first-admin setup too: a bootstrap-password
  // session is authenticated, but the app (and its socket) has nothing to show until
  // an admin exists — or, once an account exists, until it has a passkey.
  if (!isAuthenticated || needsFirstAdminSetup || needsAdminCompletion) {
    return <ConversationClientProvider client={client}>{children}</ConversationClientProvider>
  }

  return (
    <WebSocketProvider getUrl={getUrl}>
      <LiveConversationProvider client={client}>
        <LoadingShapeScopeProvider>
          <QueryInvalidator />
          {children}
        </LoadingShapeScopeProvider>
      </LiveConversationProvider>
    </WebSocketProvider>
  )
}
