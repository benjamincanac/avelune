/**
 * Shared state for the hub Oracle NPC.
 *
 * The Oracle talks in the ordinary floor chat (answering only when addressed —
 * the server decides), so there's no private dialog. `near` is set by the 3D
 * scene when the runner stands close, purely to show a discovery hint. `speech`
 * is the Oracle's latest line, set by `useGame` on receipt, so the scene can
 * float a bubble over the NPC — mirroring how players' chat bubbles work.
 */
export function useOracle() {
  const near = useState('oracle:near', () => false)
  const speech = useState<{ text: string, until: number } | null>('oracle:speech', () => null)
  return { near, speech }
}
