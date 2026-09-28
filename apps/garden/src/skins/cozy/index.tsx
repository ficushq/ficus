import '@fontsource-variable/fredoka'
import '@fontsource-variable/nunito'
import './sprites.css'
import './theme.css'
import type { FarmSkin } from '../types'
import { cropFor, propFor, robotLookFor } from '../nostalgic/looks'
import {
  CozyBadge,
  CozyCompost,
  CozyCrates,
  CozyFarmhouse,
  CozyHut,
  CozyMailbox,
  CozySeedShed,
  CozyStand,
} from './sprites/Buildings'
import { CozyDecor } from './sprites/Decor'
import { CozyGround, CozyPlot, CozySign, CozyYardBack, cozyYardFront } from './sprites/Ground'
import { CozyDefs } from './sprites/kit'
import { cozyBadgeLift, CozyPlant } from './sprites/Plant'
import { COZY_AVATAR_VIEWBOX, CozyRobot } from './sprites/Robot'

/**
 * The Nostalgic farm made soft and bubbly: round shapes, glossy highlights and
 * no ink outlines, hedges and round trees, pastel robots with blushing cheeks.
 * Each robot and crop keeps its Nostalgic identity (the same look and crop per
 * agent and stream), so the two styles show the same farm.
 */
export const cozySkin: FarmSkin = {
  id: 'cozy',
  label: 'Cozy',
  className: 'g-skin-cozy',
  Defs: CozyDefs,
  Ground: CozyGround,
  YardBack: CozyYardBack,
  yardFront: cozyYardFront,
  Sign: CozySign,
  PlotGround: CozyPlot,
  Plant: ({ plot }) => <CozyPlant kind={cropFor(plot.stream.id)} state={plot.state} />,
  Badge: CozyBadge,
  badgeLift: (plot) => cozyBadgeLift(cropFor(plot.stream.id), plot.state),
  Robot: ({ placement, extra }) => (
    <CozyRobot
      look={robotLookFor(placement.agent, placement.role)}
      face={placement.face}
      prop={propFor(placement.role, placement.face)}
      helpers={placement.helpers}
      extra={extra}
      flip={placement.facing === 'left'}
    />
  ),
  Avatar: ({ agent, role, face }) => (
    <CozyRobot look={robotLookFor(agent, role)} face={face} prop={null} shadow={false} />
  ),
  avatarViewBox: COZY_AVATAR_VIEWBOX,
  Hut: ({ count, peek }) => <CozyHut count={count} peek={peek ? robotLookFor(peek.agent, peek.role) : undefined} />,
  Stand: ({ count, host }) => <CozyStand count={count} host={host ? robotLookFor(host.agent, host.role) : undefined} />,
  Farmhouse: CozyFarmhouse,
  SeedShed: CozySeedShed,
  Mailbox: CozyMailbox,
  Crates: CozyCrates,
  Compost: CozyCompost,
  Decor: CozyDecor,
  boxes: {
    robot: [-24, -80, 48, 86],
    plant: [-30, -72, 60, 84],
    sign: [-96, -64, 192, 70],
    hut: [-58, -84, 116, 104],
    stand: [-56, -104, 112, 122],
    farmhouse: [-128, -170, 256, 220],
    seedShed: [-80, -96, 160, 124],
    mailbox: [-26, -90, 60, 96],
    crates: [-36, -36, 72, 46],
    compost: [-28, -28, 56, 36],
  },
  worldPad: { top: 190, side: 60, bottom: 40 },
}
