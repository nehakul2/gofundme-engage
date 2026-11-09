import { getRedis } from './redis';
import type { Place } from './places';
import { miles } from './places';

// What has happened near a place in the last 6 months, from two free public sources that need no key:
//   FEMA     federal disaster declarations for the county (floods, fires, storms, ...)
//   USGS     earthquakes of magnitude 4 or more within 60 km
// Local crime, school closures and news are NOT covered: there is no free structured source for them.
// Every call has a short timeout and a failure just means "no incidents shown"; results are cached 6 hours.

export interface Incident { kind: 'disaster' | 'earthquake'; title: string; date: string; detail: string; source: 'FEMA' | 'USGS'; idea: string }
export const WINDOW_DAYS = 183;
const TIMEOUT_MS = 4500;
const CACHE_S = 6 * 3600;

async function getJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'engage-demo/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const sinceIso = (now: number) => new Date(now - WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);

// FEMA incidentType -> a fundraiser idea. Types with no sensible local fundraiser (Biological, Terrorism, ...) are skipped.
const IDEAS: Record<string, string> = {
  Fire: 'wildfire relief', Flood: 'flood recovery', 'Severe Storm': 'storm recovery', 'Severe Storm(s)': 'storm recovery', Hurricane: 'hurricane relief',
  Tornado: 'tornado recovery', Earthquake: 'earthquake relief', Snowstorm: 'winter storm relief', 'Severe Ice Storm': 'winter storm relief',
  'Winter Storm': 'winter storm relief', Typhoon: 'typhoon relief', Mudslide: 'mudslide recovery', Drought: 'drought relief', 'Coastal Storm': 'storm recovery',
  Tsunami: 'tsunami relief', 'Dam/Levee Break': 'flood recovery', Volcanic: 'volcano relief', Freezing: 'cold weather relief',
};

async function countyFips(place: Place): Promise<{ state: string; county: string; name: string } | null> {
  const j = (await getJson(
    `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${place.lng}&y=${place.lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`,
  )) as { result?: { geographies?: { Counties?: { STATE?: string; COUNTY?: string; BASENAME?: string }[] } } };
  const c = j.result?.geographies?.Counties?.[0];
  return c?.STATE && c.COUNTY ? { state: c.STATE, county: c.COUNTY, name: c.BASENAME ?? 'the county' } : null;
}

async function femaIncidents(place: Place, now: number): Promise<Incident[]> {
  const county = await countyFips(place);
  if (!county) return [];
  const filter = `fipsStateCode eq '${county.state}' and (fipsCountyCode eq '${county.county}' or fipsCountyCode eq '000') and declarationDate ge '${sinceIso(now)}T00:00:00.000z'`;
  const j = (await getJson(
    `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent('declarationDate desc')}&$top=25`,
  )) as { DisasterDeclarationsSummaries?: { disasterNumber: number; declarationTitle?: string; incidentType?: string; declarationDate: string; designatedArea?: string }[] };
  const seen = new Set<number>();
  const out: Incident[] = [];
  for (const d of j.DisasterDeclarationsSummaries ?? []) {
    const what = d.incidentType ? IDEAS[d.incidentType] : undefined;
    if (!what || seen.has(d.disasterNumber)) continue;
    seen.add(d.disasterNumber);
    out.push({
      kind: 'disaster', source: 'FEMA', date: d.declarationDate.slice(0, 10),
      title: `${d.declarationTitle ? d.declarationTitle[0] + d.declarationTitle.slice(1).toLowerCase() : d.incidentType} (federal disaster declaration)`,
      detail: `Declared for ${county.name} County area`,
      idea: `${what[0].toUpperCase()}${what.slice(1)} for ${place.city} families`,
    });
  }
  return out;
}

async function quakeIncidents(place: Place, now: number): Promise<Incident[]> {
  const j = (await getJson(
    `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${place.lat}&longitude=${place.lng}&maxradiuskm=60&minmagnitude=4&orderby=magnitude&limit=3&starttime=${sinceIso(now)}`,
  )) as { features?: { properties: { mag: number; place: string; time: number }; geometry?: { coordinates?: number[] } }[] };
  return (j.features ?? []).map((f) => {
    const [lng, lat] = f.geometry?.coordinates ?? [];
    const away = lat != null && lng != null ? `${Math.round(miles(place.lat, place.lng, lat, lng))} miles away` : f.properties.place;
    return {
      kind: 'earthquake' as const, source: 'USGS' as const, date: new Date(f.properties.time).toISOString().slice(0, 10),
      title: `Magnitude ${f.properties.mag.toFixed(1)} earthquake`, detail: away,
      idea: `Earthquake relief for ${place.city} families`,
    };
  });
}

export interface IncidentResult { incidents: Incident[]; checked: string[]; failed: string[] }

export async function recentIncidents(place: Place, now = Date.now()): Promise<IncidentResult> {
  const key = `incidents:${place.lat.toFixed(2)}:${place.lng.toFixed(2)}`;
  const redis = getRedis();
  try { const hit = await redis.get(key); if (hit) return JSON.parse(hit) as IncidentResult; } catch { /* no cache is fine */ }
  const jobs: [string, Promise<Incident[]>][] = [['FEMA', femaIncidents(place, now)], ['USGS', quakeIncidents(place, now)]];
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const incidents: Incident[] = []; const failed: string[] = [];
  settled.forEach((s, i) => (s.status === 'fulfilled' ? incidents.push(...s.value) : failed.push(jobs[i][0])));
  incidents.sort((a, b) => (a.date < b.date ? 1 : -1));
  const result: IncidentResult = { incidents: incidents.slice(0, 5), checked: ['FEMA', 'USGS'].filter((s) => !failed.includes(s)), failed };
  if (!failed.length) { try { await redis.set(key, JSON.stringify(result), 'EX', CACHE_S); } catch { /* ignore */ } }
  return result;
}
