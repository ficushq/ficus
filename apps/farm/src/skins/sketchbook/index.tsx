import '@fontsource-variable/shantell-sans/infm.css'
import '../line/motion.css'
import './theme.css'
import type { FarmSkin } from '../types'
import { blueprintSkin } from '../blueprint'
import {
  BlueprintAvatar,
  BlueprintCompost,
  BlueprintCrates,
  BlueprintDecor,
  BlueprintFarmhouse,
  BlueprintHut,
  BlueprintMailbox,
  BlueprintPerson,
  BlueprintRack,
  BlueprintPlant,
  BlueprintPlot,
  BlueprintRobot,
  BlueprintSeedShed,
  BlueprintSign,
  BlueprintStand,
  BlueprintYard,
} from '../blueprint/sprites'
import { SketchbookBadge, SketchbookDefs, SketchbookGround, inPencil } from './sprites'

/** The farm drawn by hand in a sketchbook: pencil on graph paper, washed in green, marked in red. */
export const sketchbookSkin: FarmSkin = {
  id: 'sketchbook',
  label: 'Sketchbook',
  className: 'g-skin-sketchbook',
  Defs: SketchbookDefs,
  Ground: SketchbookGround,
  YardBack: inPencil(BlueprintYard),
  yardFront: () => [],
  Sign: inPencil(BlueprintSign),
  PlotGround: inPencil(BlueprintPlot),
  Plant: inPencil(BlueprintPlant),
  Badge: SketchbookBadge,
  badgeLift: blueprintSkin.badgeLift,
  Robot: inPencil(BlueprintRobot),
  Person: inPencil(BlueprintPerson),
  Avatar: inPencil(BlueprintAvatar),
  avatarViewBox: blueprintSkin.avatarViewBox,
  Hut: inPencil(BlueprintHut),
  Rack: inPencil(BlueprintRack),
  Stand: inPencil(BlueprintStand),
  Farmhouse: inPencil(BlueprintFarmhouse),
  SeedShed: inPencil(BlueprintSeedShed),
  Mailbox: inPencil(BlueprintMailbox),
  Crates: inPencil(BlueprintCrates),
  Compost: inPencil(BlueprintCompost),
  Decor: inPencil(BlueprintDecor),
  // Handwritten titles run wider than Blueprint's lettering.
  boxes: { ...blueprintSkin.boxes, sign: [-170, -40, 180, 46] },
  worldPad: blueprintSkin.worldPad,
}
