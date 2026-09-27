import { Presence } from '../Presence'
import { matchesSetting, settingMatchRank, SETTINGS_PAGE_KEYWORDS, SETTINGS_SEARCH_ENTRIES } from './settingsSearch'
import clsx from 'clsx'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDownIcon, SettingsIcon } from '../icons'
import { SETTINGS_SECTION_ICONS as icons } from './settingsIcons'

export interface SettingsSectionGroup {
  label?: string
  items: readonly { id: string; label: string }[]
}

const PERSONAL_SECTIONS = new Set(['general', 'notifications', 'app', 'appearance', 'account', 'sessions', 'devices'])

export function SettingsNavigation({
  groups,
  activeSection,
  onSectionChange,
  showOnboardingLink,
  scopeTitle,
  pageKeywords = SETTINGS_PAGE_KEYWORDS,
  searchEntries = SETTINGS_SEARCH_ENTRIES,
}: {
  groups: readonly SettingsSectionGroup[]
  activeSection: string
  onSectionChange: (section: string, target?: string) => void
  showOnboardingLink: boolean
  scopeTitle?: string
  pageKeywords?: Record<string, string>
  searchEntries?: typeof SETTINGS_SEARCH_ENTRIES
}) {
  const mobileRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [search, setSearch] = useState('')
  const searchId = useId()
  const [selection, setSelection] = useState({ key: '', index: 0 })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileMaxHeight, setMobileMaxHeight] = useState(0)
  useLayoutEffect(() => {
    if (!mobileOpen) return
    const chooser = mobileRef.current
    const bounds = chooser?.parentElement
    if (!chooser || !bounds) return
    const viewport = window.visualViewport
    const updateHeight = () => {
      // The settings region ends above the dock, including its PWA safe area.
      // A viewport-only cap can extend beyond that region and get clipped.
      const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight
      const bottom = Math.min(bounds.getBoundingClientRect().bottom, viewportBottom)
      setMobileMaxHeight(Math.max(0, bottom - chooser.getBoundingClientRect().bottom - 16))
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(bounds)
    observer.observe(chooser)
    window.addEventListener('resize', updateHeight)
    window.addEventListener('scroll', updateHeight, true)
    viewport?.addEventListener('resize', updateHeight)
    viewport?.addEventListener('scroll', updateHeight)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateHeight)
      window.removeEventListener('scroll', updateHeight, true)
      viewport?.removeEventListener('resize', updateHeight)
      viewport?.removeEventListener('scroll', updateHeight)
    }
  }, [mobileOpen])
  useEffect(() => {
    if (!mobileOpen) return
    mobileRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !mobileRef.current?.contains(event.target)) setMobileOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setMobileOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape, true)
    }
  }, [mobileOpen])
  const sections = groups.flatMap((group) => group.items)
  const inAdministration = !scopeTitle && !PERSONAL_SECTIONS.has(activeSection)
  const personal = sections.filter((section) => PERSONAL_SECTIONS.has(section.id))
  const administration = groups
    .map((group) => ({ ...group, items: group.items.filter((section) => !PERSONAL_SECTIONS.has(section.id)) }))
    .filter((group) => group.items.length)
  const hasAdministration = administration.length > 0 || showOnboardingLink
  const areaGroups = scopeTitle || search.trim() ? groups : inAdministration ? administration : [{ items: personal }]
  const matchingGroups = areaGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((section) =>
        `${section.label} ${group.label ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())
      ),
    }))
    .filter((group) => group.items.length)
  const results = search.trim()
    ? sections
        .flatMap((section) => {
          const area = scopeTitle ?? (PERSONAL_SECTIONS.has(section.id) ? 'Personal' : 'Administration')
          const group = groups.find((group) => group.items.some((item) => item.id === section.id))?.label ?? ''
          const page = matchesSetting(search, section.label, group, pageKeywords[section.id] ?? '')
            ? [{ section: section.id, id: '', label: section.label, breadcrumb: area }]
            : []
          return [
            ...page,
            ...searchEntries
              .filter(
                (entry) =>
                  entry.section === section.id && matchesSetting(search, entry.label, entry.keywords, section.label)
              )
              .map((entry) => ({ ...entry, breadcrumb: `${area} → ${section.label}` })),
          ]
        })
        .sort(
          (a, b) =>
            settingMatchRank(search, a.label) - settingMatchRank(search, b.label) ||
            Number(Boolean(a.id)) - Number(Boolean(b.id))
        )
    : []
  const activeLabel = sections.find((section) => section.id === activeSection)?.label ?? 'Settings'
  const select = (id: string, target?: string) => {
    onSectionChange(id, target)
    setMobileOpen(false)
    setSearch('')
  }
  const selectArea = (id: string) => {
    onSectionChange(id)
    setSearch('')
  }
  const showSetupResult = showOnboardingLink && !!search.trim() && matchesSetting(search, 'Set up Tau onboarding setup')
  const resultCount = results.length + Number(showSetupResult)
  const resultKey = JSON.stringify([search, results.map((result) => [result.section, result.id]), showSetupResult])
  const selectedIndex = selection.key === resultKey ? Math.min(selection.index, resultCount - 1) : 0
  const content = (surface: string) => (
    <div
      className="contents"
      onKeyDown={(event) => {
        if (!search.trim() || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
        const target = event.target as HTMLElement
        if (target.tagName !== 'INPUT' && !target.closest('[data-settings-result]')) return
        if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
        if (event.key === 'Enter' && target.tagName !== 'INPUT') return
        event.preventDefault()
        event.stopPropagation()
        if (!resultCount) return
        const rows = event.currentTarget.querySelectorAll<HTMLElement>('[data-settings-result]')
        if (event.key === 'Enter') {
          rows[selectedIndex]?.click()
          return
        }
        const index = (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + resultCount) % resultCount
        setSelection({ key: resultKey, index })
        event.currentTarget.querySelector('input')?.focus()
        rows[index]?.scrollIntoView?.({ block: 'nearest' })
      }}
    >
      {!scopeTitle && (
        <div className="mb-4 flex items-center gap-1 rounded-lg bg-surface-secondary p-1" aria-label="Settings areas">
          <button
            type="button"
            aria-pressed={!inAdministration}
            onClick={() => selectArea(personal[0]?.id ?? 'account')}
            className={clsx(
              'ficus-button flex-1 rounded-md px-2 py-2 text-xs',
              !inAdministration ? 'bg-surface text-primary' : 'text-secondary hover:text-primary'
            )}
          >
            Personal
          </button>
          {hasAdministration && (
            <button
              type="button"
              aria-pressed={inAdministration}
              onClick={() => {
                if (administration[0]?.items[0]) selectArea(administration[0].items[0].id)
              }}
              className={clsx(
                'ficus-button flex-1 rounded-md px-2 py-2 text-xs',
                inAdministration ? 'bg-surface text-primary' : 'text-secondary hover:text-primary'
              )}
            >
              Administration
            </button>
          )}
        </div>
      )}
      <input
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!!search.trim()}
        aria-controls={`${searchId}-${surface}-results`}
        aria-activedescendant={
          search.trim() && resultCount ? `${searchId}-${surface}-result-${selectedIndex}` : undefined
        }
        aria-label="Search settings"
        placeholder="Find a setting…"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value)
          setSelection({ key: '', index: 0 })
        }}
        className="ficus-field mb-4 h-9 w-full px-3 text-base md:text-sm"
      />
      <nav
        id={`${searchId}-${surface}-results`}
        role={search.trim() ? 'listbox' : undefined}
        aria-label={
          search
            ? 'Settings search results'
            : scopeTitle
              ? `${scopeTitle} sections`
              : inAdministration
                ? 'Administration sections'
                : 'Personal settings sections'
        }
        className="space-y-5"
      >
        {search.trim() ? (
          <div className="space-y-1">
            {results.map((result, index) => (
              <button
                key={`${result.section}:${result.id}`}
                id={`${searchId}-${surface}-result-${index}`}
                role="option"
                aria-selected={selectedIndex === index}
                data-settings-result
                onMouseEnter={() => setSelection({ key: resultKey, index })}
                onFocus={() => setSelection({ key: resultKey, index })}
                type="button"
                onClick={() => select(result.section, result.id || undefined)}
                className={clsx(
                  'ficus-button ficus-nav-item block w-full px-2.5 py-2.5 text-left',
                  selectedIndex === index && 'bg-accent/10 text-accent'
                )}
              >
                <span className="block text-sm text-primary">{result.label}</span>
                <span className="mt-1 block text-xs text-secondary">{result.breadcrumb}</span>
              </button>
            ))}
            {resultCount === 0 && (
              <p role="status" className="px-2 text-sm text-secondary">
                No settings match your search.
              </p>
            )}
          </div>
        ) : (
          matchingGroups.map((group, i) => (
            <div key={group.label ?? i}>
              {group.label && (scopeTitle || inAdministration || search) && (
                <h3 className="ficus-section-title px-2 pb-2">{group.label}</h3>
              )}
              <div className="space-y-1">
                {group.items.map((section) => {
                  const Icon = icons[section.id as keyof typeof icons] ?? SettingsIcon
                  return (
                    <button
                      type="button"
                      key={section.id}
                      aria-current={activeSection === section.id ? 'page' : undefined}
                      onClick={() => select(section.id)}
                      className="ficus-button ficus-nav-item flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-sm text-secondary"
                    >
                      <Icon className="h-4 w-4 shrink-0 opacity-80" />
                      <span>{section.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))
        )}
        {!search.trim() && matchingGroups.length === 0 && (
          <p role="status" className="px-2 text-sm text-secondary">
            No settings match your search.
          </p>
        )}
        {showOnboardingLink &&
          (search.trim() ? matchesSetting(search, 'Set up Tau onboarding setup') : inAdministration) && (
            <Link
              to="/onboarding"
              id={`${searchId}-${surface}-result-${results.length}`}
              role={search.trim() ? 'option' : undefined}
              aria-selected={search.trim() ? selectedIndex === results.length : undefined}
              data-settings-result={search.trim() ? '' : undefined}
              onMouseEnter={() => setSelection({ key: resultKey, index: results.length })}
              onFocus={() => setSelection({ key: resultKey, index: results.length })}
              className={clsx(
                'ficus-nav-item flex items-center gap-2.5 px-2.5 py-2 text-sm text-secondary',
                search.trim() && selectedIndex === results.length && 'bg-accent/10 text-accent'
              )}
            >
              <SettingsIcon className="h-4 w-4" />
              Set up Tau
            </Link>
          )}
      </nav>
    </div>
  )
  return (
    <>
      <div ref={mobileRef} className="relative shrink-0 md:hidden">
        <button
          type="button"
          ref={triggerRef}
          aria-label="Choose settings section"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((open) => !open)}
          className="ficus-panel flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <span>
            <span className="block text-xs text-secondary">{scopeTitle ?? 'Settings'}</span>
            <span className="text-sm font-medium text-primary">{activeLabel}</span>
          </span>
          <ChevronDownIcon className={clsx('h-4 w-4 text-secondary', mobileOpen && 'rotate-180')} />
        </button>
        <Presence
          open={mobileOpen}
          style={{ maxHeight: `min(60dvh, ${mobileMaxHeight}px)` }}
          className="ficus-overlay absolute left-0 right-0 top-full z-30 mt-2 overflow-y-auto overscroll-contain p-3"
        >
          {content('mobile')}
        </Presence>
      </div>
      <aside className="ficus-panel ficus-glass hidden md:block w-60 flex-shrink-0 h-full overflow-y-auto p-3">
        <h2 className="px-2 pb-4 pt-1 text-sm font-semibold text-primary">{scopeTitle ?? 'Settings'}</h2>
        {content('desktop')}
      </aside>
    </>
  )
}
