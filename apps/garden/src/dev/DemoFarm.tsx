import { useMemo } from 'react'
import { FarmScreen } from '../farm/FarmScreen'
import { sampleFarm } from './sampleFarm'

export default function DemoFarm() {
  const input = useMemo(() => sampleFarm(), [])
  return <FarmScreen input={input} live="live" />
}
