import { useLayoutEffect, type RefObject } from 'react'
import { isKeyboardField, revealFieldInShell } from '../../hooks/useVisualViewportShell'

/** Carry the form's reading position between the regular form scroller and the whole squad page. */
export function useSquadSettingsScroll(formRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const form = formRef.current
    const page = form?.closest<HTMLElement>('.squad-detail-page')
    const shell = page?.closest<HTMLElement>('.ficus-app-shell')
    if (!form || !page || !shell) return

    const phone = window.matchMedia('(width < 48rem)')
    const wholePageScrolls = () => phone.matches && shell.dataset.keyboard === 'open'
    let wholePage = wholePageScrolls()
    let formTop = form.scrollTop
    let pageTop = page.scrollTop
    const rememberForm = () => {
      if (!wholePage) formTop = form.scrollTop
    }
    const rememberPage = () => {
      if (wholePage) pageTop = page.scrollTop
    }
    const transfer = () => {
      const next = wholePageScrolls()
      if (next === wholePage) return
      wholePage = next
      // Account for the header, squad tabs and chooser when switching the scroll origin.
      const chromeHeight = form.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop
      if (next) {
        if (formTop > 0) page.scrollTop = formTop + chromeHeight
        const field = shell.ownerDocument.activeElement
        if (isKeyboardField(field) && form.contains(field)) revealFieldInShell(field, shell)
        pageTop = page.scrollTop
      } else {
        form.scrollTop = Math.max(0, pageTop - chromeHeight)
        formTop = form.scrollTop
      }
    }
    const observer = new MutationObserver(transfer)
    observer.observe(shell, { attributes: true, attributeFilter: ['data-keyboard'] })
    phone.addEventListener('change', transfer)
    page.addEventListener('scroll', rememberPage)
    form.addEventListener('scroll', rememberForm)
    return () => {
      observer.disconnect()
      phone.removeEventListener('change', transfer)
      page.removeEventListener('scroll', rememberPage)
      form.removeEventListener('scroll', rememberForm)
    }
  }, [formRef])
}
