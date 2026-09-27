import './sprites.css'
import type { FarmSkin } from '../types'
import { cropFor, propFor, robotLookFor } from './looks'
import {
  Badge,
  badgeLift,
  Bush,
  ChargingHut,
  Compost,
  ConsultingStand,
  Crates,
  Crop,
  Farmhouse,
  Flowers,
  Grass,
  HayBale,
  Mailbox,
  PlotSelectionGround,
  PlotSelectionTint,
  PlowedSoil,
  Robot,
  SceneDefs,
  SeedShed,
  Tree,
  YardBack,
  yardFrontPieces,
  YardSign,
} from './sprites'

/** The nostalgic farm: soil squares, crops, fences, cottage and robots in overalls. */
export const nostalgicSkin: FarmSkin = {
  id: 'nostalgic',
  label: 'Nostalgic',
  className: 'g-skin-nostalgic',
  Defs: SceneDefs,
  Ground: ({ bounds }) => <Grass minI={bounds.minI} maxI={bounds.maxI} minJ={bounds.minJ} maxJ={bounds.maxJ} />,
  YardBack,
  yardFront: yardFrontPieces,
  Sign: YardSign,
  PlotGround: ({ i, j, selected }) => (
    <>
      {selected && <PlotSelectionGround i={i} j={j} />}
      <PlowedSoil i={i} j={j} />
      {selected && <PlotSelectionTint i={i} j={j} />}
    </>
  ),
  Plant: ({ plot }) => <Crop kind={cropFor(plot.stream.id)} state={plot.state} />,
  Badge,
  badgeLift: (plot) => badgeLift(cropFor(plot.stream.id)),
  Robot: ({ placement, extra }) => (
    <Robot
      look={robotLookFor(placement.agent, placement.role)}
      face={placement.face}
      prop={propFor(placement.role, placement.face)}
      helpers={placement.helpers}
      extra={extra}
      flip={placement.facing === 'left'}
    />
  ),
  Avatar: ({ agent, role, face }) => <Robot look={robotLookFor(agent, role)} face={face} prop={propFor(role, face)} />,
  avatarViewBox: '-26 -70 52 52',
  Hut: ({ count, peek }) => <ChargingHut count={count} peek={peek ? robotLookFor(peek.agent, peek.role) : undefined} />,
  Stand: ({ count, host }) => (
    <ConsultingStand count={count} host={host ? robotLookFor(host.agent, host.role) : undefined} />
  ),
  Farmhouse,
  SeedShed,
  Mailbox,
  Crates,
  Compost,
  Decor: ({ decor }) =>
    decor.kind === 'tree' || decor.kind === 'fruitTree' ? (
      <Tree fruit={decor.kind === 'fruitTree'} seed={decor.seed} />
    ) : decor.kind === 'bush' ? (
      <Bush seed={decor.seed} />
    ) : decor.kind === 'flowers' ? (
      <Flowers seed={decor.seed} />
    ) : (
      <HayBale />
    ),
  boxes: {
    robot: [-22, -74, 44, 80],
    plant: [-34, -78, 68, 92],
    sign: [-60, -72, 120, 78],
    hut: [-64, -96, 128, 118],
    stand: [-58, -100, 116, 118],
    farmhouse: [-120, -190, 240, 220],
    seedShed: [-80, -120, 160, 150],
    mailbox: [-34, -96, 68, 104],
    crates: [-40, -40, 80, 50],
    compost: [-30, -30, 60, 40],
  },
  worldPad: { top: 200, side: 60, bottom: 40 },
}
