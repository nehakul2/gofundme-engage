import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { COMMUNITY_LIMIT } from '@/lib/communities';
import { getCommunityPage } from '@/lib/read';
import { communityIntent, startIntent } from '@/lib/intent';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

function req(method: string, body?: unknown, user: string | null = IDS.U2) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user) headers['x-user-id'] = user;
  return new Request('http://x/', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function out(res: Response) { return { status: res.status, body: await res.json() }; }
const create = async (body: unknown, user: string | null = IDS.U2) => out(await (await import('@/app/api/v1/communities/route')).POST(req('POST', body, user)));
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const members = async (m: 'POST' | 'DELETE', slug: string, user: string | null = IDS.U2) => {
  const r = await import('@/app/api/v1/communities/[slug]/members/route');
  return out(await r[m](req(m, undefined, user), ctx(slug)));
};
const addFr = async (slug: string, fundraiser: unknown, user: string | null = IDS.U1) => {
  const { POST } = await import('@/app/api/v1/communities/[slug]/fundraisers/route');
  return out(await POST(req('POST', { fundraiser }, user), ctx(slug)));
};
const mine = async (slug: string, user: string | null = IDS.U1) => {
  const { GET } = await import('@/app/api/v1/communities/[slug]/me/route');
  return out(await GET(req('GET', undefined, user), ctx(slug)));
};
const good = { name: 'Foster City Parents', description: 'Parents supporting local schools' };

describe('COMM: starting a community', () => {
  it('COMM-01 a signed-in user creates a community and becomes its owner and first member', async () => {
    const r = await create(good);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slug: 'foster-city-parents', name: 'Foster City Parents', created_by: IDS.U2 });
    const page = await getCommunityPage('foster-city-parents');
    expect(page.member_count).toBe(1);
    expect(page.members[0]).toMatchObject({ handle: 'donor-dan', role: 'owner' });
  });

  it('COMM-02 guests and unknown users cannot create', async () => {
    expect((await create(good, null)).status).toBe(401);
    expect((await create(good, '01930000-0000-7000-8000-0001000000ff')).status).toBe(401);
    expect((await getPool().query("SELECT 1 FROM communities WHERE slug = 'foster-city-parents'")).rowCount).toBe(0);
  });

  it('COMM-03 short names and long descriptions are rejected with the field named', async () => {
    expect(await create({ ...good, name: 'ab' })).toMatchObject({ status: 400, body: { error: { field: 'name' } } });
    expect(await create({ ...good, description: 'x'.repeat(281) })).toMatchObject({ status: 400, body: { error: { field: 'description' } } });
  });

  it('COMM-04 a taken name still gets its own address', async () => {
    const a = await create(good, IDS.U2);
    const b = await create(good, IDS.U3);
    expect(a.body.slug).toBe('foster-city-parents');
    expect(b.status).toBe(201);
    expect(b.body.slug).not.toBe(a.body.slug);
    expect(b.body.slug).toMatch(/^foster-city-parents-/);
  });

  it('COMM-05 creating too many communities in an hour is limited with Retry-After', async () => {
    for (let i = 0; i < COMMUNITY_LIMIT; i++) expect((await create({ name: `Group number ${i}` })).status).toBe(201);
    const over = await create({ name: 'One more group' });
    expect(over.status).toBe(429);
  });
});

describe('COMM: joining and leaving', () => {
  it('COMM-06 joining is idempotent and shows in the member count', async () => {
    const before = (await getCommunityPage(SLUGS.C2)).member_count;
    expect(await members('POST', SLUGS.C2)).toMatchObject({ status: 200, body: { member: true, changed: true } });
    expect(await members('POST', SLUGS.C2)).toMatchObject({ body: { member: true, changed: false } });
    expect((await getCommunityPage(SLUGS.C2)).member_count).toBe(before + 1);
  });

  it('COMM-07 leaving works, and the owner cannot leave', async () => {
    await members('POST', SLUGS.C2, IDS.U3);
    expect(await members('DELETE', SLUGS.C2, IDS.U3)).toMatchObject({ body: { member: false, changed: true } });
    // U1 created the seeded communities but is not a member row; make them the owner and try to leave
    await getPool().query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1,$2,'owner')", [IDS.C2, IDS.U1]);
    expect(await members('DELETE', SLUGS.C2, IDS.U1)).toMatchObject({ status: 422, body: { error: { code: 'owner_cannot_leave' } } });
  });

  it('COMM-08 guests cannot join and unknown communities return 404', async () => {
    expect((await members('POST', SLUGS.C2, null)).status).toBe(401);
    expect((await members('POST', 'no-such-community')).status).toBe(404);
  });
});

