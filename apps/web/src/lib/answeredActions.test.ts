import { expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import type { PendingAction } from '@ficus/shared'
import { queryKeys } from '../queryKeys'
import { forgetSettledAnswers, removeAnsweredActions, wasActionAnswered } from './answeredActions'

const action = (id: string) => ({ id }) as PendingAction

test('answering removes the card from the cached list and remembers it', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.actions.pending(), [action('remove:a'), action('remove:b')])
  removeAnsweredActions(queryClient, ['remove:a'])
  expect(queryClient.getQueryData(queryKeys.actions.pending())).toEqual([action('remove:b')])
  expect(wasActionAnswered('remove:a')).toBe(true)
  expect(wasActionAnswered('remove:b')).toBe(false)
})

test('a fetch that started after the answer and returns without the card forgets it', async () => {
  removeAnsweredActions(new QueryClient(), ['agent-error:halts-again'])
  // Still pending on the server for a moment: the card is still remembered.
  await forgetSettledAnswers(async () => [action('agent-error:halts-again')])()
  expect(wasActionAnswered('agent-error:halts-again')).toBe(true)
  await forgetSettledAnswers(async () => [action('other')])()
  // A later halt of the same agent reuses the id and is a new arrival.
  expect(wasActionAnswered('agent-error:halts-again')).toBe(false)
})

test('a fetch already in flight when the user answered forgets nothing answered after it started', async () => {
  let finish: (actions: PendingAction[]) => void = () => {}
  const inFlight = forgetSettledAnswers(() => new Promise<PendingAction[]>((resolve) => (finish = resolve)))()
  removeAnsweredActions(new QueryClient(), ['squad-question:in-flight'])
  finish([])
  await inFlight
  expect(wasActionAnswered('squad-question:in-flight')).toBe(true)
  await forgetSettledAnswers(async () => [])()
  expect(wasActionAnswered('squad-question:in-flight')).toBe(false)
})
