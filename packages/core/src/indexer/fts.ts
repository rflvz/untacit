/**
 * FTS5 query escaping and tokenization mirrors: everything that must stay in
 * lockstep with how the `search` FTS table tokenizes text.
 */

/**
 * Escape a raw user query into a safe FTS5 MATCH expression: each whitespace
 * token becomes a double-quoted phrase (implicit AND); a trailing `*` on the
 * raw query turns the last phrase into a prefix query.
 */
export function toFtsQuery(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const prefix = trimmed.endsWith('*');
  const body = prefix ? trimmed.slice(0, -1) : trimmed;
  const tokens = body.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  const phrases = tokens.map((t) => `"${t.replaceAll('"', '""')}"`);
  if (prefix) phrases[phrases.length - 1] += '*';
  return phrases.join(' ');
}

/**
 * Tokenize like the FTS table does (unicode61, remove_diacritics 2, lowered),
 * so PRF candidate terms line up with the `search_vocab` statistics.
 */
export function ftsTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Any Unicode letter/number separates like unicode61 does — an ASCII-only
    // class would silently drop non-Latin scripts the FTS table indexes fine.
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** Facet cap per node: name facet + up to this many description segments. */
const MAX_DESCRIPTION_FACETS = 5;

/**
 * Split a description into sentence-ish segments for late-interaction
 * embedding: newline first, then sentence enders. Short fragments (< 15
 * chars) merge into their neighbor so facets stay meaningful; at most
 * MAX_DESCRIPTION_FACETS survive (the head of the description wins).
 */
export function segmentDescription(description: string): string[] {
  const rough = description
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const segments: string[] = [];
  for (const piece of rough) {
    if (piece.length < 15 && segments.length > 0) {
      segments[segments.length - 1] += ` ${piece}`;
    } else {
      segments.push(piece);
    }
  }
  return segments.slice(0, MAX_DESCRIPTION_FACETS);
}
