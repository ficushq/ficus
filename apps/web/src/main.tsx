import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './providers/AuthProvider'
import { AuthenticatedProviders } from './providers/AuthenticatedProviders'
import { ThemeAccountSync } from './providers/ThemeAccountSync'
import { ThemeProvider } from './providers/ThemeProvider'
import App from './App'
import './index.css'

// Register service worker for PWA support
import { setupFocusManager } from './lib/focusManagerSetup'
import { registerServiceWorker } from './lib/serviceWorker'
import { DevBackendBar } from './components/DevBackendBar'
import { prepareOAuthCallbackHistory } from './lib/oauthCallbackBootstrap'
import { resumeLastApp } from './lib/appSurface'

// OAuth callback capabilities and codes must leave the URL before service
// worker registration, auth bootstrap, or any other network-capable work.
prepareOAuthCallbackHistory()

// An installed Ficus app last left in the farm reopens there instead: skip
// booting (and the service worker) while the page leaves.
if (!resumeLastApp()) boot()

function boot() {
  // Register service worker as early as possible
  if ('serviceWorker' in navigator) {
    registerServiceWorker().catch(console.error)
  }

  // Refetch active stale queries whenever the app/window becomes active again
  // (window focus, tab visible, or PWA/bfcache resume).
  setupFocusManager()

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Refetch when window regains focus
        refetchOnWindowFocus: true,
        // Refetch when reconnecting to network - critical for offline support
        refetchOnReconnect: true,
        // Keep data fresh for 5 minutes before considering stale
        staleTime: 5 * 60 * 1000,
        // Keep unused data in cache for 30 minutes
        gcTime: 30 * 60 * 1000,
        // Retry failed requests 3 times with exponential backoff
        retry: 3,
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      },
    },
  })

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter basename={import.meta.env.BASE_URL?.replace(/\/$/, '')}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <div className="flex h-full min-h-0 flex-col">
              <DevBackendBar />
              <div className="min-h-0 flex-1">
                <AuthProvider>
                  <ThemeAccountSync />
                  <AuthenticatedProviders>
                    <App />
                  </AuthenticatedProviders>
                </AuthProvider>
              </div>
            </div>
          </ThemeProvider>
        </QueryClientProvider>
      </BrowserRouter>
    </StrictMode>
  )
}
