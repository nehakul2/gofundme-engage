import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS, GOAL_CENTS } from '@/fixtures';
import { addWord } from '@/lib/moderation';
import { patchFundraiser } from '@/lib/fundraisers';
import { getCommunityPage } from '@/lib/read';
import { listDonations } from '@/lib/donations';
import { okBody, postDonation, resetAll, settle, webhook } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

const q = async (sql: string, p: unknown[] = []) => (await getPool().query(sql, p)).rows;
let n = 0;
const key = () => `enh-key-${++n}-${Date.now()}-xxxx`;

describe('SUP: supporter notes and names follow the blocked-word list', () => {
  it('SUP-01 a blocked word in the note is refused before any donation is created', async () => {
    await addWord({ word: 'haters' });
    const r = await postDonation(SLUGS.F1, okBody(2500, { message: 'Down with the Haters!' }), key());
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'text_blocked', field: 'message' });
    expect(r.body.error.message).toContain('haters');
    expect(await q('SELECT 1 FROM donations WHERE fundraiser_id = $1 AND status <> $2', [IDS.F1, 'succeeded'])).toHaveLength(0);
    expect(await q('SELECT 1 FROM outbox_events WHERE event_type = $1', ['donation.created'])).toHaveLength(0);
  });

  it('SUP-02 a blocked word in the name a guest types is refused too', async () => {
    await addWord({ word: 'haters' });
    const r = await postDonation(SLUGS.F1, okBody(2500, { display_name: 'haters inc' }), key());
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'text_blocked', field: 'name' });
  });

  it('SUP-03 a clean note goes through and shows in the supporter list; the list can be widened to 50', async () => {
    const r = await postDonation(SLUGS.F1, okBody(2500, { message: 'Proud to help', display_name: 'Priya' }), key());
    expect(r.status).toBeLessThan(300);
    await webhook('payment.succeeded', r.body.id);
    await settle();
    const list = await listDonations(SLUGS.F1, 50);
    expect(list[0]).toMatchObject({ message: 'Proud to help', display_name: 'Priya' });
    expect((await listDonations(SLUGS.F3, 50)).length).toBe(12); // F3 has 12 seeded donations: all of them come back at limit 50
    expect((await listDonations(SLUGS.F3, 10)).length).toBe(10);
  });
});

describe('GOAL: changing the goal', () => {
  it('GOAL-01 the organizer raises the goal; the version moves on and the new goal shows', async () => {
    const row = await patchFundraiser(SLUGS.F1, IDS.U1, '"v1"', { goal_cents: GOAL_CENTS * 2 });
    expect(Number(row.goal_cents)).toBe(GOAL_CENTS * 2);
    expect(row.version).toBe(2);
  });

  it('GOAL-02 the goal cannot go below $1 or below what has been raised', async () => {
    await expect(patchFundraiser(SLUGS.F1, IDS.U1, '"v1"', { goal_cents: 50 })).rejects.toMatchObject({ status: 400 });
    await expect(patchFundraiser(SLUGS.F2, IDS.U1, '"v1"', { goal_cents: 1_000_000 })).rejects.toMatchObject({ status: 422, code: 'goal_below_raised' });
  });

  it('GOAL-03 only the organizer, and only with the current version', async () => {
    await expect(patchFundraiser(SLUGS.F1, IDS.U2, '"v1"', { goal_cents: 200_000 })).rejects.toMatchObject({ status: 403 });
    await patchFundraiser(SLUGS.F1, IDS.U1, '"v1"', { goal_cents: 200_000 });
    await expect(patchFundraiser(SLUGS.F1, IDS.U1, '"v1"', { goal_cents: 300_000 })).rejects.toMatchObject({ status: 412 });
  });
});

describe('BAN: what the community banner reads', () => {
  it('BAN-01 the community page reports money raised, update count and members, and they move as things happen', async () => {
    const before = await getCommunityPage(SLUGS.C1);
    expect(before.fundraisers.length).toBe(3);
    const raised = before.fundraisers.reduce((s, f) => s + Number(f.raised_cents), 0);
    expect(before.raised_cents).toBe(raised);

    const r = await postDonation(SLUGS.F1, okBody(5000), key());
    await webhook('payment.succeeded', r.body.id);
    await settle();
    const after = await getCommunityPage(SLUGS.C1);
    expect(after.raised_cents).toBe(raised + 5000);
    expect(after.post_count).toBeGreaterThanOrEqual(before.post_count);
    expect(after.member_count).toBe(before.member_count);
  });
});
