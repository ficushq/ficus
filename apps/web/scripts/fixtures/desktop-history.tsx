import { createRoot } from 'react-dom/client'
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppHeader } from '../../src/components/AppNav'
import { ThemeProvider } from '../../src/providers/ThemeProvider'
import { useDesktopShellChrome } from '../../src/hooks/useDesktopShellChrome'
import { Modal } from '../../src/components/Modal'
import { useState } from 'react'
import '../../src/index.css'
import { initializeDesktopHistory } from '../../src/lib/desktopHistory'

initializeDesktopHistory()

export function Fixture() {
  useDesktopShellChrome()
  const location = useLocation()
  const navigate = useNavigate()
  const [reviewOpen, setReviewOpen] = useState(false)
  return (
    <>
      <AppHeader usePendingActions={() => ({ data: [] })} />
      <output>{location.pathname + location.search + location.hash}</output>
      <button onClick={() => navigate('/chat?session=one')}>Chat one</button>
      <button onClick={() => navigate('/squads/team?ws=42#activity')}>Work stream</button>
      <button onClick={() => navigate('/chat?session=two', { replace: true })}>Replace chat</button>
      <button onClick={() => navigate('/settings')}>Branch</button>
      <button onClick={() => setReviewOpen(true)}>Open review</button>
      <Modal isOpen={reviewOpen} onClose={() => setReviewOpen(false)} title="Review" size="workspace" closeOnEscape>
        Review body
      </Modal>
      <textarea
        aria-label="Editor"
        onKeyDown={(e) => {
          if (e.metaKey && e.key === '[') e.preventDefault()
        }}
      />
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ThemeProvider>
      <BrowserRouter>
        <Fixture />
      </BrowserRouter>
    </ThemeProvider>
  </QueryClientProvider>
)
