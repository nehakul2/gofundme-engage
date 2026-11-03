import { z } from 'zod';
import { withTx } from './db';
import { ApiError } from './errors';
import { emit } from './outbox';
import { verifySignature } from './payments/signature';

const EventSchema = z.object({
  event_id: z.string().min(1),
  type: z.enum(['payment.succeeded', 'payment.failed', 'payment.refunded']),
  donation_id: z.string().uuid(),
  provider_ref: z.string().optional(),
});

// The payment provider reports results here. Delivery is at-least-once, so every
// transition is guarded by the donation's current status and replays change nothing.
// The row lock also serializes two webhooks for the same donation.
export async function handleWebhook(rawBody: string, signature: string | null): Promise<{ result: string }> {
  if (!verifySignature(rawBody, signature)) {
    throw new ApiError(401, 'invalid_signature', 'Signature check failed');
  }
  let parsed;
  try {
    parsed = EventSchema.parse(JSON.parse(rawBody));
  } catch {
    throw new ApiError(400, 'validation_failed', 'Malformed webhook payload');
  }

  return processEvent(parsed);
}

export type PaymentEvent = z.infer<typeof EventSchema>;

// The transition logic, shared by webhooks and the pending-payment verification job.
export async function processEvent(parsed: Pick<PaymentEvent, 'type' | 'donation_id' | 'provider_ref'>): Promise<{ result: string }> {
  return withTx(async (c) => {
    const { rows } = await c.query(
      `SELECT d.*, u.display_name AS user_name
         FROM donations d LEFT JOIN users u ON u.id = d.donor_id
        WHERE d.id = $1 FOR UPDATE OF d`,
      [parsed.donation_id],
    );
    const d = rows[0];
    // Acknowledge unknown donations so the provider stops retrying
    if (!d) return { result: 'ignored_unknown_donation' };

    const succeeded = () =>
      emit(c, 'donation.succeeded', 'donation', d.id, {
        donation_id: d.id,
        fundraiser_id: d.fundraiser_id,
        amount_cents: d.amount_cents,
        is_anonymous: d.is_anonymous,
        display_name: d.is_anonymous ? null : (d.donor_name ?? d.user_name ?? null),
      });

    switch (parsed.type) {
      case 'payment.succeeded': {
        const u = await c.query(
          `UPDATE donations
              SET status = 'succeeded', succeeded_at = now(), provider_ref = COALESCE(provider_ref, $2)
            WHERE id = $1 AND status = 'pending'`,
          [d.id, parsed.provider_ref ?? null],
        );
        if (!u.rowCount) return { result: 'noop' }; // replay, or already failed/refunded
        await succeeded();
        await c.query(
          `INSERT INTO analytics_events (type, visitor_key, user_id, target_type, target_id) SELECT 'donate', $2::text, $3::uuid, 'fundraiser', $1::uuid WHERE $2::text IS NOT NULL`,
          [d.fundraiser_id, d.visitor_id ?? d.donor_id, d.donor_id],
        );
        return { result: 'succeeded' };
      }
      case 'payment.failed': {
        const u = await c.query(
          "UPDATE donations SET status = 'failed' WHERE id = $1 AND status = 'pending'",
          [d.id],
        );
        return { result: u.rowCount ? 'failed' : 'noop' };
      }
      case 'payment.refunded': {
        const u = await c.query(
          "UPDATE donations SET status = 'refunded' WHERE id = $1 AND status IN ('pending','succeeded')",
          [d.id],
        );
        if (!u.rowCount) return { result: 'noop' };
        // Only a donation that was already counted needs its counters reversed.
        // A refund that arrives first means the success webhook finds it refunded and does nothing.
        if (d.status === 'succeeded') {
          await emit(c, 'donation.refunded', 'donation', d.id, {
            donation_id: d.id,
            fundraiser_id: d.fundraiser_id,
            amount_cents: d.amount_cents,
          });
        }
        return { result: 'refunded' };
      }
    }
  });
}
