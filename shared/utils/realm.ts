/**
 * Realms: one stored world per deployment region, like the regional servers of
 * an MMO. The server derives the realm id from `AVELUNE_REALM`, else Vercel's
 * `VERCEL_REGION`, else `local`; every store key is prefixed with it, so the
 * Frankfurt instance and the Washington instance each own a world of their
 * own and never race each other's chunks. The town is seeded identically in
 * all of them.
 */

/** Vercel region codes to the names players see. Unknown ids show as-is. */
const REALM_NAMES: Record<string, string> = {
  local: 'Local',
  arn1: 'Stockholm',
  bom1: 'Mumbai',
  cdg1: 'Paris',
  cle1: 'Cleveland',
  cpt1: 'Cape Town',
  dub1: 'Dublin',
  dxb1: 'Dubai',
  fra1: 'Frankfurt',
  gru1: 'São Paulo',
  hkg1: 'Hong Kong',
  hnd1: 'Tokyo',
  iad1: 'Washington',
  icn1: 'Seoul',
  kix1: 'Osaka',
  lhr1: 'London',
  pdx1: 'Portland',
  sfo1: 'San Francisco',
  sin1: 'Singapore',
  syd1: 'Sydney',
}

/** A realm id is a key segment: lowercase letters, digits and dashes only. */
export function normalizeRealm(raw: string | undefined): string {
  const id = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  return id || 'local'
}

export function realmName(id: string): string {
  return REALM_NAMES[id] ?? id
}
