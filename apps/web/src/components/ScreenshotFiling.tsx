import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  SCREENSHOT_ACTIONS,
  SCREENSHOT_KINDS,
  type ScreenshotAction,
  type ScreenshotKind,
  type ScreenshotWorkStreamOption,
} from '@ficus/shared'
import { uploadImages } from '../api/images'
import { screenshotsApi } from '../api/screenshots'
import { usePermissions } from '../hooks/usePermissions'
import { useGlobalImageDrop } from '../hooks/useGlobalImageDrop'
import { useStableRef } from '../hooks/useStableRef'
import { assistantConversationSearch } from '../lib/assistantConversationSearch'
import {
  INITIAL_REVIEW,
  NO_SQUAD,
  fileScreenshotRequest,
  picksWorkStream,
  reviewReducer,
  unsureFields,
  type ReviewEvent,
  type ReviewState,
} from '../lib/screenshotFiling'
import { queries } from '../queryOptions'
import { Badge } from './Badge'
import { ChevronDownIcon, ImageIcon, SpinnerIcon } from './icons'
import { SkeletonBlock } from './loading/Skeleton'
import { SelectionPopup, type PopupOption } from './ThemedPopup'

async function readBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

const NO_WORK_STREAMS: readonly ScreenshotWorkStreamOption[] = []
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message) || fallback
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A dropped screenshot under review: nothing is filed until the user confirms it. */
export interface ScreenshotReview {
  id: number
  file: File
  /** An object URL for the thumbnail, revoked when the card closes. */
  preview: string
  upload: { status: 'uploading' } | { status: 'failed'; message: string } | { status: 'done'; imageId: string }
  filing: { status: 'idle' } | { status: 'filing' } | { status: 'failed'; message: string }
  review: ReviewState
  /** Another image was dropped while this card was open; it was ignored, and the card says so. */
  crowded: boolean
}

/** An image that cannot be filed at all (too large): only a message to dismiss. */
interface RejectedScreenshot {
  id: number
  rejected: string
}

type Card = ScreenshotReview | RejectedScreenshot
const isReview = (card: Card | null): card is ScreenshotReview => Boolean(card && 'file' in card)

export interface ScreenshotFilingProps {
  dependencies?: { upload?: typeof uploadImages; api?: Pick<typeof screenshotsApi, 'guess' | 'file'> }
}

/**
 * "Drop a screenshot anywhere": the full-window drop target, the paste target and the review card.
 * A dropped image is uploaded and guessed at, but only "File it" creates the Assistant conversation.
 */
