import * as zipcodes from 'zipcodes';
import data from '@/data/us-places.json';
import { getPool } from './db';
import { ApiError } from './errors';
import { parsePlace, STATES, type ParsedPlace } from './placeText';

// US places only. Zip codes come from the `zipcodes` package, towns and cities from
// src/data/us-places.json (GeoNames, see scripts/build-places.mjs). Nothing here calls the internet.

export interface Place { label: string; city: string; state: string; zip: string | null; lat: number; lng: number }
type Row = [string, string, number, number, number];            // name, state, lat, lng, population
const PLACES = data as Row[];                                    // biggest first

const norm = (s: string) =>
  s.toLowerCase().replace(/\./g, '').replace(/\bst\b/g, 'saint').replace(/\bmt\b/g, 'mount').replace(/\bft\b/g, 'fort').replace(/\s+/g, ' ').trim();

export function miles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const nearestZip = (lat: number, lng: number): string | null => zipcodes.lookupByCoords(lat, lng)?.zip ?? null;

// A zip code's post-office city is often not the town people live in (94404 is Foster City, but the
// post office calls it San Mateo), so name it after the closest town within 4 miles when there is one.
function fromZip(zip: string): Place | null {
  const z = zipcodes.lookup(zip);
  if (!z) return null;
  let best: Row | null = null; let bestD = 4;
  for (const p of PLACES) {
    if (p[1] !== z.state || Math.abs(p[2] - z.latitude) > 0.1) continue;
    const d = miles(z.latitude, z.longitude, p[2], p[3]);
    if (d < bestD || (best && d < bestD + 0.5 && p[4] > best[4] * 3)) { best = p; bestD = Math.min(d, bestD); }
  }
  const city = best ? best[0] : z.city;
  return { label: `${city}, ${z.state}`, city, state: z.state, zip: z.zip, lat: z.latitude, lng: z.longitude };
}

export function resolveZip(zip: string): Place | null { return fromZip(zip); }

function fromCity(city: string, state: string | null): Place {
  const want = norm(city);
  const hits = PLACES.filter((p) => norm(p[0]) === want && (!state || p[1] === state));
  if (!hits.length) throw new ApiError(404, 'city_not_found', `I could not find ${city}${state ? `, ${state}` : ''} in the US. Check the spelling, or try a zip code.`);
  const states = [...new Set(hits.map((h) => h[1]))];
  if (!state && states.length > 1) {
    const list = states.slice(0, 5).join(', ');
    throw new ApiError(422, 'ambiguous_city', `There is more than one ${hits[0][0]} (${list}). Add the state, like “${hits[0][0]}, ${states[0]}”.`);
  }
  const p = hits[0];                                             // most populated first
  return { label: `${p[0]}, ${p[1]}`, city: p[0], state: p[1], zip: nearestZip(p[2], p[3]), lat: p[2], lng: p[3] };
}

export function resolvePlace(raw: string): Place {
  const parsed: ParsedPlace | null = parsePlace(raw);
  if (!parsed) throw new ApiError(400, 'not_a_place', 'Type a US zip code like 94404, or a city and state like “Foster City, CA”.', 'q');
  if (parsed.kind === 'unsupported') throw new ApiError(422, 'unsupported_country', `I only know US places for now, so I cannot look up ${parsed.country}. Try a US zip code or “City, ST”.`, 'q');
  if (parsed.kind === 'zip') {
    const p = fromZip(parsed.zip);
    if (!p) throw new ApiError(404, 'zip_not_found', `${parsed.zip} is not a US zip code I know. Check the number.`, 'q');
    return p;
  }
  return fromCity(parsed.city, parsed.state);
}

export const stateName = (abbr: string) => STATES[abbr] ?? abbr;

// Existing fundraisers for a place: those tagged with a location within the radius, plus untagged
// ones that mention the town in their title or story. Active ones only.
export const NEARBY_RADIUS_MI = 25;
export async function nearbyFundraisers(place: Place, radiusMi = NEARBY_RADIUS_MI) {
  const dist = `3959 * acos(LEAST(1, GREATEST(-1, cos(radians($1)) * cos(radians(f.lat)) * cos(radians(f.lng) - radians($2)) + sin(radians($1)) * sin(radians(f.lat)))))`;
  const like = `%${place.city.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await getPool().query(
    `SELECT f.id, f.slug::text AS slug, f.title, f.goal_cents, COALESCE(s.raised_cents, 0)::bigint AS raised_cents,
            u.display_name AS owner_name, f.city, f.state,
            CASE WHEN f.lat IS NULL THEN NULL ELSE round((${dist})::numeric, 1)::float END AS distance_mi
       FROM fundraisers f
       JOIN users u ON u.id = f.owner_id
       LEFT JOIN fundraiser_stats s ON s.fundraiser_id = f.id
      WHERE f.status = 'active'
        AND ((f.lat IS NOT NULL AND (${dist}) <= $3)
          OR (f.lat IS NULL AND (f.title ILIKE $4 OR f.story ILIKE $4)))
      ORDER BY distance_mi NULLS LAST, raised_cents DESC, f.created_at DESC
      LIMIT 5`,
    [place.lat, place.lng, radiusMi, like],
  );
  return rows.map((r) => ({
    id: r.id as string, slug: r.slug as string, title: r.title as string, owner_name: r.owner_name as string,
    raised_cents: Number(r.raised_cents), goal_cents: Number(r.goal_cents),
    city: (r.city as string | null), state: (r.state as string | null), distance_mi: r.distance_mi as number | null,
    can_contribute: true, contribute_note: null as string | null,
  }));
}

// General starter ideas for a place, used when nothing nearby exists.
export function starterIdeas(place: Place): string[] {
  return [`Reading program for ${place.city} students`, `${place.city} food pantry support`, `Neighbors helping neighbors in ${place.city}`];
}
