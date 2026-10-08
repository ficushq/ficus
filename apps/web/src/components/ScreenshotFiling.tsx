import clsx from 'clsx'
import { useCallback, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { MAX_IMAGE_ATTACHMENT_BYTES } from '@ficus/shared'
import { uploadImages } from '../api/images'
import { screenshotsApi } from '../api/screenshots'
import { usePermissions } from '../hooks/usePermissions'
import { useGlobalImageDrop } from '../hooks/useGlobalImageDrop'
import { assistantConversationSearch } from '../lib/assistantConversationSearch'
import { filingHeadline, type FilingState } from '../lib/screenshotFiling'
import { queries } from '../queryOptions'
import { CloseIcon, ImageIcon, SpinnerIcon } from './icons'
import { SelectionPopup } from './ThemedPopup'

const NO_SQUAD = 'none'

async function readBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export interface ScreenshotFilingProps {
  dependencies?: { upload?: typeof uploadImages; api?: typeof screenshotsApi }
}

/** "Drop a screenshot anywhere": the full-window drop target, the paste target and the filing toast. */
export function ScreenshotFiling({ dependencies }: ScreenshotFilingProps) {
  const upload = dependencies?.upload ?? uploadImages
  const api = dependencies?.api ?? screenshotsApi
  const { can, isLoading } = usePermissions()
  // Filing starts an Assistant conversation (chat:send) from an image upload (agents:write).
  const enabled = !isLoading && can('chat:send') && can('agents:write')
  const [dragging, setDragging] = useState(false)
  const [state, setState] = useState<FilingState | null>(null)
  const attempt = useRef(0)

  const fileImage = useCallback(
    async (file: File) => {
      const current = ++attempt.current
      const settle = (next: FilingState) => {
        if (attempt.current === current) setState(next)
      }
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        settle({
          status: 'failed',
          message: `Screenshots can be up to ${MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
        })
        return
      }
      settle({ status: 'filing' })
      try {
        const data = await readBase64(file)
        const [imageId] = await upload([{ type: 'image', data, mimeType: file.type }])
        if (!imageId) throw new Error('Upload failed')
        const filed = await api.file(imageId)
        settle({ status: 'filed', conversationId: filed.conversationId, guess: filed.guess })
      } catch (error) {
        settle({ status: 'failed', message: error instanceof Error ? error.message : 'Something went wrong.' })
      }
    },
    [api, upload]
  )

  useGlobalImageDrop({ enabled, onImage: (file) => void fileImage(file), onDraggingChange: setDragging })

  return (
    <>
      {dragging && <ScreenshotDropOverlay />}
      {state && (
        <ScreenshotFilingToast
          state={state}
          onCorrected={(squadName) =>
            setState((current) => (current?.status === 'filed' ? { ...current, correctedTo: squadName } : current))
          }
          onDismiss={() => {
            attempt.current++
            setState(null)
          }}
          api={api}
        />
      )}
    </>
  )
}

export function ScreenshotDropOverlay() {
  return (
    <div
      data-testid="screenshot-drop-overlay"
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-page/70 p-6 backdrop-blur-sm"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center">
        <ImageIcon className="h-8 w-8 text-accent" />
        <p className="text-base font-semibold text-primary">Drop to file this screenshot</p>
        <p className="text-sm text-secondary">The Assistant guesses where it belongs and files it there.</p>
      </div>
    </div>
  )
}

export function ScreenshotFilingToast({
  state,
  onCorrected,
  onDismiss,
  api = screenshotsApi,
}: {
  state: FilingState
  onCorrected: (squadName: string) => void
  onDismiss: () => void
  api?: typeof screenshotsApi
}) {
  const location = useLocation()
  const { data: squads = [] } = useQuery({ ...queries.squads.list(), enabled: state.status === 'filed' })
  const [correcting, setCorrecting] = useState(false)
  const [correctionError, setCorrectionError] = useState<string>()
  const filed = state.status === 'filed' ? state : null
  const guessedSquadId = filed?.guess?.squad?.id ?? NO_SQUAD

  const correct = async (squadId: string) => {
    if (!filed || squadId === guessedSquadId) return
    setCorrecting(true)
    setCorrectionError(undefined)
    try {
      await api.correct({
        conversationId: filed.conversationId,
        squadId: squadId === NO_SQUAD ? null : squadId,
        clientId: crypto.randomUUID(),
      })
      onCorrected(
        squadId === NO_SQUAD ? 'no squad' : (squads.find((squad) => squad.id === squadId)?.name ?? 'that squad')
      )
    } catch (error) {
      setCorrectionError(error instanceof Error ? error.message : 'The correction was not sent.')
    } finally {
      setCorrecting(false)
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="screenshot-filing-toast"
      className="ficus-overlay fixed bottom-20 left-1/2 z-[70] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 p-3 md:bottom-6"
    >
      <div className="flex items-start gap-3">
        <span className={clsx('mt-0.5 shrink-0', state.status === 'failed' ? 'text-status-danger-600' : 'text-accent')}>
          {state.status === 'filing' ? <SpinnerIcon className="h-5 w-5" /> : <ImageIcon className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-primary">
            {state.status === 'filing'
              ? 'Filing screenshot…'
              : state.status === 'failed'
                ? "Couldn't file the screenshot"
                : filingHeadline(state)}
          </p>
          {state.status === 'failed' && <p className="mt-0.5 text-xs text-secondary">{state.message}</p>}
          {filed && (
            <p className="mt-0.5 text-xs text-secondary">
              {filed.correctedTo
                ? 'Told the Assistant where it belongs.'
                : filed.guess
                  ? 'The Assistant checks the guess and files it.'
                  : 'No guess this time; the Assistant will look at it.'}
            </p>
          )}
          {correctionError && <p className="mt-1 text-xs text-status-danger-600">{correctionError}</p>}
          {filed && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Link
                to={{
                  pathname: location.pathname,
                  search: assistantConversationSearch(location.search, filed.conversationId),
                }}
                onClick={onDismiss}
                className="ficus-button ficus-button-primary inline-flex min-h-8 items-center px-3 py-1 text-sm"
              >
                Open conversation
              </Link>
              <SelectionPopup
                label="Wrong squad?"
                heading="It belongs in"
                value={guessedSquadId}
                options={[
                  ...squads
                    .filter((squad) => squad.status !== 'archived')
                    .map((squad) => ({ value: squad.id, label: squad.name })),
                  { value: NO_SQUAD, label: 'No squad' },
                ]}
                onChange={(squadId) => void correct(squadId)}
                disabled={correcting}
                width={240}
                className="ficus-button ficus-button-secondary inline-flex min-h-8 items-center px-3 py-1 text-sm"
              >
                Wrong squad?
              </SelectionPopup>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="ficus-button ficus-button-ghost -mr-1 -mt-1 shrink-0 p-1.5 text-muted"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
