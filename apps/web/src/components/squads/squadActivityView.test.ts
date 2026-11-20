import { expect, test } from 'bun:test'
import { activityCardWaitLabel } from './squadActivityView'

const wait = (type: 'review' | 'question' | 'dependency' | 'manual', needsYou: boolean) => ({ type, needsYou })

test('wait labels name what the person can act on now', () => {
  expect(activityCardWaitLabel({ waits: [] })).toBeNull()
  expect(activityCardWaitLabel({ waits: [wait('question', true)] })).toBe('Waiting on you: question')
  expect(activityCardWaitLabel({ waits: [wait('review', true), wait('dependency', false)] })).toBe(
    'Waiting on you: review'
  )
  expect(activityCardWaitLabel({ waits: [wait('dependency', false), wait('manual', false)] })).toBe(
    'Waiting: dependency, blocker'
  )
})

test('a review gate queued behind other waits trails as "review next"', () => {
  // A review the person cannot act on yet is a workflow gate that other waits on its attempt block.
  expect(activityCardWaitLabel({ waits: [wait('question', true), wait('review', false)] })).toBe(
    'Waiting on you: question · review next'
  )
  expect(activityCardWaitLabel({ waits: [wait('review', false), wait('dependency', false)] })).toBe(
    'Waiting: dependency · review next'
  )
  expect(activityCardWaitLabel({ waits: [wait('review', false)] })).toBe('Waiting: review')
})
