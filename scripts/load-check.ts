import { getPool, closePool } from '@/lib/db';
import { getRedis, closeRedis, keys } from '@/lib/redis';
import { SLUGS } from '@/fixtures';
import { pump } from '@/lib/pipeline';

// After a load run: let the pipeline drain, then compare three copies of the truth.
//   ledger (succeeded donations)  vs  fundraiser_stats in Postgres  vs  live counter in Redis
async function main() {
  const slug = process.argv[2] ?? SLUGS.F1;
  const pool = getPool();
  const fid = (await pool.query('SELECT id FROM fundraisers WHERE slug = $1', [slug])).rows[0].id;

  const t0 = Date.now();
  await pump(); // the running worker may already have drained it; this makes sure
  const drainMs = Date.now() - t0;

  const ledger = (await pool.query(
    `SELECT COALESCE(sum(amount_cents),0)::bigint AS raised, count(*)::int AS n FROM donations WHERE fundraiser_id = $1 AND status = 'succeeded'`, [fid])).rows[0];
  const pending = (await pool.query("SELECT count(*)::int AS n FROM donations WHERE fundraiser_id = $1 AND status = 'pending'", [fid])).rows[0].n;
  const stats = (await pool.query('SELECT raised_cents, donor_count FROM fundraiser_stats WHERE fundraiser_id = $1', [fid])).rows[0];
  const live = await getRedis().hgetall(keys.stats(fid));
  const dupKeys = (await pool.query('SELECT count(*)::int AS n FROM (SELECT idempotency_key FROM donations GROUP BY 1 HAVING count(*) > 1) x')).rows[0].n;

  const rows = [
    ['ledger', ledger.raised, ledger.n],
    ['postgres stats', stats.raised_cents, stats.donor_count],
    ['redis live', Number(live.raised_cents), Number(live.donor_count)],
  ];
  console.table(rows.map(([source, raised_cents, donors]) => ({ source, raised_cents, donors })));
  console.log(`pending donations: ${pending}, duplicate idempotency keys: ${dupKeys}, final drain: ${drainMs} ms`);
  const ok = rows.every((r) => r[1] === ledger.raised && r[2] === ledger.n) && dupKeys === 0 && pending === 0;
  console.log(ok ? 'CONSISTENT' : 'MISMATCH');
  process.exitCode = ok ? 0 : 1;
}
main().finally(async () => { await closePool(); await closeRedis(); });
