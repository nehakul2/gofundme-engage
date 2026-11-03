import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { createFundraiser, patchFundraiser, getFundraiserVersion } from '@/lib/fundraisers';
import { verifyPending } from '@/lib/verify';
import { getStats } from '@/lib/stats';
import type { PaymentProvider } from '@/lib/payments/types';
import { okBody, postDonation, resetAll, settle } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

const NEW = { title: 'Rebuild the library', story: 'Books and shelves.', goal_cents: 100_000 };

describe('fundraiser create and edit', () => {
  it('INT-07 create returns the created object, ready to use', async () => {
    const f = await createFundraiser(IDS.U5, NEW);
    expect(f).toMatchObject({ title: NEW.title, slug: 'rebuild-the-library', status: 'active', version: 1, currency: 'USD', owner_id: IDS.U5 });
    expect((await getStats(f.slug)).raised_cents).toBe(0); // readable at once
    expect((await postDonation(f.slug, okBody(), 'int07-key-aaaa')).status).toBe(202); // and accepts donations
  });

  it('gives duplicate titles distinct slugs and can create a draft', async () => {
    const a = await createFundraiser(IDS.U5, NEW);
    const b = await createFundraiser(IDS.U5, { ...NEW, publish: false });
    expect(b.slug).not.toBe(a.slug);
    expect(b.status).toBe('draft');
    expect((await postDonation(b.slug, okBody(), 'draft-key-aaaa')).status).toBe(422);
  });

  it('rejects bad input with a field name', async () => {
    await expect(createFundraiser(IDS.U5, { ...NEW, goal_cents: 12.5 })).rejects.toMatchObject({ status: 400, field: 'goal_cents' });
    await expect(createFundraiser(IDS.U5, { ...NEW, title: 'x' })).rejects.toMatchObject({ status: 400, field: 'title' });
  });

  it('API-05 PATCH without If-Match is 428', async () => {
    await expect(patchFundraiser(SLUGS.F1, IDS.U1, null, { title: 'New title' })).rejects.toMatchObject({ status: 428, code: 'precondition_required' });
  });

  it('PATCH with the current version succeeds and bumps the version', async () => {
    const f = await patchFundraiser(SLUGS.F1, IDS.U1, '"v1"', { title: 'Wildfire alerts, updated' });
    expect(f).toMatchObject({ title: 'Wildfire alerts, updated', version: 2 });
  });

  it('a stale If-Match is 412 and carries the current ETag; two simultaneous edits cannot both win', async () => {
    await patchFundraiser(SLUGS.F1, IDS.U1, '"v1"', { title: 'First' });
    await expect(patchFundraiser(SLUGS.F1, IDS.U1, '"v1"', { title: 'Second' })).rejects.toMatchObject({ status: 412, headers: { etag: '"v2"' } });

    const results = await Promise.allSettled([
      patchFundraiser(SLUGS.F1, IDS.U1, '"v2"', { story: 'A' }),
      patchFundraiser(SLUGS.F1, IDS.U1, '"v2"', { story: 'B' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await getFundraiserVersion(SLUGS.F1)).version).toBe(3);
  });

  it('only the owner can edit; the goal cannot drop below what is raised; status moves forward only', async () => {
    await expect(patchFundraiser(SLUGS.F1, IDS.U2, '"v1"', { title: 'Hijack' })).rejects.toMatchObject({ status: 403 });
    await expect(patchFundraiser(SLUGS.F2, IDS.U1, '"v1"', { goal_cents: 1_000_000 })).rejects.toMatchObject({ status: 422, code: 'goal_below_raised' });
    await expect(patchFundraiser(SLUGS.F3, IDS.U1, '"v1"', { status: 'active' })).rejects.toMatchObject({ status: 422, code: 'invalid_transition' });
    await expect(patchFundraiser(SLUGS.F1, IDS.U1, '"v1"', { slug: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(patchFundraiser(SLUGS.F1, IDS.U1, 'garbage', { title: 'Fine title' })).rejects.toMatchObject({ status: 400 });
    expect((await patchFundraiser(SLUGS.F1, IDS.U1, '"v1"', { status: 'ended' })).status).toBe('ended');
  });
});

describe('pending donations that never settle (PAY-10, PAY-11)', () => {
  const hoursAgo = (id: string, h: number) =>
    getPool().query("UPDATE donations SET created_at = now() - $2::int * interval '1 hour' WHERE id = $1", [id, h]);
  const status = async (id: string) => (await getPool().query('SELECT status FROM donations WHERE id = $1', [id])).rows[0].status;
  const stuck = async (token = 'pm_test_lost_webhook', key = Math.random().toString(36).slice(2) + 'aaaaaaaa') =>
    (await postDonation(SLUGS.F1, { ...okBody(), payment_method_token: token }, key)).body.id as string;

  it('PAY-10 after 24 h asks the provider and settles a donation whose webhook was lost', async () => {
    const id = await stuck();
    expect(await verifyPending()).toMatchObject({ checked: 0 }); // too young
    await hoursAgo(id, 25);
    expect(await verifyPending()).toEqual({ checked: 1, settled: 1, expired: 0 });
    await settle();
    expect(await status(id)).toBe('succeeded');
    expect(await getStats(SLUGS.F1)).toMatchObject({ raised_cents: 2500, donor_count: 1 });
    expect(await verifyPending()).toMatchObject({ checked: 0 }); // nothing left to check
  });

  it('settles as failed when the provider says the charge failed', async () => {
    const id = await stuck('pm_test_decline'); // mock provider records a failure; its webhook is off in tests
    await hoursAgo(id, 30);
    await verifyPending();
    expect(await status(id)).toBe('failed');
  });

  it('PAY-11 a donation still unknown at 48 h is closed as failed and never counted', async () => {
    const silent: PaymentProvider = { createCharge: async () => ({ providerRef: 'x' }), getCharge: async () => 'pending' };
    const id = await stuck();
    await hoursAgo(id, 25);
    expect(await verifyPending(new Date(), silent)).toEqual({ checked: 1, settled: 0, expired: 0 });
    expect(await status(id)).toBe('pending');
    expect((await getPool().query('SELECT last_verified_at FROM donations WHERE id = $1', [id])).rows[0].last_verified_at).not.toBeNull();
    await hoursAgo(id, 49);
    expect(await verifyPending(new Date(), silent)).toEqual({ checked: 1, settled: 0, expired: 1 });
    await settle();
    expect(await status(id)).toBe('failed');
    expect(await getStats(SLUGS.F1)).toMatchObject({ raised_cents: 0, donor_count: 0 });
  });

  it('a provider outage leaves the donation pending for the next run', async () => {
    const down: PaymentProvider = { createCharge: async () => ({ providerRef: 'x' }), getCharge: async () => { throw new Error('down'); } };
    const id = await stuck();
    await hoursAgo(id, 60);
    expect(await verifyPending(new Date(), down)).toMatchObject({ settled: 0, expired: 0 });
    expect(await status(id)).toBe('pending');
  });
});
