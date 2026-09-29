import { describe, expect, it } from 'bun:test'
import { cropFor, DENIM, GLOWS, PANELS, propFor, robotLookFor, SHELLS } from './looks'
import type { RobotRole } from '../../farm/types'
import type { RobotLook } from './types'
import { makeAgent } from '../../farm/testFixtures'

const LOOK_KEYS: (keyof RobotLook)[] = [
  'shell',
  'panel',
  'glow',
  'head',
  'move',
  'antenna',
  'hat',
  'hatColor',
  'outfit',
  'outfitColor',
  'scarf',
]
const ROLES: RobotRole[] = ['manager', 'consultant', 'assistant', 'worker']
const ids = Array.from({ length: 200 }, (_, n) => `agent-${n}`)

describe('cropFor', () => {
  it('is stable per stream and varied across streams', () => {
    expect(cropFor('ws-42')).toBe(cropFor('ws-42'))
    expect(new Set(ids.map(cropFor))).toEqual(new Set(['tomato', 'sunflower', 'pumpkin']))
  })
})

describe('robotLookFor', () => {
  it('is deterministic from the agent id', () => {
    for (const role of ROLES) {
      const a = robotLookFor(makeAgent({ id: 'x-1', status: 'active' }), role)
      const b = robotLookFor(makeAgent({ id: 'x-1', status: 'dormant', agentTypeId: 'other' }), role)
      expect(a).toEqual(b)
    }
  })

  it('only ever has the RobotLook fields (no facial hair, ever)', () => {
    for (const role of ROLES) {
      for (const id of ids.slice(0, 40)) {
        const look = robotLookFor(makeAgent({ id }), role)
        expect(Object.keys(look).sort()).toEqual([...LOOK_KEYS].sort())
        expect(Object.keys(look).some((key) => /beard|mustache|moustache|facial/i.test(key))).toBe(false)
      }
    }
  })

  it('dresses every manager as the farmer', () => {
    for (const id of ids.slice(0, 40)) {
      const look = robotLookFor(makeAgent({ id }), 'manager')
      expect(look).toMatchObject({
        head: 'box',
        move: 'treads',
        hat: 'straw',
        antenna: 'none',
        outfit: 'overalls',
        scarf: '#c2412b',
      })
    }
  })

  it('dresses every consultant in a sun hat and apron', () => {
    for (const id of ids.slice(0, 40)) {
      const look = robotLookFor(makeAgent({ id }), 'consultant')
      expect(look).toMatchObject({
        head: 'dome',
        move: 'hover',
        hat: 'sun',
        antenna: 'none',
        outfit: 'apron',
        outfitColor: '#9fb57f',
      })
    }
  })

  it('makes assistants friendly porch greeters', () => {
    for (const id of ids.slice(0, 40)) {
      const look = robotLookFor(makeAgent({ id }), 'assistant')
      expect(look).toMatchObject({
        head: 'round',
        move: 'hover',
        hat: null,
        antenna: 'bulb',
        outfit: null,
        glow: '#ffd76a',
      })
      expect(PANELS).toContain(look.scarf as (typeof PANELS)[number])
    }
  })

  it('gives workers variety drawn from the palettes', () => {
    const looks = ids.map((id) => robotLookFor(makeAgent({ id }), 'worker'))
    expect(new Set(looks.map((l) => l.head)).size).toBe(3)
    expect(new Set(looks.map((l) => l.move)).size).toBe(4)
    expect(new Set(looks.map((l) => l.antenna)).size).toBe(4)
    expect(new Set(looks.map((l) => l.hat))).toEqual(new Set(['cap', 'bandana', 'beanie', 'bucket', null]))
    expect(new Set(looks.map((l) => l.outfit))).toEqual(new Set(['overalls', 'apron', null]))
    for (const look of looks) {
      expect(SHELLS).toContain(look.shell as (typeof SHELLS)[number])
      expect(PANELS).toContain(look.panel as (typeof PANELS)[number])
      expect(GLOWS).toContain(look.glow as (typeof GLOWS)[number])
      expect(look.hat === 'straw' || look.hat === 'sun').toBe(false)
      if (look.outfit === 'overalls') expect(look.outfitColor).toBe(DENIM)
      if (look.outfit === 'apron') expect(PANELS).toContain(look.outfitColor as (typeof PANELS)[number])
    }
    const scarves = looks.filter((l) => l.scarf !== null).length / looks.length
    expect(scarves).toBeGreaterThan(0.18)
    expect(scarves).toBeLessThan(0.42)
  })
})

describe('propFor', () => {
  it('hands each role its tool', () => {
    expect(propFor('manager', 'normal')).toBe('hoe')
    expect(propFor('consultant', 'sleepy')).toBe('clip')
    expect(propFor('worker', 'happy')).toBe('can')
    expect(propFor('worker', 'question')).toBeNull()
    expect(propFor('worker', 'error')).toBeNull()
    expect(propFor('assistant', 'happy')).toBeNull()
  })
})
