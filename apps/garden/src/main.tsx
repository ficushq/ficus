import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@fontsource-variable/fraunces'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { App } from './app/App'
import { ChatProvider } from './chat'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ChatProvider>
        <App />
      </ChatProvider>
    </QueryClientProvider>
  </StrictMode>
)
