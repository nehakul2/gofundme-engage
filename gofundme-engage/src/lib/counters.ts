import { getPool } from './db';
import { getRedis, keys } from './redis';
import { detectMilestones } from './milestones';

// Live counters live in Redis for fast reads; the ledger in Postgres stays the truth.
//   stats hash : live totals served to readers
//   delta hash : changes not yet written to Postgres (flushed in batches)
//   flush:dirty: set of fundraiser ids that have a pending delta

// Applies one donation event exactly once. The event key (SET NX) and the counter
// updates run in one Lua script, so a redelivered event can never count twice and a
// crash cannot leave the event marked as applied with the counters untouched.
// ARGV: 1 amount delta, 2 donor delta, 3-6 base stats (used only if the hash is missing), 7 fundraiser id
const APPLY = `
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', 604800) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('HSET', KEYS[2], 'raised_cents', ARGV[3], 'donor_count', ARGV[4], 'share_count', ARGV[5], 'follower_count', ARGV[6])
end
redis.call('HINCRBY', KEYS[2], 'raised_cents', ARGV[1])
redis.call('HINCRBY', KEYS[2], 'donor_count', ARGV[2])
redis.call('HINCRBY', KEYS[3], 'raised_cents', ARGV[1])
redis.call('HINCRBY', KEYS[3], 'donor_count', ARGV[2])
redis.call('SADD', KEYS[4], ARGV[7])
return 1
`;

// Takes the pending delta and clears the dirty flag in one step. A later event re-adds the flag.
const TAKE = `
local r = tonumber(redis.call('HGET', KEYS[1], 'raised_cents') or 0)
local d = tonumber(redis.call('HGET', KEYS[1], 'donor_count') or 0)
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return {r, d}
`;

export interface DonationEvent {
  eventId: string;
  fundraiserId: string;
  amountCents: number; // positive for a donation, negative for a refund
  donorDelta: 1 | -1;
  pulse?: { name: string | null; at: string };
}

export async function applyDonationEvent(ev: DonationEvent): Promise<boolean> {
  const r = getRedis();
  let base = { raised_cents: 0, donor_count: 0, share_count: 0, follower_count: 0 };
  if (!(await r.exists(keys.stats(ev.fundraiserId)))) {
    const row = (
      await getPool().query(
        'SELECT raised_cents, donor_count, share_count, follower_count FROM fundraiser_stats WHERE fundraiser_id = $1',
        [ev.fundraiserId],
      )
    ).rows[0];
    if (row) base = row;
  }
  const applied = await r.eval(
    APPLY,
    4,
    keys.event(ev.fundraiserId, ev.eventId),
    keys.stats(ev.fundraiserId),
    keys.delta(ev.fundraiserId),
    keys.dirty,
    ev.amountCents,
    ev.donorDelta,
    base.raised_cents,
    base.donor_count,
    base.share_count,
    base.follower_count,
    ev.fundraiserId,
  );
  if (applied !== 1) return false;

  if (ev.pulse) {
    const entry = JSON.stringify({ id: ev.eventId, type: 'donation', amount_cents: Math.abs(ev.amountCents), ...ev.pulse });
    if (ev.amountCents > 0) await r.multi().lpush(keys.pulse(ev.fundraiserId), entry).ltrim(keys.pulse(ev.fundraiserId), 0, 19).exec();
  }
  return true;
}

// Writes one fundraiser's pending delta to Postgres, then checks milestones.
export async function flushStats(fundraiserId: string): Promise<boolean> {
  const r = getRedis();
  const [raised, donors] = (await r.eval(TAKE, 2, keys.delta(fundraiserId), keys.dirty, fundraiserId)) as [number, number];
  if (raised === 0 && donors === 0) return false;
  try {
    await getPool().query(
      `INSERT INTO fundraiser_stats (fundraiser_id, raised_cents, donor_count)
       VALUES ($1, $2, $3)
       ON CONFLICT (fundraiser_id) DO UPDATE
         SET raised_cents = fundraiser_stats.raised_cents + EXCLUDED.raised_cents,
             donor_count  = fundraiser_stats.donor_count  + EXCLUDED.donor_count,
             updated_at   = now()`,
      [fundraiserId, raised, donors],
    );
  } catch (e) {
    // Put the delta back so the next flush retries it
    await r.multi()
      .hincrby(keys.delta(fundraiserId), 'raised_cents', raised)
      .hincrby(keys.delta(fundraiserId), 'donor_count', donors)
      .sadd(keys.dirty, fundraiserId)
      .exec();
    throw e;
  }
  await detectMilestones(fundraiserId);
  return true;
}

export async function flushDirty(): Promise<number> {
  const ids = await getRedis().smembers(keys.dirty);
  let n = 0;
  for (const id of ids) if (await flushStats(id)) n++;
  return n;
}

// Rebuilds a fundraiser's counters from the ledger and replaces both copies.
// This is the safety net for lost events, a wiped Redis, or any drift.
export async function reconcile(fundraiserId: string): Promise<{ raised_cents: number; donor_count: number }> {
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS raised_cents, COUNT(*)::int AS donor_count
       FROM donations WHERE fundraiser_id = $1 AND status = 'succeeded'`,
    [fundraiserId],
  );
  const { raised_cents, donor_count } = rows[0];
  await getPool().query(
    `INSERT INTO fundraiser_stats (fundraiser_id, raised_cents, donor_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (fundraiser_id) DO UPDATE
       SET raised_cents = EXCLUDED.raised_cents, donor_count = EXCLUDED.donor_count, updated_at = now()`,
    [fundraiserId, raised_cents, donor_count],
  );
  const r = getRedis();
  const cur = await getPool().query(
    'SELECT share_count, follower_count FROM fundraiser_stats WHERE fundraiser_id = $1',
    [fundraiserId],
  );
  await r
    .multi()
    .hset(keys.stats(fundraiserId), {
      raised_cents,
      donor_count,
      share_count: cur.rows[0].share_count,
      follower_count: cur.rows[0].follower_count,
    })
    .del(keys.delta(fundraiserId))
    .srem(keys.dirty, fundraiserId)
    .exec();
  return { raised_cents, donor_count };
}
