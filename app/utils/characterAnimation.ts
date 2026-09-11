import { DASH_DURATION } from '../../shared/utils/maze'

export interface DashAnimationState {
  wasDashing: boolean
  dashAnimUntil: number
}

/** A stale remote snapshot cannot replay a dash after its movement burst ends. */
export function updateDashAnimation(state: DashAnimationState, dashing: boolean, now: number) {
  if (dashing && !state.wasDashing) state.dashAnimUntil = now + DASH_DURATION * 1000
  state.wasDashing = dashing
  return dashing && now < state.dashAnimUntil
}

export function animationBlendDuration(previous: string, next: string) {
  if (next.startsWith('Swim_') || previous.startsWith('Swim_')) return 0.22
  if (next === 'Sprint_Loop') return 0.04
  if (previous === 'Sprint_Loop') return 0.08
  return 0.15
}

/** Preserve the supporting leg when blending between matching gait cycles. */
export function locomotionTransitionTime(previous: string, next: string, time: number, duration: number, nextDuration: number) {
  const isGait = (name: string) => name === 'Jog_Fwd_Loop' || name === 'Sprint_Loop'
  if (!isGait(previous) || !isGait(next) || duration <= 0) return 0
  return (time % duration) / duration * nextDuration
}