describe('COMM: listing fundraisers in a community', () => {
  it('COMM-09 a member adds their own fundraiser and the community page shows it', async () => {
    await members('POST', SLUGS.C2, IDS.U1);
    const r = await addFr(SLUGS.C2, SLUGS.F1);
    expect(r).toMatchObject({ status: 200, body: { added: true, changed: true } });
    expect((await addFr(SLUGS.C2, SLUGS.F1)).body.changed).toBe(false);
    expect((await getCommunityPage(SLUGS.C2)).fundraisers.map((f) => f.slug)).toContain(SLUGS.F1);
  });

  it('COMM-10 non-members, other people’s fundraisers and removed fundraisers are refused', async () => {
    expect((await addFr(SLUGS.C2, SLUGS.F1, IDS.U1)).status).toBe(403);            // not a member yet
    await members('POST', SLUGS.C2, IDS.U2);
    expect((await addFr(SLUGS.C2, SLUGS.F1, IDS.U2)).status).toBe(403);            // F1 belongs to U1
    await members('POST', SLUGS.C2, IDS.U1);
    expect((await addFr(SLUGS.C2, SLUGS.F4, IDS.U1)).status).toBe(404);            // removed
    expect((await addFr(SLUGS.C2, '', IDS.U1)).status).toBe(400);
  });

  it('COMM-11 the viewer state lists what a member can still add', async () => {
    expect(await mine(SLUGS.C2, null)).toMatchObject({ body: { member: false, can_add: [] } });
    expect((await mine(SLUGS.C2, IDS.U1)).body).toMatchObject({ member: false, can_add: [] });
    await members('POST', SLUGS.C2, IDS.U1);
    const before = (await mine(SLUGS.C2, IDS.U1)).body;
    expect(before.member).toBe(true);
    expect(before.can_add.map((f: { slug: string }) => f.slug)).toEqual(expect.arrayContaining([SLUGS.F1, SLUGS.F2]));
    expect(before.can_add.map((f: { slug: string }) => f.slug)).not.toContain(SLUGS.F4);
    await addFr(SLUGS.C2, SLUGS.F1);
    expect((await mine(SLUGS.C2, IDS.U1)).body.can_add.map((f: { slug: string }) => f.slug)).not.toContain(SLUGS.F1);
  });
});

describe('COMM: finding a community and the chat intent', () => {
  it('COMM-12 chat phrases that mean "start a community" are recognised with their topic', () => {
    expect(communityIntent('Start a community for Foster City parents')).toEqual({ topic: 'Foster City parents' });
    expect(communityIntent('can we create a new group called Reading Buddies')).toEqual({ topic: 'Reading Buddies' });
    expect(communityIntent('I want to start a community')).toEqual({ topic: '' });
  });

  it('COMM-13 fundraiser phrases and plain searches are not mistaken for a community', () => {
    expect(communityIntent('start a fundraiser for community garden')).toBeNull();
    expect(startIntent('start a fundraiser for community garden')).toEqual({ topic: 'community garden' });
    expect(communityIntent('make a fundraiser for the parents group')).toBeNull();
    expect(communityIntent('do we have a community for wildfire')).toBeNull();
    expect(communityIntent('wildfire')).toBeNull();
  });

  it('COMM-14 search finds communities by every word in the name or description', async () => {
    const { GET } = await import('@/app/api/v1/communities/route');
    const find = async (q: string) => (await out(await GET(new Request(`http://x/?q=${encodeURIComponent(q)}`)))).body.results.map((c: { slug: string }) => c.slug);
    expect(await find('watch duty')).toEqual([SLUGS.C1]);
    expect(await find('wildfire watchers')).toEqual([SLUGS.C1]);
    expect(await find('nothing matches this')).toEqual([]);
    expect(await find('')).toEqual([]);
    await create(good);
    expect(await find('foster parents')).toEqual(['foster-city-parents']);
  });
});
