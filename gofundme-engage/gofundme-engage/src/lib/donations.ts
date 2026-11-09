import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getPool, withTx } from './db';
import { ApiError } from './errors';
import { uuidv7 } from './ids';
import { emit } from './outbox';
import { MAX_DONATION_CENTS } from './money';
import { getPayments } from './payments/mock';
import { resolveFundraiser } from './stats';

const BodySchema = z.object({
  amount_cents: z
    .number({ invalid_type_error: 'amount_cents must be a number', required_error: 'amount_cents is required' })
    .int('amount_cents must be a whole number of cents')
    .min(1, 'amount_cents must be at least 1')
    .max(MAX_DONATION_CENTS, `amount_cents must be at most ${MAX_DONATION_CENTS}`),
  // USD is the only supported currency; anything else is rejected, not converted
  currency: z.literal('USD', { errorMap: () => ({ message: 'Only USD is supported' }) }),
  is_anonymous: z.boolean().default(false),
  display_name: z.string().trim().max(80).optional(),
  message: z.string().trim().max(500).optional(),
  payment_method_token: z.string().min(1, 'payment_method_token is required'),
});
export type DonationInput = z.infer<typeof BodySchema>;

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function parseBody(raw: unknown): DonationInput {
  const r = BodySchema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ApiError(400, 'validation_failed', issue.message, issue.path.join('.') || undefined);
}

function hashRequest(fundraiserId: string, body: DonationInput): string {
  // Key order is fixed by the schema, so equal requests hash equally
  const canonical = JSON.stringify([
    fundraiserId,
    body.amount_cents,
    body.currency,
    body.is_anonymous,
    body.display_name ?? null,
    body.message ?? null,
    body.payment_method_token,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export async function createDonation(args: {
  ref: string;
  idempotencyKey: string | null;
  rawBody: unknown;
  userId: string | null;
  visitorId?: string | null;
}): Promise<ApiResult> {
  const key = args.idempotencyKey?.trim();
  if (!key || key.length < 8 || key.length > 255) {
    throw new ApiError(400, 'idempotency_key_required', 'Send an Idempotency-Key header of 8 to 255 characters');
  }
  const body = parseBody(args.rawBody);
  const fr = await resolveFundraiser(args.ref);
  if (fr.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');
  if (fr.status !== 'active') {
    throw new ApiError(422, 'fundraiser_not_accepting_donations', `This fundraiser is ${fr.status} and cannot take donations`);
  }

  const requestHash = hashRequest(fr.id, body);
  const donationId = uuidv7();

  // The idempotency record, the pending donation, the outbox event and the stored
  // response all commit together. A retry sees either all of it or none of it.
  const first = await withTx(async (c): Promise<ApiResult | 'replay'> => {
    const ins = await c.query(
      `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING key`,
      [key, requestHash],
    );
    if (!ins.rowCount) return 'replay';

    const created = await c.query(
      `INSERT INTO donations
         (id, fundraiser_id, donor_id, donor_name, is_anonymous, amount_cents, currency, message, idempotency_key, visitor_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $8, $9)
       RETURNING created_at`,
      [donationId, fr.id, args.userId, body.display_name ?? null, body.is_anonymous, body.amount_cents, body.message ?? null, key, args.visitorId ?? null],
    );
    await emit(c, 'donation.created', 'donation', donationId, {
      donation_id: donationId,
      fundraiser_id: fr.id,
    });
    const response = {
      id: donationId,
      fundraiser_id: fr.id,
      status: 'pending',
      amount_cents: body.amount_cents,
      currency: 'USD',
      created_at: created.rows[0].created_at,
    };
    await c.query('UPDATE idempotency_keys SET response = $2, status_code = 202 WHERE key = $1', [
      key,
      JSON.stringify(response),
    ]);
    return { status: 202, body: response };
  });

  if (first === 'replay') return replay(key, requestHash);

  // Charge after the commit: the donation exists as pending before the provider hears of it.
  // The result comes back later as a signed webhook.
  try {
    const { providerRef } = await getPayments().createCharge({
      donationId,
      amountCents: body.amount_cents,
      currency: 'USD',
      token: body.payment_method_token,
    });
    await getPool().query('UPDATE donations SET provider_ref = COALESCE(provider_ref, $2) WHERE id = $1', [
      donationId,
      providerRef,
    ]);
    return first;
  } catch (e) {
    console.error('payment provider call failed', (e as Error).message);
    const failure = {
      error: { code: 'payment_provider_unavailable', message: 'Payment provider is unavailable. Try again with a new Idempotency-Key.' },
    };
    await withTx(async (c) => {
      await c.query("UPDATE donations SET status = 'failed' WHERE id = $1 AND status = 'pending'", [donationId]);
      await c.query('UPDATE idempotency_keys SET response = $2, status_code = 502 WHERE key = $1', [
        key,
        JSON.stringify(failure),
      ]);
    });
    return { status: 502, body: failure };
  }
}

async function replay(key: string, requestHash: string): Promise<ApiResult> {
  const row = (
    await getPool().query('SELECT request_hash, response, status_code FROM idempotency_keys WHERE key = $1', [key])
  ).rows[0];
  if (!row) throw new ApiError(409, 'idempotency_conflict', 'Please retry');
  if (row.request_hash !== requestHash) {
    throw new ApiError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request');
  }
  return { status: row.status_code ?? 202, body: row.response, headers: { 'idempotent-replay': 'true' } };
}

export async function getDonation(id: string) {
  const { rows } = await getPool().query(
    'SELECT id, fundraiser_id, status, amount_cents, currency, created_at, succeeded_at FROM donations WHERE id = $1',
    [id],
  );
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Donation not found');
  return rows[0];
}

// Newest first. Anonymous donors never expose a name.
export async function listDonations(ref: string, limit = 20) {
  const fr = await resolveFundraiser(ref);
  if (fr.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');
  const { rows } = await getPool().query(
    `SELECT d.id, d.amount_cents, d.message, d.is_anonymous, d.succeeded_at,
            COALESCE(d.donor_name, u.display_name) AS name
       FROM donations d LEFT JOIN users u ON u.id = d.donor_id
      WHERE d.fundraiser_id = $1 AND d.status = 'succeeded'
      ORDER BY d.succeeded_at DESC, d.id DESC
      LIMIT $2`,
    [fr.id, Math.min(Math.max(limit, 1), 50)],
  );
  return rows.map((r) => ({
    id: r.id,
    amount_cents: r.amount_cents,
    message: r.message,
    display_name: r.is_anonymous ? null : r.name,
    is_anonymous: r.is_anonymous,
    created_at: r.succeeded_at,
  }));
}
