/**
 * Realms: one stored world per deployment region, like the regional servers of
 * an MMO. The server derives the realm id from `AVELUNE_REALM`, else Vercel's
 * `VERCEL_REGION`, else `local`; every store key is prefixed with it, so the
 * Frankfurt instance and the Washington instance each own a world of their
 * own and never race each other's chunks. The town is seeded identically in
 * all of them.
 */

/** Vercel region codes to the MMO style region players see. Unknown ids show as-is. */
const REALM_NAMES: Record<string, string> = {
  local: 'Local',
  arn1: 'EU North',
  bom1: 'Asia South',
  cdg1: 'EU West',
  cle1: 'US East',
  cpt1: 'Africa South',
  dub1: 'EU West',
  dxb1: 'Middle East',
  fra1: 'EU Central',
  gru1: 'South America',
  hkg1: 'Asia East',
  hnd1: 'Asia Northeast',
  iad1: 'US East',
  icn1: 'Asia Northeast',
  kix1: 'Asia Northeast',
  lhr1: 'EU West',
  pdx1: 'US West',
  sfo1: 'US West',
  sin1: 'Asia Southeast',
  syd1: 'Oceania',
}

/** A realm id is a key segment: lowercase letters, digits and dashes only. */
export function normalizeRealm(raw: string | undefined): string {
  const id = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  return id || 'local'
}

export function realmName(id: string): string {
  return REALM_NAMES[id] ?? id
}
