/* global localStorage, location, document, HTMLAnchorElement, history, HTMLSelectElement, Element, MutationObserver, window, URL */
// Runs in the head before paint. Keep this dependency-free: Head.astro embeds it inline.
;(() => {
  const storageKey = 'ficus-docs-mode'
  const validMode = (value) => (value === 'cloud' || value === 'self-hosted' ? value : null)
  const embedded = /^\/docs(?:\/|$)/.test(location.pathname)
  const setupMode = (pathname) => {
    if (embedded) pathname = pathname.replace(/^\/docs(?=\/|$)/, '') || '/'
    if (/^\/start\/cloud\/?$/.test(pathname)) return 'cloud'
    if (/^\/start\/self-host\/?$/.test(pathname)) return 'self-hosted'
    return null
  }
  let storedMode = null
  try {
    storedMode = validMode(localStorage.getItem(storageKey))
  } catch {
    // Reading documentation must still work when browser storage is blocked.
  }
  const pageUrl = new URL(location.href)
  let mode = setupMode(pageUrl.pathname) || validMode(pageUrl.searchParams.get('mode')) || storedMode || 'cloud'

  function syncLinks(root = document) {
    const links = [...root.querySelectorAll('a[href]')]
    if (root instanceof HTMLAnchorElement && root.hasAttribute('href')) links.push(root)
    for (const link of links) {
      const href = link.getAttribute('href')
      if (!href || link.hasAttribute('download')) continue
      const url = new URL(href, location.href)
      // Only decorate documentation routes, never assets, external sites or protocols.
      if (url.origin !== location.origin || !/^https?:$/.test(url.protocol) || /\.[^/]+$/.test(url.pathname)) continue
      if (embedded && !/^\/docs(?:\/|$)/.test(url.pathname)) continue
      const targetMode = setupMode(url.pathname) || validMode(link.dataset.docsModeLink) || mode
      url.searchParams.set('mode', targetMode)
      const nextHref = url.pathname + url.search + url.hash
      if (href !== nextHref) link.setAttribute('href', nextHref)
    }
  }

  function applyMode(nextMode) {
    mode = nextMode
    document.documentElement.dataset.docsMode = mode
    try {
      localStorage.setItem(storageKey, mode)
    } catch {
      // The URL carries the selection across navigation without storage too.
    }
    const url = new URL(location.href)
    url.searchParams.set('mode', mode)
    history.replaceState(history.state, '', url)
    document.querySelectorAll('[data-docs-mode-select]').forEach((select) => {
      select.value = mode
    })
    syncLinks()
  }

  applyMode(mode)
  function ready() {
    applyMode(mode)
    document.addEventListener('change', (event) => {
      if (!(event.target instanceof HTMLSelectElement) || !event.target.hasAttribute('data-docs-mode-select')) return
      const selectedMode = validMode(event.target.value)
      if (selectedMode) applyMode(selectedMode)
    })
    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return
      const choice = event.target.closest('a[data-docs-mode-link]')
      if (
        choice &&
        !event.defaultPrevented &&
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !choice.hasAttribute('target') &&
        !choice.hasAttribute('download')
      ) {
        const url = new URL(choice.href, location.href)
        const chosenMode = validMode(choice.dataset.docsModeLink)
        if (chosenMode && url.origin === location.origin && url.pathname === location.pathname) {
          event.preventDefault()
          applyMode(chosenMode)
          return
        }
      }
      const button = event.target.closest('[data-docs-mode-switch]')
      const selectedMode = validMode(button?.getAttribute('data-docs-mode-switch'))
      if (selectedMode) {
        const section = button.closest('[data-docs-only]')
        applyMode(selectedMode)
        // The clicked control just became hidden. Keep keyboard focus in the
        // corresponding visible variant instead of dropping it to the page body.
        const replacement = section?.parentElement?.querySelector(
          `[data-docs-only="${selectedMode}"] [data-docs-mode-switch]`
        )
        replacement?.focus()
      }
    })
    // Search results are inserted after load. Decorate their links as well, including
    // for copying/opening them in a new tab, without intercepting normal navigation.
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') syncLinks(record.target)
        for (const node of record.addedNodes) {
          if (node instanceof Element) syncLinks(node)
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true })
  else ready()
  window.addEventListener('popstate', () => {
    const url = new URL(location.href)
    applyMode(setupMode(url.pathname) || validMode(url.searchParams.get('mode')) || mode)
  })
})()
