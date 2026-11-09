import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS } from '@/fixtures';
import { parsePlace } from '@/lib/placeText';
import { resolvePlace } from '@/lib/places';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await closePool(); await closeRedis(); });

const suggest = async (q: string) => {
  const { GET } = await import('@/app/api/v1/places/suggest/route');
  const res = await GET(new Request(`http://x/?q=${encodeURIComponent(q)}`));
  return { status: res.status, body: await res.json() };
};
const createFr = async (body: unknown) => {
  const { POST } = await import('@/app/api/v1/fundraisers/route');
  const res = await POST(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': IDS.U1 }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

// Fake FEMA / Census / USGS responses.
function mockNet(opts: { fema?: unknown[]; quakes?: unknown[]; failFema?: boolean } = {}) {
  const f = vi.fn(async (url: string) => {
    if (url.includes('geocoding.geo.census.gov')) return new Response(JSON.stringify({ result: { geographies: { Counties: [{ STATE: '06', COUNTY: '081', BASENAME: 'San Mateo' }] } } }));
    if (url.includes('fema.gov')) return opts.failFema ? new Response('no', { status: 503 }) : new Response(JSON.stringify({ DisasterDeclarationsSummaries: opts.fema ?? [] }));
    if (url.includes('earthquake.usgs.gov')) return new Response(JSON.stringify({ features: opts.quakes ?? [] }));
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', f);
  return f;
}
const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

describe('PLACE: reading what was typed', () => {
  it('PLACE-01 zips, city and state, and US variants are recognised; plain topics are not', () => {
    expect(parsePlace('94404')).toEqual({ kind: 'zip', zip: '94404' });
    expect(parsePlace('fundraisers near 94404')).toEqual({ kind: 'zip', zip: '94404' });
    expect(parsePlace('Foster City, CA')).toEqual({ kind: 'city', city: 'Foster City', state: 'CA' });
    expect(parsePlace('Foster City, California, USA')).toEqual({ kind: 'city', city: 'Foster City', state: 'CA' });
    expect(parsePlace('Toronto, Canada')).toEqual({ kind: 'unsupported', country: 'Canada' });
    expect(parsePlace('wildfire')).toBeNull();
    expect(parsePlace('help schools, kids')).toBeNull();
  });
});

describe('PLACE: resolving a place offline', () => {
  it('PLACE-02 a zip is named after the town, not the post office city', () => {
    expect(resolvePlace('94404')).toMatchObject({ city: 'Foster City', state: 'CA', zip: '94404' });
  });
  it('PLACE-03 city and state resolve with a zip; "St." spellings match', () => {
    expect(resolvePlace('Foster City, CA')).toMatchObject({ label: 'Foster City, CA' });
    expect(resolvePlace('Saint Louis, MO').city).toBe('St. Louis');
  });
  it('PLACE-04 a city in several states asks for the state', () => {
    expect(() => resolvePlace('Springfield, USA')).toThrowError(/more than one Springfield/);
    expect(resolvePlace('Springfield, IL').state).toBe('IL');
  });
  it('PLACE-05 unknown zip, unknown city and non-US places give clear errors', () => {
    expect(() => resolvePlace('00000')).toThrowError(/not a US zip/);
    expect(() => resolvePlace('Nowhereville, CA')).toThrowError(/could not find/);
    expect(() => resolvePlace('Paris, France')).toThrowError(/only know US places/);
    expect(() => resolvePlace('hello')).toThrowError(/US zip code/);
  });
});

describe('PLACE: the suggest endpoint', () => {
  it('PLACE-06 with nothing nearby it returns starter ideas', async () => {
    mockNet();
    const r = await suggest('94404');
    expect(r.status).toBe(200);
    expect(r.body.nearby).toEqual([]);
    expect(r.body.incidents).toEqual([]);
    expect(r.body.ideas.length).toBeGreaterThan(0);
    expect(r.body.ideas[0]).toMatch(/Foster City/);
  });

  it('PLACE-07 a fundraiser created with a zip is found nearby, and not for a far-away place', async () => {
    mockNet();
    const c = await createFr({ title: 'Foster City library fund', story: 'Books for our neighborhood library.', goal_cents: 500000, zip: '94404' });
    expect(c.status).toBe(201);
    const near = await suggest('Foster City, CA');
    expect(near.body.nearby.map((h: { title: string }) => h.title)).toContain('Foster City library fund');
    const far = await suggest('Miami, FL');
    expect(far.body.nearby.map((h: { title: string }) => h.title)).not.toContain('Foster City library fund');
  });

  it('PLACE-08 a bad zip on create is a 400 on the zip field', async () => {
    const r = await createFr({ title: 'Bad zip', story: 'x', goal_cents: 500000, zip: '00000' });
    expect(r.status).toBe(400);
    expect(r.body.error.field).toBe('zip');
  });

  it('PLACE-09 recent disasters and earthquakes become incidents and fundraiser ideas', async () => {
    mockNet({
      fema: [
        { disasterNumber: 1, declarationTitle: 'SEVERE WINTER STORMS', incidentType: 'Severe Storm', declarationDate: day(30), designatedArea: 'San Mateo (County)' },
        { disasterNumber: 2, declarationTitle: 'COVID', incidentType: 'Biological', declarationDate: day(20) },
      ],
      quakes: [{ properties: { mag: 4.6, place: '5 km N of Somewhere', time: Date.now() - 5 * 86400_000 }, geometry: { coordinates: [-122.3, 37.6, 8] } }],
    });
    const r = await suggest('94404');
    expect(r.body.incidents.map((i: { source: string }) => i.source).sort()).toEqual(['FEMA', 'USGS']);
    expect(r.body.incidents.some((i: { title: string }) => /COVID|Biological/i.test(i.title))).toBe(false);
    expect(r.body.ideas).toEqual(expect.arrayContaining(['Storm recovery for Foster City families', 'Earthquake relief for Foster City families']));
  });

  it('PLACE-10 the 6-month window is sent to FEMA and USGS', async () => {
    const f = mockNet();
    await suggest('94404');
    const urls = f.mock.calls.map((c) => decodeURIComponent(String(c[0])));
    const since = new Date(Date.now() - 183 * 86400_000).toISOString().slice(0, 10);
    expect(urls.find((u) => u.includes('fema.gov'))).toContain(`declarationDate ge '${since}`);
    expect(urls.find((u) => u.includes('usgs.gov'))).toContain(`starttime=${since}`);
  });

  it('PLACE-11 if a source fails the answer still comes back and says which failed', async () => {
    mockNet({ failFema: true, quakes: [{ properties: { mag: 4.2, place: 'x', time: Date.now() }, geometry: { coordinates: [-122.3, 37.6] } }] });
    const r = await suggest('94404');
    expect(r.status).toBe(200);
    expect(r.body.incident_sources.failed).toEqual(['FEMA']);
    expect(r.body.incidents).toHaveLength(1);
  });

  it('PLACE-12 results are cached so the sources are not called twice', async () => {
    const f = mockNet({ quakes: [] });
    await suggest('94404');
    const n = f.mock.calls.length;
    await suggest('94404');
    expect(f.mock.calls.length).toBe(n);
  });

  it('PLACE-13 errors: not a place 400, unknown zip 404, ambiguous 422', async () => {
    mockNet();
    expect((await suggest('hello')).status).toBe(400);
    expect((await suggest('00000')).status).toBe(404);
    const a = await suggest('Springfield, USA');
    expect(a.status).toBe(422); expect(a.body.error.code).toBe('ambiguous_city');
    expect((await suggest('Paris, France')).body.error.code).toBe('unsupported_country');
  });
});

it('PLACE-14 migration columns exist', async () => {
  const { rows } = await getPool().query("SELECT column_name FROM information_schema.columns WHERE table_name='fundraisers' AND column_name IN ('city','state','postal_code','lat','lng')");
  expect(rows).toHaveLength(5);
});
