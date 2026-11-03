import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS } from '@/fixtures';
import { CREATE_LIMIT } from '@/lib/fundraisers';
import { parseGoalCents } from '@/lib/goal';
import { searchFundraisers } from '@/lib/search';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

async function create(body: unknown, user: string | null = IDS.U2) {
  const { POST } = await import('@/app/api/v1/fundraisers/route');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user) headers['x-user-id'] = user;
  const res = await POST(new Request('http://x/', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const good = { title: 'Help rebuild the community garden', story: 'The storm took our garden beds. Funds buy soil and tools.', goal_cents: 500_000 };

describe('MAKE: starting a fundraiser from the chat', () => {
  it('MAKE-01 a signed-in user creates a live fundraiser that search then finds', async () => {
    const r = await create(good);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ owner_id: IDS.U2, status: 'active', goal_cents: 500_000, slug: 'help-rebuild-the-community-garden' });
    expect(r.headers.get('location')).toBe('/api/v1/fundraisers/help-rebuild-the-community-garden');
    const found = await searchFundraisers('community garden');
    expect(found.results[0]).toMatchObject({ slug: 'help-rebuild-the-community-garden', can_contribute: true, raised_cents: 0, owner_handle: 'donor-dan' });
    const stats = await getPool().query('SELECT raised_cents FROM fundraiser_stats WHERE fundraiser_id = $1', [r.body.id]);
    expect(stats.rows).toHaveLength(1);
  });

  it('MAKE-02 guests and unknown users cannot create', async () => {
    expect((await create(good, null)).status).toBe(401);
    expect((await create(good, '01930000-0000-7000-8000-0001000000ff')).status).toBe(401);
    expect((await getPool().query("SELECT 1 FROM fundraisers WHERE slug = 'help-rebuild-the-community-garden'")).rowCount).toBe(0);
  });

  it('MAKE-03 bad titles, goals and stories are rejected with the field named', async () => {
    expect(await create({ ...good, title: 'ab' })).toMatchObject({ status: 400, body: { error: { field: 'title' } } });
    expect(await create({ ...good, goal_cents: 50 })).toMatchObject({ status: 400, body: { error: { field: 'goal_cents' } } });
    expect(await create({ ...good, story: '   ' })).toMatchObject({ status: 400, body: { error: { field: 'story' } } });
  });

  it('MAKE-04 two fundraisers with the same title get different addresses', async () => {
    const a = await create(good); const b = await create(good, IDS.U3);
    expect(a.body.slug).toBe('help-rebuild-the-community-garden');
    expect(b.body.slug).not.toBe(a.body.slug);
    expect(b.body.slug).toMatch(/^help-rebuild-the-community-garden-[a-z0-9]{4}$/);
  });

  it('MAKE-05 each user can start only a few per hour', async () => {
    for (let i = 0; i < CREATE_LIMIT; i++) expect((await create({ ...good, title: `Garden fund number ${i}` })).status).toBe(201);
    const over = await create({ ...good, title: 'One too many' });
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBeTruthy();
    expect((await create({ ...good, title: 'Someone else' }, IDS.U3)).status).toBe(201);
  });
});

describe('MAKE: reading a goal the way people type it', () => {
  it('MAKE-06 accepts plain, dollar, comma, decimal and k/m forms', () => {
    const ok: [string, number][] = [['5000', 500_000], ['$5,000', 500_000], [' 2.5k ', 250_000], ['1m', 100_000_000], ['12.50', 1250], ['$1', 100], ['100 dollars', 10_000], ['.5k', 50_000]];
    for (const [input, cents] of ok) expect(parseGoalCents(input), input).toBe(cents);
  });

  it('MAKE-07 rejects words, zero, negatives, under $1 and over the limit', () => {
    for (const bad of ['', 'lots', '0', '-5', '$0.50', '5 000', '1e6', '1.234', '$', '2000000000']) expect(parseGoalCents(bad), bad).toBeNull();
  });
});

import { startIntent } from '@/lib/intent';
describe('MAKE: understanding "start a fundraiser for ..." in the chat', () => {
  it('MAKE-08 pulls the topic out of a start request', () => {
    const cases: [string, string][] = [
      ['Start a fundraiser for Foster city school district reading program', 'Foster city school district reading program'],
      ['I want to create a fundraiser for the animal shelter', 'animal shelter'],
      ['can I start a campaign to help flood victims', 'flood victims'],
      ['Let\'s launch a new fundraiser about clean water.', 'clean water'],
      ['start a fundraiser', ''],
      ['create fundraiser', ''],
    ];
    for (const [input, topic] of cases) expect(startIntent(input), input).toEqual({ topic });
  });

  it('MAKE-09 ordinary searches are left alone', () => {
    for (const q of ['wildfire', 'school', 'raise awareness', 'make a wish', 'start', 'campaign', 'do we have a fundraiser for foster city', 'is there a campaign for the animal shelter', 'any fund raiser about flood relief?']) expect(startIntent(q), q).toBeNull();
  });
});
