/**
 * Entity-name canonicalization. Keeps "HubSpot CRM", "Hubspot" and "hubspot.com" together
 * while keeping genuinely different products ("Zoho CRM" vs "Zoho Bigin") apart.
 */
const GENERIC_SUFFIXES = new Set(['crm', 'inc', 'inc.', 'ltd', 'llc', 'corp', 'corporation', 'the', 'co', 'app', 'platform', 'software', 'hq']);

export function canonicalEntityName(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/\.(com|io|tech|dev|ai|co|app|net|org)\b/g, '')
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const kept = tokens.filter((t, i) => !(GENERIC_SUFFIXES.has(t) && (i > 0 || tokens.length > 1)));
  return (kept.length ? kept : tokens).join(' ').trim();
}

/** Same entity if canonical names are equal, or one is a whole-token prefix of the other. */
export function sameEntity(a: string, b: string): boolean {
  const ca = canonicalEntityName(a);
  const cb = canonicalEntityName(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  return long.startsWith(short + ' ');
}

/** Tokens that may appear in the entity's official domain (used for source classification). */
export function entityDomainTokens(name: string): string[] {
  const canon = canonicalEntityName(name);
  const tokens = canon.split(' ').filter((t) => t.length >= 3);
  const joined = canon.replace(/\s+/g, '');
  const out = new Set<string>();
  if (joined.length >= 3) out.add(joined);
  if (tokens[0]) out.add(tokens[0]);
  return [...out];
}
