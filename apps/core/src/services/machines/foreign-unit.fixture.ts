import type { BoxUnitNames } from './box-paths'
export const FOREIGN_BOX_UNIT_PREFIX = 'foreign-box'
export const FOREIGN_USER_UNIT_PREFIX = 'foreign-server'
export function foreignUnits(ctl: BoxUnitNames): BoxUnitNames {
  const unit = ctl.unit
    .replace('ficus-box', FOREIGN_BOX_UNIT_PREFIX)
    .replace('ficus-sandbox-server', FOREIGN_USER_UNIT_PREFIX)
  const prefix = unit.slice(0, -'.service'.length)
  const socket = `${prefix}.socket`
  const proxy = `${prefix}-proxy.service`
  return { unit, socket, proxy, allUnits: `${socket} ${proxy} ${unit}` }
}
