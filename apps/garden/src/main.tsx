import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@fontsource-variable/fraunces'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'
import './skins/nostalgic/theme.css'
import './styles.css'
import { App } from './app/App'
import { ChatProvider } from './chat'
import { SkinProvider } from './skins'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SkinProvider>
        <ChatProvider>
          <App />
        </ChatProvider>
      </SkinProvider>
    </QueryClientProvider>
  </StrictMode>
)
