import { pageEditorToolRenderers } from './pageEditorToolRenderers'
import { summarizeAssistantError } from '../voice/assistantErrorPresentation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  assistantEditorReadResult,
  assistantEditorContext,
  type AssistantEditorSync,
  type AssistantEditorProposal,
  type assistantEditorToolDefinitions,
} from '@ficus/shared'
import { assistantApi } from '../api/assistant'
import { assistantQueries } from '../queryOptions'
import { useStableRef } from '../hooks/useStableRef'
import { usePermissions } from '../hooks/usePermissions'
import { useRealtimeEnabled } from '../hooks/useVoiceEnabled'
import type { PageEditorBridge } from '../voice/AssistantConversationContext'
import { AssistantConversationView, type AssistantViewControls } from './AssistantConversationView'
import { MicIcon } from './icons'

/** Reusable conversation surface. The page owns its draft; server adapters own
 * authorization and proposals. The host supplies its page kind's title, help
 * copy, conversation title, and model-facing instructions/tools (see
 * `assistantEditorInstructionsByKind` / `assistantEditorToolDefinitionsByKind`
 * in `@ficus/shared`) so this component stays kind-agnostic. */
export function PageEditorAssistant({
  draft,
  onProposal,
  conversationDependencies,
  title,
  subtitle,
  conversationTitle,
  instructions,
  tools,
}: {
  draft: AssistantEditorSync
  onProposal: (proposal: AssistantEditorProposal) => AssistantEditorSync | undefined
  conversationDependencies?: Parameters<typeof AssistantConversationView>[0]['dependencies']
  /** Header heading, e.g. "What flow do you want?" or "What would you like to change?". */
  title: string
  /** Header help text under the title. */
  subtitle: string
  /** Title used when lazily creating the underlying conversation record. */
  conversationTitle: string
  /** This page kind's model-facing instructions (`assistantEditorInstructionsByKind[kind]`). */
  instructions: string
  /** This page kind's tool definitions (`assistantEditorToolDefinitionsByKind[kind]`). */
  tools: typeof assistantEditorToolDefinitions
}) {
  const [id] = useState(() => crypto.randomUUID())
  const [ready, setReady] = useState(false)
  const [syncError, setSyncError] = useState<string>()
  const [controls, setControls] = useState<AssistantViewControls>()
  const realtime = useRealtimeEnabled()
  const { can } = usePermissions()
  const draftRef = useStableRef(draft)
  const proposalRef = useStableRef(onProposal)
  const create = useRef<Promise<unknown> | null>(null)
  const writes = useRef<Promise<unknown>>(Promise.resolve())
  const confirmedDraft = useRef<AssistantEditorSync | undefined>(undefined)
  const lastSync = useRef<string | undefined>(undefined)
  const pendingAcknowledgement = useRef<string | undefined>(undefined)
  const sync = useCallback(
    async (applied?: AssistantEditorSync) => {
      const operation = writes.current
        .catch(() => {})
        .then(async () => {
          create.current ??= assistantApi.create(id, conversationTitle, 'page-editor').catch((error) => {
            create.current = null
            throw error
          })
          await create.current
          const candidate = applied && applied.revision >= draftRef.current.revision ? applied : draftRef.current
          // A second tool call can arrive before React commits the first edit's props.
          const latest =
            confirmedDraft.current && confirmedDraft.current.revision > candidate.revision
              ? confirmedDraft.current
              : candidate
          const acknowledgement = applied?.acknowledgedProposalId ?? pendingAcknowledgement.current
          const value = acknowledgement ? { ...latest, acknowledgedProposalId: acknowledgement } : latest
          const key = JSON.stringify(value)
          if (lastSync.current !== key) {
            await assistantApi.syncEditor(id, value)
            confirmedDraft.current = value
            lastSync.current = key
            if (pendingAcknowledgement.current === acknowledgement) pendingAcknowledgement.current = undefined
          }
          setReady(true)
          setSyncError(undefined)
          return value
        })
      writes.current = operation
      try {
        return await operation
      } catch (error) {
        setSyncError(error instanceof Error ? error.message : 'Could not sync the draft')
        throw error
      }
    },
    [id, draftRef, conversationTitle]
  )
  useEffect(() => {
    void sync().catch(() => {})
  }, [draft, sync])
  const lifetime = useRef({ generation: 0 })
  useEffect(() => {
    const life = lifetime.current
    const generation = ++life.generation
    return () => {
      // StrictMode replays mount effects. Only close when this mount was not replaced.
      void writes.current
        .catch(() => {})
        .then(() => {
          if (life.generation === generation) return assistantApi.closeEditor(id)
        })
        .catch(() => {})
    }
  }, [id])
  const result = useQuery({ ...assistantQueries.editor(id), enabled: ready, refetchInterval: 1500 })
  const delivery = useRef<{ id: string; result: Promise<AssistantEditorSync | undefined> } | undefined>(undefined)
  const apply = useCallback(
    (proposal: AssistantEditorProposal) => {
      if (delivery.current?.id === proposal.id) return delivery.current.result
      const result = (async () => {
        const applied = proposalRef.current(proposal)
        if (!applied) return undefined
        pendingAcknowledgement.current = proposal.id
        return await sync({ ...applied, acknowledgedProposalId: proposal.id })
      })()
      delivery.current = { id: proposal.id, result }
      return result
    },
    [proposalRef, sync]
  )
  useEffect(() => {
    const proposal = result.data?.proposal
    if (proposal) void apply(proposal).catch(() => {})
  }, [result.data, apply])
  const bridge = useMemo<PageEditorBridge>(
    () => ({
      prepare: async () => {
        await sync()
      },
      context: assistantEditorContext(draft),
      getContext: () => assistantEditorContext(draftRef.current),
      instructions:
        instructions +
        ' For complex designs you may delegate with delegate. The user assistant has the same draft tools and its edits appear here automatically.',
      tools,
      execute: async (name, args) => {
        try {
          await sync()
          if (name === 'read')
            return { result: assistantEditorReadResult(await assistantApi.editor(id), args), followUp: 'auto' }
          if (name === 'edit') {
            const state = await assistantApi.proposeEditor(id, args)
            const applied = state.proposal ? await apply(state.proposal) : false
            return {
              result: applied
                ? {
                    status: 'applied',
                    revision: applied.revision,
                    history: applied.history,
                    message: 'Draft updated.',
                  }
                : {
                    status: 'not-applied',
                    message: 'Read the current draft and retry if needed; it may have changed.',
                  },
              followUp: 'auto',
            }
          }
          return { result: { error: 'This tool is not available in the page editor' }, followUp: 'auto' }
        } catch (error) {
          return { result: { error: error instanceof Error ? error.message : 'Editor tool failed' }, followUp: 'auto' }
        }
      },
    }),
    [sync, id, apply, draft, draftRef, instructions, tools]
  )
  const useRealtime = realtime && can('ai:voice')
  return (
    <section
      className="flex min-w-0 flex-col rounded-xl border border-th-border bg-surface h-[28rem] shrink-0 lg:h-auto lg:shrink lg:flex-1 min-h-0 overflow-hidden"
      aria-label="Design conversation"
    >
      <header className="shrink-0 p-3 border-b border-th-border space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-medium">{title}</h4>
          {useRealtime && (
            <button
              type="button"
              className="ficus-button ficus-button-ghost flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-accent-light disabled:opacity-50"
              aria-label={
                controls?.connecting ? 'Connecting microphone' : controls?.live ? 'Microphone on' : 'Enable microphone'
              }
              title={
                controls?.connecting ? 'Connecting microphone…' : controls?.live ? 'Microphone on' : 'Enable microphone'
              }
              aria-pressed={controls?.live ?? false}
              disabled={!ready || !controls || controls.connecting || controls.live}
              onClick={() => void controls?.startVoice()}
            >
              <MicIcon className="h-5 w-5" />
            </button>
          )}
        </div>
        <p className="text-xs text-muted">{subtitle}</p>
      </header>
      {syncError && (
        <p role="alert" className="max-h-28 shrink-0 overflow-y-auto break-words p-3 text-sm text-danger">
          {summarizeAssistantError(syncError)}{' '}
          <button type="button" onClick={() => void sync().catch(() => {})}>
            Retry
          </button>
        </p>
      )}
      {
        <AssistantConversationView
          dependencies={conversationDependencies}
          id={id}
          existing
          realtime={useRealtime}
          pageEditor={bridge}
          toolRenderers={pageEditorToolRenderers}
          compact={false}
          visible
          onControls={setControls}
          onCreated={() => {}}
          onExpand={() => {}}
          positionControl={null}
        />
      }
    </section>
  )
}
