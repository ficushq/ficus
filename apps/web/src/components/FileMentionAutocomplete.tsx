import { useState, useEffect, useRef, useCallback, useId } from 'react'
import { searchWorkspaceFiles } from '../api/squads'
import { ComboboxList } from './popover'
import clsx from 'clsx'

interface MentionState {
  isOpen: boolean
  query: string
  startIndex: number
  endIndex: number
}

/** Unescape a file mention query: \ (backslash-space) → space. Used when searching. */
function unescapeFileMentionQuery(query: string): string {
  return query.replace(/\\ /g, ' ')
}

/** Escape a file path for insertion: space → \ (backslash-space). Supports files with spaces. */
function escapeFileMentionPath(path: string): string {
  return path.replace(/ /g, '\\ ')
}

export function useFileMention(
  squadId: string | undefined,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  inputRef: React.MutableRefObject<string>,
  setInputValue: (value: string) => void
) {
  const [mentionState, setMentionState] = useState<MentionState>({
    isOpen: false,
    query: '',
    startIndex: 0,
    endIndex: 0,
  })

  const checkForMention = useCallback(() => {
    if (!textareaRef.current || !squadId) return

    const textarea = textareaRef.current
    const cursorPos = textarea.selectionStart
    const text = inputRef.current

    // Look backwards from cursor to find @
    let atIndex = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = text[i]
      if (char === '@') {
        atIndex = i
        break
      }
      // Stop if we hit whitespace or newline before finding @
      if (char === ' ' || char === '\n' || char === '\t') break
    }

    if (atIndex !== -1) {
      const query = text.slice(atIndex + 1, cursorPos)
      // Don't trigger if space immediately follows @ (e.g. "@ " or "@  foo")
      // Spaces are allowed when escaped as \ (backslash-space)
      if (!query.startsWith(' ')) {
        setMentionState({
          isOpen: true,
          query,
          startIndex: atIndex,
          endIndex: cursorPos,
        })
        return
      }
    }

    setMentionState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev))
  }, [squadId, textareaRef, inputRef])

  const closeMention = useCallback(() => {
    setMentionState((prev) => ({ ...prev, isOpen: false }))
  }, [])

  const selectFile = useCallback(
    (filePath: string) => {
      if (!textareaRef.current) return

      const text = inputRef.current
      const escapedPath = escapeFileMentionPath(filePath)
      const newText =
        text.slice(0, mentionState.startIndex) + '@' + escapedPath + ' ' + text.slice(mentionState.endIndex)

      setInputValue(newText)

      // Update textarea value and cursor position
      textareaRef.current.value = newText
      const newCursorPos = mentionState.startIndex + escapedPath.length + 2 // +2 for @ and trailing space
      textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
      textareaRef.current.focus()

      closeMention()
    },
    [textareaRef, inputRef, setInputValue, mentionState.startIndex, mentionState.endIndex, closeMention]
  )

  return {
    mentionState,
    checkForMention,
    closeMention,
    selectFile,
  }
}

export function FileMentionAutocomplete({
  squadId,
  query,
  onSelect,
  onClose,
  textareaRef,
}: {
  squadId: string
  query: string
  onSelect: (filePath: string) => void
  onClose: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [files, setFiles] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastSearchRef = useRef<number>(0)
  const pendingQueryRef = useRef<string | null>(null)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Throttled search: run immediately if 300ms has passed, otherwise schedule
  useEffect(() => {
    const doSearch = async (searchQuery: string) => {
      setIsLoading(true)
      try {
        const result = await searchWorkspaceFiles(squadId, searchQuery)
        setFiles(result.files)
        setSelectedIndex(0)
      } catch (err) {
        console.error('Failed to search files:', err)
        setFiles([])
      } finally {
        setIsLoading(false)
      }
      lastSearchRef.current = Date.now()
      pendingQueryRef.current = null
    }

    const now = Date.now()
    const timeSinceLastSearch = now - lastSearchRef.current
    const searchQuery = unescapeFileMentionQuery(query)

    if (timeSinceLastSearch >= 300) {
      // 300ms has passed, run immediately
      doSearch(searchQuery)
    } else {
      // Schedule to run after remaining time
      pendingQueryRef.current = searchQuery
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)
      throttleTimerRef.current = setTimeout(() => {
        if (pendingQueryRef.current !== null) {
          doSearch(pendingQueryRef.current)
        }
      }, 300 - timeSinceLastSearch)
    }

    return () => {
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)
    }
  }, [squadId, query])

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, files.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (files.length > 0) {
          e.preventDefault()
          onSelect(files[selectedIndex])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [files, selectedIndex, onSelect, onClose])

  // Scroll selected item into view
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const selected = container.querySelector('[data-selected="true"]')
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // A combobox list above the composer: focus stays in the composer, whose key handler (above) owns
  // the arrows, Enter/Tab and Escape. A press outside closes it (the composer included: the caret moves).
  const listId = useId()
  const empty = files.length === 0 && !isLoading
  return (
    <ComboboxList
      ref={containerRef}
      open
      onDismiss={onClose}
      input={textareaRef}
      listId={listId}
      activeId={files.length ? `${listId}-${selectedIndex}` : undefined}
      maxHeight={300}
      scroll={false}
      className={clsx(
        'ficus-overlay bg-surface border border-th-border rounded-lg shadow-lg',
        empty ? 'p-3 text-sm text-muted' : 'overflow-hidden'
      )}
      style={empty ? { minWidth: 200, maxWidth: 400 } : { minWidth: 300, maxWidth: 500 }}
    >
      {empty ? (
        query ? (
          'No files found'
        ) : (
          'Type to search files...'
        )
      ) : (
        <>
          <div className="px-3 py-2 border-b border-th-border">
            <span className={clsx('text-xs font-medium text-muted', isLoading && 'motion-safe:animate-pulse')}>
              Files
            </span>
          </div>
          <div id={listId} role="listbox" aria-label="Files" className="overflow-y-auto max-h-[250px]">
            {files.map((file, index) => (
              <button
                key={file}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selectedIndex}
                data-selected={index === selectedIndex}
                onClick={() => onSelect(file)}
                className={clsx(
                  'ficus-button',
                  'w-full text-left px-3 py-2 text-sm font-mono truncate transition-colors',
                  index === selectedIndex ? 'bg-accent/10 text-accent-light' : 'text-primary hover:bg-surface-hover'
                )}
              >
                @{file}
              </button>
            ))}
          </div>
          <div className="px-3 py-1.5 border-t border-th-border bg-surface-secondary text-xs text-muted">
            ↑↓ navigate • Enter/Tab select • Esc close • Use <code className="px-0.5">\ </code> for spaces in filenames
          </div>
        </>
      )}
    </ComboboxList>
  )
}
