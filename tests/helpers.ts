import { migrate } from '../scripts/migrate';
import { seed } from '../scripts/seed';
import { getPool } from '@/lib/db';
import { buildWebhook } from '@/lib/payments/mock';
import { LocalQueue } from '@/lib/queue';
import { pump } from '@/lib/pipeline';

let migrated = false;
export async function resetAll() {
  if (!migrated) {
    await getPool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate();
    migrated = true;
  }
  await seed();
}

export async function postDonation(ref: string, body: unknown, key?: string, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/v1/fundraisers/[ref]/donations/route');
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
  if (key) h['idempotency-key'] = key;
  const res = await POST(new Request('http://x/', { method: 'POST', headers: h, body: JSON.stringify(body) }), {
    params: Promise.resolve({ ref }),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export const okBody = (cents = 2500, extra: Record<string, unknown> = {}) => ({
  amount_cents: cents,
  currency: 'USD',
  payment_method_token: 'pm_test_ok',
  ...extra,
});

export async function webhook(type: 'payment.succeeded' | 'payment.failed' | 'payment.refunded', donationId: string, eventId?: string) {
  const { POST } = await import('@/app/api/v1/payments/webhook/route');
  const hook = buildWebhook(type, donationId, `ref_${donationId}`, eventId);
  const res = await POST(
    new Request('http://x/', { method: 'POST', headers: { 'x-signature': hook.signature }, body: hook.body }),
  );
  return { status: res.status, body: await res.json() };
}

export async function settle(queue = new LocalQueue()) {
  await pump(queue);
}

export async function statsRow(fid: string) {
  return (await getPool().query('SELECT * FROM fundraiser_stats WHERE fundraiser_id = $1', [fid])).rows[0];
}
