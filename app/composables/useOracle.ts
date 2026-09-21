/**
 * Shared state for the Oracle NPC.
 *
 * The Oracle talks in the ordinary arena chat (answering only when addressed —
 * the server decides), so there's no private dialog. `near` is set by the 3D
 * scene when a player stands close, purely to show a discovery hint. `speech`
 * is the Oracle's latest line, set by `useGame` on receipt, so the scene can
 * float a bubble over the NPC — mirroring how players' chat bubbles work. `to`
 * is the player that line answers, which the scene turns the NPC to face.
 */
export function useOracle() {
  const near = useState('oracle:near', () => false)
  const speech = useState<{ text: string, until: number, to?: string } | null>('oracle:speech', () => null)
  return { near, speech }
}
