/**
 * Shared state for Coach, the stadium's resident agent.
 *
 * The Coach talks in the ordinary arena chat (answering only when addressed —
 * the server decides), so there's no private dialog. `near` is set by the 3D
 * scene when a player stands close, purely to show a discovery hint. `speech`
 * is the Coach's latest line, set by `useGame` on receipt, so the scene can
 * float a bubble over it — mirroring how players' chat bubbles work. `thinking`
 * mirrors the server's `coach` frame while it consults the docs.
 */
export function useCoach() {
  const near = useState('coach:near', () => false)
  const speech = useState<{ text: string, until: number } | null>('coach:speech', () => null)
  const thinking = useState('coach:thinking', () => false)
  return { near, speech, thinking }
}