export function ScreenshotFiling({ dependencies }: ScreenshotFilingProps) {
  const upload = dependencies?.upload ?? uploadImages
  const api = dependencies?.api ?? screenshotsApi
  const { can, isLoading } = usePermissions()
  // Filing starts an Assistant conversation (chat:send) from an image upload (agents:write).
  const enabled = !isLoading && can('chat:send') && can('agents:write')
  const navigate = useNavigate()
  const location = useStableRef(useLocation())
  const [dragging, setDragging] = useState(false)
  const [card, setCard] = useState<Card | null>(null)
  const open = useStableRef(card)
  const nextId = useRef(0)

  /** Change the review with this id, if it is still the open card. */
  const patch = useCallback(
    (id: number, change: (review: ScreenshotReview) => ScreenshotReview) =>
      setCard((current) => (isReview(current) && current.id === id ? change(current) : current)),
    []
  )

  const uploadAndGuess = useCallback(
    async (id: number, file: File) => {
      patch(id, (review) => ({ ...review, upload: { status: 'uploading' } }))
      let imageId: string | undefined
      try {
        ;[imageId] = await upload([{ type: 'image', data: await readBase64(file), mimeType: file.type }])
        if (!imageId) throw new Error('Upload failed')
      } catch (error) {
        const message = messageOf(error, 'Something went wrong.')
        patch(id, (review) => ({ ...review, upload: { status: 'failed', message } }))
        return
      }
      const uploaded = imageId
      patch(id, (review) => ({ ...review, upload: { status: 'done', imageId: uploaded } }))
      // Filing never depends on the guess: without one the pickers are simply left unselected.
      const guess = await api.guess(uploaded).then(
        (response) => response.guess,
        () => null
      )
      patch(id, (review) => ({ ...review, review: reviewReducer(review.review, { type: 'guessed', guess }) }))
    },
    [api, patch, upload]
  )

  const onImage = (file: File) => {
    const current = open.current
    // A second drop never replaces a screenshot under review (its note would be lost): it is ignored, visibly.
    if (isReview(current)) return patch(current.id, (review) => ({ ...review, crowded: true }))
    const id = ++nextId.current
    if (file.size > MAX_IMAGE_ATTACHMENT_BYTES)
      return setCard({ id, rejected: `Screenshots can be up to ${MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024} MB.` })
    setCard({
      id,
      file,
      preview: URL.createObjectURL(file),
      upload: { status: 'uploading' },
      filing: { status: 'idle' },
      review: INITIAL_REVIEW,
      crowded: false,
    })
    void uploadAndGuess(id, file)
  }

  const close = useCallback(() => {
    const current = open.current
    if (isReview(current)) URL.revokeObjectURL(current.preview)
    setCard(null)
  }, [open])
  useEffect(() => close, [close])

  const confirm = async () => {
    const current = open.current
    if (!isReview(current) || current.upload.status !== 'done' || current.filing.status === 'filing') return
    patch(current.id, (review) => ({ ...review, filing: { status: 'filing' } }))
    try {
      const filed = await api.file(fileScreenshotRequest(current.upload.imageId, current.review))
      close()
      navigate({
        pathname: location.current.pathname,
        search: assistantConversationSearch(location.current.search, filed.conversationId),
      })
    } catch (error) {
      // The note and the choices stay on the card for another try.
      const message = messageOf(error, 'Something went wrong.')
      patch(current.id, (review) => ({ ...review, filing: { status: 'failed', message } }))
    }
  }

  useGlobalImageDrop({ enabled, onImage, onDraggingChange: setDragging })

  return (
    <>
      {dragging && <ScreenshotDropOverlay reviewing={isReview(card)} />}
      {card && (
        <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex justify-center px-4 md:bottom-6">
          {isReview(card) ? (
            <ScreenshotReviewCard
              key={card.id}
              card={card}
              onEvent={(event) =>
                patch(card.id, (review) => {
                  const next = reviewReducer(review.review, event)
                  return next === review.review ? review : { ...review, review: next }
                })
              }
              onRetryUpload={() => void uploadAndGuess(card.id, card.file)}
              onConfirm={() => void confirm()}
              onDismiss={close}
            />
          ) : (
            <div
              role="status"
              aria-live="polite"
              data-testid="screenshot-rejected"
              className="ficus-overlay pointer-events-auto flex w-full max-w-md items-start gap-3 p-3"
            >
              <ImageIcon className="mt-0.5 h-5 w-5 shrink-0 text-status-danger-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-primary">Couldn't file the screenshot</p>
                <p className="mt-0.5 text-xs text-secondary">{card.rejected}</p>
              </div>
              <button type="button" onClick={close} className="ficus-button ficus-button-link shrink-0 text-sm">
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

export function ScreenshotDropOverlay({ reviewing = false }: { reviewing?: boolean }) {
  return (
    <div
      data-testid="screenshot-drop-overlay"
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-page/70 p-6 backdrop-blur-sm"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center">
        <ImageIcon className="h-8 w-8 text-accent" />
        <p className="text-base font-semibold text-primary">
          {reviewing ? 'Finish the open screenshot first' : 'Drop to file this screenshot'}
        </p>
        <p className="text-sm text-secondary">
          {reviewing
            ? 'File or dismiss it, then drop this one.'
            : 'You check the guess and add a note before anything is filed.'}
        </p>
      </div>
    </div>
  )
}

const PICKER_CLASS =
  'ficus-field flex min-h-8 w-full min-w-0 items-center justify-between gap-2 px-2.5 py-1 text-left text-sm'

const KIND_OPTIONS: PopupOption<ScreenshotKind>[] = (Object.keys(SCREENSHOT_KINDS) as ScreenshotKind[]).map((kind) => ({
  value: kind,
  label: sentence(SCREENSHOT_KINDS[kind].label),
  description: SCREENSHOT_KINDS[kind].description,
}))

/** One row of the card: its name, its picker (a skeleton while the guess loads) and the "not sure" mark. */
function ReviewField({
  name,
  loading,
  unsure,
  children,
}: {
  name: string
  loading: boolean
  unsure?: boolean
  children: ReactNode
}) {
  return (
    <>
      <span className="text-xs font-medium text-secondary">{name}</span>
      <div className="flex min-w-0 items-center gap-2">
        {loading ? <SkeletonBlock className="h-8 w-full" /> : <div className="min-w-0 flex-1">{children}</div>}
        {unsure && !loading && (
          <Badge
            color="attention"
            className="shrink-0"
            title="The guess was not confident about this one. Check it before filing."
          >
            not sure
          </Badge>
        )}
      </div>
    </>
  )
}

function PickerValue({ chosen, placeholder }: { chosen: string | undefined; placeholder: string }) {
  return (
    <>
      <span className={clsx('min-w-0 truncate', !chosen && 'text-muted')}>{chosen ?? placeholder}</span>
      <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted" />
    </>
  )
}

/**
 * The review card, where the filing toast used to be: the thumbnail, a note, and the guess as
 * editable pickers. It is not a popup: it stays until the user files or dismisses it, so a click
 * elsewhere (or a look at the page behind it) never loses the note.
 */
export function ScreenshotReviewCard({
  card,
  onEvent,
  onRetryUpload,
  onConfirm,
  onDismiss,
}: {
  card: ScreenshotReview
  onEvent: (event: ReviewEvent) => void
  onRetryUpload: () => void
  onConfirm: () => void
  onDismiss: () => void
}) {
  const { upload, filing, review } = card
  const { choices, guess } = review
  const filingNow = filing.status === 'filing'
  const guessing = guess === undefined && upload.status !== 'failed'
  const unsure = unsureFields(review)

  const note = useRef<HTMLTextAreaElement>(null)
  // The note takes focus as the card opens, so the user can type while the guess loads.
  useEffect(() => note.current?.focus({ preventScroll: true }), [])

  const { data: squads = [] } = useQuery(queries.squads.list())
  const squadOptions: PopupOption<string>[] = [
    ...squads.filter((squad) => squad.status !== 'archived').map((squad) => ({ value: squad.id, label: squad.name })),
    { value: NO_SQUAD, label: 'No squad' },
  ]
  const squadName =
    choices.squad === NO_SQUAD
      ? 'No squad'
      : (squadOptions.find((option) => option.value === choices.squad)?.label ??
        (guess?.squad?.id === choices.squad ? guess?.squad?.name : undefined))

  const squadId = choices.squad && choices.squad !== NO_SQUAD ? choices.squad : null
  const streams = useQuery({ ...queries.screenshots.workStreams(squadId ?? ''), enabled: squadId !== null })
  // A squad whose work streams cannot be read has none to offer.
  const workStreams = squadId === null || streams.isError ? NO_WORK_STREAMS : streams.data?.workStreams
  const onEventRef = useStableRef(onEvent)
  useEffect(() => {
    if (squadId && workStreams) onEventRef.current({ type: 'workStreams', squad: squadId, workStreams })
  }, [onEventRef, squadId, workStreams])

  const noStreams = choices.squad === NO_SQUAD || (squadId !== null && workStreams?.length === 0)
  const actionOptions: PopupOption<ScreenshotAction>[] = (Object.keys(SCREENSHOT_ACTIONS) as ScreenshotAction[]).map(
    (action) => {
      const unavailable = action === 'existing_work_stream' && noStreams
      return {
        value: action,
        label: sentence(SCREENSHOT_ACTIONS[action].label),
        description: unavailable
          ? choices.squad === NO_SQUAD
            ? 'Pick a squad first.'
            : 'This squad has no open work streams.'
          : SCREENSHOT_ACTIONS[action].description,
        disabled: unavailable,
      }
    }
  )

  const status = filingNow
    ? 'Filing…'
    : upload.status === 'uploading'
      ? 'Uploading…'
      : upload.status === 'failed'
        ? null
        : guessing
          ? 'Guessing what it is and where it belongs…'
          : guess
            ? 'Check the guess, add a note, then file it.'
            : 'No guess this time. Pick what you know, or just add a note.'

  return (
    <form
      aria-label="File screenshot"
      data-testid="screenshot-review-card"
      className="ficus-overlay pointer-events-auto max-h-[calc(100dvh-7rem)] w-full max-w-md overflow-y-auto p-3"
      onSubmit={(event) => {
        event.preventDefault()
        onConfirm()
      }}
    >
      <div className="flex items-start gap-3">
        <img
          src={card.preview}
          alt="The screenshot being filed"
          className="h-16 w-16 shrink-0 rounded-md border border-th-border bg-surface-secondary object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-primary">File this screenshot</p>
          {status && (
            <p role="status" aria-live="polite" className="mt-0.5 flex items-center gap-1.5 text-xs text-secondary">
              {(guessing || filingNow) && <SpinnerIcon className="h-3.5 w-3.5 shrink-0" />}
              {status}
            </p>
          )}
          {upload.status === 'failed' && (
            <p role="alert" className="mt-0.5 text-xs text-status-danger-600">
              Couldn't upload the screenshot: {upload.message}{' '}
              <button type="button" onClick={onRetryUpload} className="ficus-button ficus-button-link text-xs">
                Retry
              </button>
            </p>
          )}
        </div>
      </div>

      <textarea
        ref={note}
        aria-label="Note for the Assistant"
        placeholder="Add a note: what is this, what caused it, what should happen?"
        rows={2}
        maxLength={2000}
        value={review.note}
        disabled={filingNow}
        onChange={(event) => onEvent({ type: 'note', note: event.target.value })}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
          event.preventDefault()
          onConfirm()
        }}
        className="ficus-field mt-3 block max-h-40 min-h-[3.25rem] w-full resize-y px-2.5 py-1.5 text-sm"
      />

      {upload.status !== 'failed' && (
        <div className="mt-3 grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <ReviewField name="Kind" loading={guessing} unsure={unsure.includes('kind')}>
            <SelectionPopup
              label={`Kind: ${choices.kind ? sentence(SCREENSHOT_KINDS[choices.kind].label) : 'not chosen'}`}
              value={choices.kind ?? ''}
              options={KIND_OPTIONS}
              onChange={(kind) => kind && onEvent({ type: 'kind', kind })}
              disabled={filingNow}
              width={320}
              className={PICKER_CLASS}
            >
              <PickerValue
                chosen={choices.kind ? sentence(SCREENSHOT_KINDS[choices.kind].label) : undefined}
                placeholder="Choose what it is"
              />
            </SelectionPopup>
          </ReviewField>
          <ReviewField name="Squad" loading={guessing} unsure={unsure.includes('squad')}>
            <SelectionPopup
              label={`Squad: ${squadName ?? 'not chosen'}`}
              value={choices.squad ?? ''}
              options={squadOptions}
              onChange={(squad) => squad && onEvent({ type: 'squad', squad })}
              disabled={filingNow}
              width={320}
              className={PICKER_CLASS}
            >
              <PickerValue chosen={squadName} placeholder="Choose a squad" />
            </SelectionPopup>
          </ReviewField>
          <ReviewField name="Action" loading={guessing} unsure={unsure.includes('action')}>
            <SelectionPopup
              label={`Action: ${choices.action ? sentence(SCREENSHOT_ACTIONS[choices.action].label) : 'not chosen'}`}
              value={choices.action ?? ''}
              options={actionOptions}
              onChange={(action) => action && onEvent({ type: 'action', action })}
              disabled={filingNow}
              width={320}
              className={PICKER_CLASS}
            >
              <PickerValue
                chosen={choices.action ? sentence(SCREENSHOT_ACTIONS[choices.action].label) : undefined}
                placeholder="Choose what to do"
              />
            </SelectionPopup>
          </ReviewField>
          {!guessing && choices.action === 'existing_work_stream' && !picksWorkStream(choices) && (
            <p className="col-start-2 text-xs text-secondary">Choose a squad to pick one of its work streams.</p>
          )}
          {!guessing && picksWorkStream(choices) && (
            <ReviewField name="Work stream" loading={workStreams === undefined} unsure={unsure.includes('workStream')}>
              <SelectionPopup
                label={`Work stream: ${workStreams?.find((stream) => stream.id === choices.workStreamId)?.title ?? 'not chosen'}`}
                value={choices.workStreamId ?? ''}
                options={(workStreams ?? []).map((stream) => ({ value: stream.id, label: stream.title }))}
                onChange={(workStreamId) => workStreamId && onEvent({ type: 'workStream', workStreamId })}
                disabled={filingNow}
                width={320}
                className={PICKER_CLASS}
              >
                <PickerValue
                  chosen={workStreams?.find((stream) => stream.id === choices.workStreamId)?.title}
                  placeholder="Choose a work stream"
                />
              </SelectionPopup>
            </ReviewField>
          )}
        </div>
      )}

      {filing.status === 'failed' && (
        <p role="alert" className="mt-3 text-xs text-status-danger-600">
          Couldn't file the screenshot: {filing.message} Your note and choices are still here.
        </p>
      )}
      {card.crowded && (
        <p role="status" className="mt-3 text-xs text-secondary">
          That image was not added. File or dismiss this screenshot first, then drop it again.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <p className="w-full text-xs text-muted sm:mr-auto sm:w-auto">Nothing is sent until you file it.</p>
        <button
          type="button"
          onClick={onDismiss}
          disabled={filingNow}
          className="ficus-button ficus-button-secondary inline-flex min-h-8 items-center px-3 py-1 text-sm"
        >
          Dismiss
        </button>
        <button
          type="submit"
          disabled={upload.status !== 'done' || filingNow}
          title="File it (Ctrl or ⌘ + Enter)"
          className="ficus-button ficus-button-primary inline-flex min-h-8 items-center px-3 py-1 text-sm"
        >
          {filing.status === 'failed' ? 'Try again' : 'File it'}
        </button>
      </div>
    </form>
  )
}
