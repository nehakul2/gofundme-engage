// Reading a place out of what someone typed. Small and free of the big place list, so the chat
// in the browser can use it to decide "is this a place?" and the server does the actual lookup.

export const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const BY_NAME = new Map(Object.entries(STATES).map(([abbr, name]) => [name.toLowerCase(), abbr]));
const US = /^(?:u\.?s\.?a?\.?|united states(?: of america)?|america)$/i;
// Countries people are likely to type. A "City, Country" outside the US gets a clear "US only for now".
const OTHER_COUNTRIES = new Set([
  'canada', 'mexico', 'uk', 'united kingdom', 'england', 'scotland', 'wales', 'ireland', 'france', 'germany', 'spain', 'italy', 'india', 'china',
  'japan', 'australia', 'new zealand', 'brazil', 'argentina', 'philippines', 'pakistan', 'bangladesh', 'nigeria', 'kenya', 'south africa',
  'egypt', 'israel', 'turkey', 'russia', 'ukraine', 'poland', 'netherlands', 'sweden', 'norway', 'singapore', 'indonesia', 'vietnam',
]);

export type ParsedPlace =
  | { kind: 'zip'; zip: string }
  | { kind: 'city'; city: string; state: string | null }
  | { kind: 'unsupported'; country: string };

const LEAD = /^\s*(?:(?:show me|find me|find|any|are there|is there|what(?:'s| is))\s+)?(?:(?:fundraisers?|campaigns?|incidents?|causes?|needs?)\s+)?(?:near|in|around|for|at|by|close to)?\s*/i;

export function stateAbbr(s: string): string | null {
  const t = s.trim().replace(/\./g, '');
  if (/^[A-Za-z]{2}$/.test(t) && STATES[t.toUpperCase()]) return t.toUpperCase();
  return BY_NAME.get(t.toLowerCase()) ?? null;
}

// "94404", "near 94404", "Foster City, CA", "Foster City, California, USA", "Springfield, US".
// Anything else returns null so it is treated as an ordinary search.
export function parsePlace(raw: string): ParsedPlace | null {
  const t = raw.trim().replace(/[?.!]+$/, '').replace(LEAD, '').trim();
  if (!t || t.length > 80) return null;
  const zip = /^(\d{5})(?:-\d{4})?$/.exec(t);
  if (zip) return { kind: 'zip', zip: zip[1] };
  const parts = t.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => /\d/.test(p))) return null;
  const city = parts[0];
  if (!/^[A-Za-z][A-Za-z .'\-]*$/.test(city)) return null;
  const last = parts[parts.length - 1];
  if (OTHER_COUNTRIES.has(last.toLowerCase())) return { kind: 'unsupported', country: last };
  if (US.test(last)) return { kind: 'city', city, state: parts.length === 3 ? stateAbbr(parts[1]) : null };
  const st = stateAbbr(last);
  if (st && parts.length === 2) return { kind: 'city', city, state: st };
  return null;
}
