import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { postDonation, okBody, resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

const count = async (where = 'true') =>
  Number((await getPool().query(`SELECT count(*) FROM donations WHERE ${where}`)).rows[0].count);

describe('donation intake', () => {
  it('DON-01 accepts a valid donation as pending and does not count it yet', async () => {
    const before = await count();
    const r = await postDonation(SLUGS.F1, okBody(2500), 'key-don-01-aaaa');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'pending', amount_cents: 2500, currency: 'USD', fundraiser_id: IDS.F1 });
    expect(await count()).toBe(before + 1);
  });

  it('DON-03 replays the stored response for the same key and body', async () => {
    const a = await postDonation(SLUGS.F1, okBody(), 'key-don-03-aaaa');
    const b = await postDonation(SLUGS.F1, okBody(), 'key-don-03-aaaa');
    expect(b.status).toBe(202);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect(await count(`idempotency_key = 'key-don-03-aaaa'`)).toBe(1);
  });

  it('DON-04 rejects the same key with a different body (409)', async () => {
    await postDonation(SLUGS.F1, okBody(2500), 'key-don-04-aaaa');
    const r = await postDonation(SLUGS.F1, okBody(9999), 'key-don-04-aaaa');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('idempotency_key_reused');
  });

  it('DON-06 ten parallel requests with one key create exactly one donation', async () => {
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => postDonation(SLUGS.F1, okBody(), 'key-don-06-aaaa')),
    );
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.every((r) => r.status === 202)).toBe(true);
    expect(await count(`idempotency_key = 'key-don-06-aaaa'`)).toBe(1);
  });

  it.each([0, -5, 12.5, 100_000_001, '25'])('DON-07 rejects invalid amount %s', async (amount) => {
    const r = await postDonation(SLUGS.F1, { ...okBody(), amount_cents: amount }, `key-don-07-${String(amount)}-aaaa`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'validation_failed', field: 'amount_cents' });
  });

  it('DON-10 rejects a non-USD currency with 400 on the currency field', async () => {
    const r = await postDonation(SLUGS.F1, { ...okBody(), currency: 'EUR' }, 'key-don-10-aaaa');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'validation_failed', field: 'currency' });
    expect(await count(`idempotency_key = 'key-don-10-aaaa'`)).toBe(0);
  });

  it('requires an Idempotency-Key header', async () => {
    const r = await postDonation(SLUGS.F1, okBody());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('idempotency_key_required');
  });

  it('refuses donations to removed (410) and ended (422) fundraisers', async () => {
    expect((await postDonation(SLUGS.F4, okBody(), 'key-gone-aaaa')).status).toBe(410);
    expect((await postDonation(SLUGS.F3, okBody(), 'key-ended-aaaa')).status).toBe(422);
    expect((await postDonation('no-such-slug', okBody(), 'key-404-aaaaa')).status).toBe(404);
  });

  it('API-02 uses one error envelope with a request id', async () => {
    const r = await postDonation(SLUGS.F1, { nope: true }, 'key-api-02-aaaa');
    expect(r.body.error).toEqual(
      expect.objectContaining({ code: 'validation_failed', message: expect.any(String), request_id: expect.stringMatching(/^req_/) }),
    );
  });

  it('marks the donation failed and returns 502 when the provider is down', async () => {
    const r = await postDonation(SLUGS.F1, { ...okBody(), payment_method_token: 'pm_test_down' }, 'key-down-aaaa');
    expect(r.status).toBe(502);
    expect(await count(`idempotency_key = 'key-down-aaaa' AND status = 'failed'`)).toBe(1);
    const replay = await postDonation(SLUGS.F1, { ...okBody(), payment_method_token: 'pm_test_down' }, 'key-down-aaaa');
    expect(replay.status).toBe(502);
  });
});
