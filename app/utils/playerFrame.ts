import type { MoveInput } from '#shared/types/game'

/** Frame inputs borrowed from the scene coordinator; no reactive per-frame state. */
export interface PlayerFrame {
  dt: number
  now: number
  selfId: string | null
  local: { x: number, y: number, z: number, facing: number, grounded: boolean }
  held: MoveInput
  selfDashing: boolean
  selfVisible: boolean
  audioEnabled: boolean
}
