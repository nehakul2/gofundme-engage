import { getPool } from './db';
import { getPayments } from './payments/mock';
import type { PaymentProvider } from './payments/types';
import { processEvent } from './webhook';

export const VERIFY_AFTER_HOURS = 24; // ask the provider once a donation has been pending this long
export const EXPIRE_AFTER_HOURS = 48; // give up on a donation still pending after this long

export interface VerifyResult { checked: number; settled: number; expired: number }

// Pending donations whose webhook never arrived. After 24 h we ask the provider what happened
// and apply the answer through the same transition code a webhook uses. Anything still
// pending after 48 h is closed as failed. A pending donation is never counted.
export async function verifyPending(
  now: Date = new Date(),
  provider: PaymentProvider = getPayments(),
): Promise<VerifyResult> {
  const pool = getPool();
  const due = await pool.query(
    `SELECT id, provider_ref, created_at FROM donations
      WHERE status = 'pending' AND created_at <= $1::timestamptz - $2::int * interval '1 hour'
      ORDER BY created_at LIMIT 500`,
    [now, VERIFY_AFTER_HOURS],
  );
  const result: VerifyResult = { checked: 0, settled: 0, expired: 0 };
  for (const d of due.rows) {
    result.checked++;
    let status: Awaited<ReturnType<PaymentProvider['getCharge']>> = 'unknown';
    if (d.provider_ref) {
      try { status = await provider.getCharge(d.provider_ref); } catch { /* provider down: retry next run */ continue; }
    }
    if (status === 'succeeded' || status === 'failed') {
      const out = await processEvent({
        type: status === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
        donation_id: d.id,
        provider_ref: d.provider_ref ?? undefined,
      });
      if (out.result !== 'noop') result.settled++;
      continue;
    }
    const ageHours = (now.getTime() - new Date(d.created_at).getTime()) / 3_600_000;
    if (ageHours >= EXPIRE_AFTER_HOURS) {
      const u = await pool.query("UPDATE donations SET status = 'failed', last_verified_at = $2 WHERE id = $1 AND status = 'pending'", [d.id, now]);
      result.expired += u.rowCount ?? 0;
    } else {
      await pool.query('UPDATE donations SET last_verified_at = $2 WHERE id = $1 AND status = $3', [d.id, now, 'pending']);
    }
  }
  return result;
}
