// Synthetic markdown on the surfaces that show it: a work stream description (secondary ink on the surface), a wait
// message (primary ink on the secondary surface), a review document (prose-base, primary ink) and chat markdown on the
// page. ?theme=<built-in id>&appearance=light|dark selects the theme; unified themes ignore the appearance.
// &nodark drops the root `dark` class after applying the theme, as a page that sets only the theme attributes would:
// prose must take its colours from the theme tokens, not from that class.
import { createRoot } from 'react-dom/client'
import { MarkdownContent } from '../../src/components/MarkdownContent'
import '../../src/index.css'
import { applyResolvedTheme } from '../../src/theme/apply'
import { findWebTheme } from '../../src/theme/registry'

const params = new URLSearchParams(location.search)
const theme = findWebTheme(params.get('theme'))
applyResolvedTheme(
  document.documentElement,
  theme,
  theme.kind === 'unified' ? 'constant' : params.get('appearance') === 'dark' ? 'dark' : 'light'
)
if (params.has('nodark')) document.documentElement.classList.remove('dark')

const sample = `## Problem

Markdown prose has to stay readable on every surface, with **bold text**, a [link to the docs](https://example.com) and \`inline code\`.

> A blockquote that quotes the original request.

- first item
- second item`

const cases = [
  { id: 'description', surface: 'bg-surface', ink: 'text-sm leading-relaxed text-secondary', variant: 'document' },
  { id: 'wait-message', surface: 'bg-surface-secondary', ink: 'text-xs text-primary', variant: 'document' },
  { id: 'review-document', surface: 'bg-surface', ink: '', variant: 'document', className: 'prose-base text-primary' },
  { id: 'chat', surface: 'bg-page', ink: 'text-primary', variant: 'assistant' },
] as const

function Fixture() {
  return (
    <div id="shot" className="bg-page p-4 grid grid-cols-2 gap-4" style={{ width: 1000 }}>
      {cases.map((c) => (
        <section key={c.id} data-case={c.id} className={`${c.surface} rounded-lg border border-th-border p-4`}>
          <div className="mb-2 text-xs font-medium text-muted">{c.id}</div>
          <div className={c.ink}>
            <MarkdownContent variant={c.variant} className={'className' in c ? c.className : undefined}>
              {sample}
            </MarkdownContent>
          </div>
        </section>
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
