import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis, getRedis, keys } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { LocalQueue } from '@/lib/queue';
import { applyDonationEvent, reconcile } from '@/lib/counters';
import { getStats } from '@/lib/stats';
import { buildWebhook } from '@/lib/payments/mock';
import { handleWebhook } from '@/lib/webhook';
import { postDonation, okBody, resetAll, settle, statsRow, webhook } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

const status = async (id: string) =>
  (await getPool().query('SELECT status FROM donations WHERE id = $1', [id])).rows[0].status;

async function pending(cents = 2500, key = Math.random().toString(36).slice(2) + 'aaaaaaaa', fr: string = SLUGS.F1) {
  return (await postDonation(fr, okBody(cents), key)).body.id as string;
}

describe('webhooks', () => {
  it('PAY-02 a success webhook settles the donation and the counters', async () => {
    const id = await pending(2500);
    expect((await webhook('payment.succeeded', id)).body.result).toBe('succeeded');
    await settle();
    expect(await status(id)).toBe('succeeded');
    const s = await getStats(SLUGS.F1);
    expect(s).toMatchObject({ raised_cents: 2500, donor_count: 1 });
    expect((await statsRow(IDS.F1)).raised_cents).toBe(2500);
  });

  it('PAY-03 a failed payment is never counted', async () => {
    const id = await pending(2500);
    await webhook('payment.failed', id);
    await settle();
    expect(await status(id)).toBe('failed');
    expect(await getStats(SLUGS.F1)).toMatchObject({ raised_cents: 0, donor_count: 0 });
  });

  it('PAY-04 the same webhook delivered twice counts once', async () => {
    const id = await pending(2500);
    const a = await webhook('payment.succeeded', id, 'evt-1');
    const b = await webhook('payment.succeeded', id, 'evt-1');
    expect([a.body.result, b.body.result]).toEqual(['succeeded', 'noop']);
    await settle();
    expect(await getStats(SLUGS.F1)).toMatchObject({ raised_cents: 2500, donor_count: 1 });
  });

  it('PAY-05 a refund after success reverses the counters', async () => {
    const id = await pending(2500);
    await webhook('payment.succeeded', id);
    await settle();
    expect((await webhook('payment.refunded', id)).body.result).toBe('refunded');
    await settle();
    expect(await status(id)).toBe('refunded');
    expect(await getStats(SLUGS.F1)).toMatchObject({ raised_cents: 0, donor_count: 0 });
  });

  it('PAY-06 a refund that arrives first wins; the late success is ignored', async () => {
    const id = await pending(2500);
    await webhook('payment.refunded', id);
    expect((await webhook('payment.succeeded', id)).body.result).toBe('noop');
    await settle();
    expect(await status(id)).toBe('refunded');
    expect(await getStats(SLUGS.F1)).toMatchObject({ raised_cents: 0, donor_count: 0 });
  });

  it('rejects a bad signature (401) and acks an unknown donation (200)', async () => {
    const hook = buildWebhook('payment.succeeded', IDS.F1);
    await expect(handleWebhook(hook.body, 'sha256=deadbeef')).rejects.toMatchObject({ status: 401 });
    expect((await webhook('payment.succeeded', '01930000-0000-7000-8000-ffffffffffff')).body.result).toBe(
      'ignored_unknown_donation',
    );
  });
});

describe('counters', () => {
  it('CNT-01 stats reflect a settled donation at once', async () => {
    const id = await pending(1234);
    await webhook('payment.succeeded', id);
    await settle();
    expect(await getStats(IDS.F1)).toMatchObject({ raised_cents: 1234, donor_count: 1, percent_of_goal: 0 });
  });

  it('CNT-03 fifty concurrent donations add up exactly', async () => {
    const ids = await Promise.all(Array.from({ length: 50 }, (_, i) => pending(100 + i, `cnt03-key-${i}-aaaa`)));
    await Promise.all(ids.map((id) => webhook('payment.succeeded', id)));
    await settle();
    const expected = Array.from({ length: 50 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0);
    expect(await getStats(IDS.F1)).toMatchObject({ raised_cents: expected, donor_count: 50 });
    expect((await statsRow(IDS.F1)).raised_cents).toBe(expected);
  });

  it('CNT-04 a redelivered queue event is applied once', async () => {
    const ev = { eventId: 'evt-x', fundraiserId: IDS.F1, amountCents: 700, donorDelta: 1 as const };
    expect(await applyDonationEvent(ev)).toBe(true);
    expect(await applyDonationEvent(ev)).toBe(false);
    expect(Number(await getRedis().hget(keys.stats(IDS.F1), 'raised_cents'))).toBe(700);
  });

  it('CNT-10 reconcile repairs drift from the ledger after Redis is wiped', async () => {
    const id = await pending(2500);
    await webhook('payment.succeeded', id);
    await settle();
    await getRedis().flushdb();
    await getPool().query('UPDATE fundraiser_stats SET raised_cents = 1 WHERE fundraiser_id = $1', [IDS.F1]);
    expect(await reconcile(IDS.F1)).toEqual({ raised_cents: 2500, donor_count: 1 });
    expect(await getStats(IDS.F1)).toMatchObject({ raised_cents: 2500, donor_count: 1 });
    expect((await statsRow(IDS.F1)).raised_cents).toBe(2500);
  });

  it('a dropped queue (new LocalQueue each pump) still settles from the outbox', async () => {
    const id = await pending(500);
    await webhook('payment.succeeded', id);
    await settle(new LocalQueue());
    expect(await getStats(IDS.F1)).toMatchObject({ raised_cents: 500 });
  });
});
