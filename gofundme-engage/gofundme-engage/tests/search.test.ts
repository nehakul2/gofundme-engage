import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { uuidv7 } from '@/lib/ids';
import { likePattern, searchFundraisers } from '@/lib/search';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

async function addFundraiser(slug: string, title: string, status: string, story = 'A story', owner = IDS.U1) {
  await getPool().query(
    `INSERT INTO fundraisers (id, owner_id, slug, title, story, goal_cents, status) VALUES ($1,$2,$3,$4,$5,100000,$6)`,
    [uuidv7(), owner, slug, title, story, status],
  );
}

describe('SRCH: finding a fundraiser', () => {
  it('SRCH-01 finds a fundraiser by title, case-insensitively, and says it can take donations', async () => {
    const out = await searchFundraisers('WILDFIRE');
    expect(out.count).toBe(1);
    expect(out.results[0]).toMatchObject({
      slug: SLUGS.F1, title: 'Wildfire alerts for everyone', owner_name: 'Olivia Owner', status: 'active',
      can_contribute: true, contribute_note: null,
    });
  });

  it('SRCH-02 an ended fundraiser is found but cannot take donations, with a reason', async () => {
    const out = await searchFundraisers('ended campaign');
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ slug: SLUGS.F3, status: 'ended', can_contribute: false });
    expect(out.results[0].contribute_note).toMatch(/ended/i);
  });

  it('SRCH-03 drafts and removed fundraisers never appear', async () => {
    await addFundraiser('secret-draft', 'Secret draft fundraiser', 'draft');
    expect((await searchFundraisers('secret')).count).toBe(0);
    expect((await searchFundraisers('removed')).count).toBe(0);
  });

  it('SRCH-04 matches the story, the organizer name and the slug', async () => {
    await addFundraiser('bridge-repair', 'Fix the bridge', 'active', 'The old footbridge washed away in March');
    expect((await searchFundraisers('footbridge')).results.map((r) => r.slug)).toEqual(['bridge-repair']);
    expect((await searchFundraisers('olivia owner')).count).toBe(5 - 1); // all four public + the new one, minus the removed one
    expect((await searchFundraisers('near-goal')).results[0].slug).toBe(SLUGS.F2);
  });

  it('SRCH-05 every word must match (AND), in any order', async () => {
    expect((await searchFundraisers('alerts wildfire')).count).toBe(1);
    expect((await searchFundraisers('wildfire bridge')).count).toBe(0);
  });

  it('SRCH-06 title matches rank first, then active before ended', async () => {
    await addFundraiser('story-mention', 'Unrelated title', 'active', 'Mentions campaign in the story');
    const out = await searchFundraisers('campaign');
    expect(out.results[0].slug).toBe(SLUGS.F3);          // title match wins even though it is ended
    expect(out.results.map((r) => r.slug)).toContain('story-mention');
  });

  it('SRCH-07 wildcard characters are searched literally', async () => {
    await addFundraiser('half-way', '50% of the way', 'active');
    expect((await searchFundraisers('50%')).results.map((r) => r.slug)).toEqual(['half-way']);
    expect((await searchFundraisers('%%')).count).toBe(0);
    // _ is not a wildcard: it is never an exact match; the typo fallback may still offer "Wildfire" as close
    const w = await searchFundraisers('w_ldfire');
    expect(w.count === 0 || w.approximate).toBe(true);
    expect(likePattern('a%b_c\\')).toBe('%a\\%b\\_c\\\\%');
  });

  it('SRCH-08 reports raised amount and progress', async () => {
    const out = await searchFundraisers('almost there');
    expect(out.results[0]).toMatchObject({ slug: SLUGS.F2, raised_cents: 4_999_000, donor_count: 1, percent_of_goal: 99 });
  });

  it('SRCH-09 a query with no match returns an empty list, not an error', async () => {
    expect(await searchFundraisers('zzzz-nothing')).toEqual({ query: 'zzzz-nothing', count: 0, approximate: false, results: [] });
  });

  it('SRCH-10 rejects short, empty and missing queries; clamps the limit', async () => {
    for (const q of ['', 'a', '   ', null, undefined, 'x'.repeat(101)]) {
      await expect(searchFundraisers(q)).rejects.toMatchObject({ status: 400, code: 'validation_failed', field: 'q' });
    }
    await addFundraiser('one', 'Alpha fund', 'active');
    await addFundraiser('two', 'Alpha trust', 'active');
    expect((await searchFundraisers('alpha', 1)).count).toBe(1);
    expect((await searchFundraisers('alpha', 'abc')).count).toBe(2);
    expect((await searchFundraisers('alpha', -5)).count).toBe(1);
  });

  it('SRCH-11 the HTTP route returns the same shape and a short cache header', async () => {
    const { GET } = await import('@/app/api/v1/search/route');
    const ok = await GET(new Request('http://x/api/v1/search?q=wildfire'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('max-age=5');
    expect((await ok.json()).results[0].slug).toBe(SLUGS.F1);
    const bad = await GET(new Request('http://x/api/v1/search?q=a'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.field).toBe('q');
  });
});

describe('SRCH: asking in plain words and misspelling', () => {
  const add = () => addFundraiser('foster-reading', 'Foster City school district reading program', 'active', 'New books for classroom libraries');

  it('SRCH-12 a question like "do we have a fundraiser for ..." finds it by the words that matter', async () => {
    await add();
    const out = await searchFundraisers('do we have a fundraiser for foster city school district reading program');
    expect(out.results.map((r) => r.slug)).toEqual(['foster-reading']);
    expect(out.approximate).toBe(false);
  });

  it('SRCH-13 a misspelled word still finds it and says the match is approximate', async () => {
    await add();
    const out = await searchFundraisers('do we have a fundraiser for foster city school district reading progrm');
    expect(out.results.map((r) => r.slug)).toEqual(['foster-reading']);
    expect(out.approximate).toBe(true);
    expect(out.results[0].can_contribute).toBe(true);
  });

  it('SRCH-16 "fund raiser" spelled as two words is treated like "fundraiser"', async () => {
    await add();
    const out = await searchFundraisers('do we have a fund raiser for foster city school district reading progrm');
    expect(out.results.map((r) => r.slug)).toEqual(['foster-reading']);
  });

  it('SRCH-14 nonsense still returns nothing, and exact results are never marked approximate', async () => {
    await add();
    const none = await searchFundraisers('zzzzqq qqzzzz');
    expect(none).toMatchObject({ count: 0, approximate: false });
    expect((await searchFundraisers('foster')).approximate).toBe(false);
  });

  it('SRCH-15 one wrong word out of several does not hide a good match, but unrelated fundraisers stay out', async () => {
    await add();
    const out = await searchFundraisers('foster city school lunch');
    expect(out.results.map((r) => r.slug)).toEqual(['foster-reading']);
    const miss = await searchFundraisers('foster zebra yodel');
    expect(miss.results.map((r) => r.slug)).not.toContain(SLUGS.F1);
  });
});
