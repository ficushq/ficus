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
import { MultiplayerProvider } from './multiplayer/MultiplayerProvider'
import { resumeLastApp } from './app/appSurface'
import { exchangeHandoff, startEmbed } from './embed/embed'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true } },
})

// In Ficus Mobile's web view: sign in with the code the app injected before the first query.
const embed = startEmbed()
const signingIn = embed.handoff ? exchangeHandoff(embed.handoff) : Promise.resolve(true)

// An installed Farm app last left in the web app reopens there instead.
if (!resumeLastApp()) void signingIn.then(render)

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SkinProvider>
          <MultiplayerProvider>
            <ChatProvider>
              <App />
            </ChatProvider>
          </MultiplayerProvider>
        </SkinProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
