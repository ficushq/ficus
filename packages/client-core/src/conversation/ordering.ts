export { messageSortAt } from '@ficus/shared'

/** Epoch ms for a Date or ISO string. */
export function ms(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

/** Ascending by sort key; deterministic tiebreak by id. Never relies on insertion order. */
export function compareByKey(aSort: number, aId: string, bSort: number, bId: string): number {
  if (aSort !== bSort) return aSort - bSort
  if (aId === bId) return 0
  return aId < bId ? -1 : 1
}
