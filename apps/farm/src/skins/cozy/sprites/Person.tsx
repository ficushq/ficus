import type { PersonLook } from '../../../multiplayer/personLook'
import { Ball, Bean, Blob, Drop, light, Pill } from './kit'

/** A person on the farm, Cozy style: a round-headed villager with dot eyes and rosy cheeks. */
export function CozyPerson({ look }: { look: PersonLook }) {
  const hy = -38
  const hat = light(look.hatColor, 25)
  return (
    <g>
      <Drop rx={13} ry={4.4} />
      <Bean cx={-4.5} cy={-4} rx={4} ry={4.5} fill={light(look.pants, 15)} />
      <Bean cx={4.5} cy={-4} rx={4} ry={4.5} fill={light(look.pants, 15)} />
      <Ball cx={-11} cy={-16} r={3.6} fill={look.skin} />
      <Ball cx={11} cy={-16} r={3.6} fill={look.skin} />
      <Pill x={-10} y={-26} width={20} height={20} r={9} fill={light(look.shirt, 20)} />
      <Ball cy={hy} r={14} fill={look.skin} />
      <Blob d={`M-14 ${hy - 1} q0 -14 14 -14 q14 0 14 14 q-5 -7 -14 -7.5 q-9 0.5 -14 7.5 z`} fill={look.hair} />
      <ellipse cx={-4.5} cy={hy + 2} rx={1.7} ry={2.4} fill="#3b2f3f" />
      <ellipse cx={4.5} cy={hy + 2} rx={1.7} ry={2.4} fill="#3b2f3f" />
      <circle cx={-4} cy={hy + 1} r={0.6} fill="#fff" />
      <circle cx={5} cy={hy + 1} r={0.6} fill="#fff" />
      <circle cx={-8.5} cy={hy + 6.5} r={2.6} fill="#ff9fb2" opacity={0.75} />
      <circle cx={8.5} cy={hy + 6.5} r={2.6} fill="#ff9fb2" opacity={0.75} />
      <path d={`M-2 ${hy + 7} q2 1.6 4 0`} stroke="#8a5a4a" strokeWidth={1.3} fill="none" strokeLinecap="round" />
      {look.hat === 'straw' && (
        <g>
          <Bean cy={hy - 11} rx={19} ry={5} fill="#f4d67f" />
          <Blob d={`M-9 ${hy - 11} q0 -9 9 -9 q9 0 9 9 z`} fill="#f4d67f" />
          <rect x={-9} y={hy - 14} width={18} height={3.5} rx={1.7} fill={hat} />
        </g>
      )}
      {look.hat === 'sunhat' && (
        <g>
          <Bean cy={hy - 10} rx={20} ry={5.5} fill={hat} />
          <Blob d={`M-9 ${hy - 10} q0 -8 9 -8 q9 0 9 8 z`} fill={hat} />
          <Ball cx={8} cy={hy - 13} r={2.8} fill="#fff1f5" />
        </g>
      )}
      {look.hat === 'cap' && (
        <g>
          <Bean cx={11} cy={hy - 8} rx={8} ry={2.8} fill={hat} />
          <Blob d={`M-13 ${hy - 6} q0 -13 13 -13 q13 0 13 13 z`} fill={hat} />
        </g>
      )}
      {look.hat === 'beanie' && (
        <g>
          <Blob d={`M-13.5 ${hy - 4} q0 -15 13.5 -15 q13.5 0 13.5 15 z`} fill={hat} />
          <Pill x={-14} y={hy - 7} width={28} height={6} r={3} fill={light(hat, 20)} />
          <Ball cy={hy - 20} r={3.8} fill={light(hat, 30)} />
        </g>
      )}
    </g>
  )
}
