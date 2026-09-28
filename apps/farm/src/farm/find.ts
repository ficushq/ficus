import type { FarmLayout, PlotLayout, RobotPlacement } from './types'

export function findPlot(layout: FarmLayout, streamId: string): (PlotLayout & { squadName: string }) | null {
  for (const yard of layout.yards) {
    const p = yard.plots.find((plot) => plot.stream.id === streamId)
    if (p) return { ...p, squadName: yard.squad.name }
  }
  return null
}

export function findRobot(layout: FarmLayout, agentId: string): RobotPlacement | null {
  for (const yard of layout.yards) {
    if (yard.farmer?.agent.id === agentId) return yard.farmer
    for (const p of yard.plots) if (p.tender?.agent.id === agentId) return p.tender
    // Hut robots aren't on the field (one only peeks out of the doorway).
    for (const r of yard.stand.robots) if (r.agent.id === agentId) return r
  }
  return layout.porch.robots.find((r) => r.agent.id === agentId) ?? null
}
