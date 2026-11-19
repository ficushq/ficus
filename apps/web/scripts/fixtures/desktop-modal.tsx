import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { AppHeader } from '../../src/components/AppNav'
import { InboxPopupProvider } from '../../src/components/InboxPopupProvider'
import { ThemeProvider } from '../../src/providers/ThemeProvider'
import { useDesktopShellChrome } from '../../src/hooks/useDesktopShellChrome'
import { Modal, MODAL_SIZE_STYLE } from '../../src/components/Modal'
import { MobileChatOptionsSheet } from '../../src/components/MobileChatOptionsSheet'
import '../../src/index.css'

export function Fixture() {
  useDesktopShellChrome()
  const [size, setSize] = useState<keyof typeof MODAL_SIZE_STYLE>('default')
  const [open, setOpen] = useState(false)
  const [nested, setNested] = useState(false)
  const [sheet, setSheet] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <AppHeader usePendingActions={() => ({ data: [] })} />
      <main className="p-4">
        <select aria-label="Modal size" value={size} onChange={(event) => setSize(event.target.value as typeof size)}>
          {Object.keys(MODAL_SIZE_STYLE).map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <button className="ficus-button ficus-button-primary" onClick={() => setOpen(true)}>
          Open modal
        </button>
      </main>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Desktop modal"
        size={size}
        mobileFullscreen
        closeOnEscape
      >
        <label>
          Message
          <input className="ficus-field" aria-label="Message" />
        </label>
        <button className="ficus-button ficus-button-secondary" onClick={() => setNested(true)}>
          Open nested modal
        </button>
        <button ref={trigger} className="ficus-button ficus-button-secondary" onClick={() => setSheet(true)}>
          Open options sheet
        </button>
        <Modal isOpen={nested} onClose={() => setNested(false)} title="Nested modal" closeOnEscape>
          <input className="ficus-field" aria-label="Nested message" />
        </Modal>
        <MobileChatOptionsSheet open={sheet} onClose={() => setSheet(false)} triggerRef={trigger}>
          <button className="ficus-button ficus-button-secondary">Attach a file</button>
        </MobileChatOptionsSheet>
      </Modal>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ThemeProvider>
      <BrowserRouter>
        <InboxPopupProvider>
          <Fixture />
        </InboxPopupProvider>
      </BrowserRouter>
    </ThemeProvider>
  </QueryClientProvider>
)
