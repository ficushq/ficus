import { useEffect, useRef, useState } from 'react'
import type { DerivationEvent, DerivationFilters, VoiceDerivationResult } from '@ficus/shared'
import { deriveVoice, type VoiceDerivationTarget } from '../../api/publicVoices'
import { useStableRef } from '../../hooks/useStableRef'

/** A generation owns callbacks, result and cancellation; stale requests can never revive a draft. */
export function useVoiceDerivation(
  target: VoiceDerivationTarget,
  body: () => { login: string; filters: DerivationFilters }
) {
  const targetKey = target.kind === 'squad' ? `squad:${target.squadId}` : `connection:${target.connectionId}`
  const bodyRef = useStableRef(body)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const [data, setData] = useState<VoiceDerivationResult>()
  const [error, setError] = useState<unknown>()
  const [isPending, setPending] = useState(false)
  const [phase, setPhase] = useState('Reading GitHub activity.')
  const [counts, setCounts] = useState<Extract<DerivationEvent, { type: 'counts' }>>()
  const [activity, setActivity] = useState<{ history: string[]; omitted: boolean }>({ history: [], omitted: false })
  const { history, omitted } = activity
  const [notice, setNotice] = useState('')
  const [tallyAnnouncement, setTallyAnnouncement] = useState('')
  const lastAnnouncement = useRef(0)
  const [elapsed, setElapsed] = useState(0)
  // Adjust state during render so the old squad's draft is never committed to the new view.
  const [scope, setScope] = useState(targetKey)
  if (scope !== targetKey) {
    setScope(targetKey)
    setData(undefined)
    setError(undefined)
    setPending(false)
    setActivity({ history: [], omitted: false })
    setCounts(undefined)
    setNotice('')
    setTallyAnnouncement('')
  }
  useEffect(() => {
    const invalidate = () => {
      ++generation.current
      controller.current?.abort()
      controller.current = null
    }
    return invalidate
  }, [targetKey])
  useEffect(() => {
    if (!isPending) return
    const start = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [isPending])
  const cancel = () => {
    ++generation.current
    controller.current?.abort()
    controller.current = null
    setPending(false)
    setData(undefined)
    setNotice('Cancelled. Nothing was saved.')
    setPhase('Cancelled. Nothing was saved.')
  }
  const mutate = async () => {
    controller.current?.abort()
    const current = ++generation.current
    const abort = new AbortController()
    controller.current = abort
    setData(undefined)
    setError(undefined)
    setPending(true)
    setCounts(undefined)
    setActivity({ history: [], omitted: false })
    setNotice('')
    setTallyAnnouncement('')
    setElapsed(0)
    lastAnnouncement.current = 0
    setPhase('Reading GitHub activity.')
    const append = (lines: string[]) =>
      setActivity((previous) => ({
        history: [...previous.history, ...lines].slice(-100),
        omitted: previous.omitted || previous.history.length + lines.length > 100,
      }))
    try {
      const result = await deriveVoice(target, bodyRef.current(), {
        signal: abort.signal,
        onLegacyResponse: () => {
          if (current === generation.current) setNotice('This server does not report live progress.')
        },
        onProgress: (event) => {
          if (current !== generation.current || abort.signal.aborted) return
          if (event.type === 'phase')
            setPhase(
              {
                collecting: 'Reading GitHub activity.',
                sampling: 'Selecting writing samples.',
                drafting: 'Drafting style observations. Findings appear after validation.',
                validating: 'Validating the draft.',
              }[event.phase]
            )
          else if (event.type === 'counts') {
            setCounts(event)
            if (!event.provisional || Date.now() - lastAnnouncement.current >= 5000) {
              lastAnnouncement.current = Date.now()
              setTallyAnnouncement(
                `${event.totals.seen} candidates seen, ${event.totals.kept} kept${event.provisional ? ' so far.' : '.'}`
              )
            }
          } else if (event.type === 'repositories')
            append(
              event.repositories.map(
                (repo) =>
                  ({
                    activity_read: 'Activity read from',
                    reading_commits: 'Reading commits in',
                    commits_read: 'Commits read from',
                    unavailable: 'Not found or not visible',
                    commit_limit: 'Commit limit; not read',
                  })[repo.activity] + ` ${repo.name}.`
              )
            )
          else if (event.type === 'finding') append([`Finding: ${event.text}`])
        },
      })
      if (current === generation.current && !abort.signal.aborted) {
        setData(result)
        setPhase('Draft ready. Nothing was saved.')
      }
    } catch (failure) {
      if (current === generation.current && !abort.signal.aborted) {
        setError(failure)
        setPhase('Derivation failed. Nothing was saved.')
      }
    } finally {
      if (current === generation.current) {
        setPending(false)
        controller.current = null
      }
    }
  }
  return { data, error, isPending, mutate, cancel, phase, counts, history, omitted, notice, elapsed, tallyAnnouncement }
}
