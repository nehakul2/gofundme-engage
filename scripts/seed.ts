import { getPool, closePool } from '@/lib/db';
import { getRedis, closeRedis } from '@/lib/redis';
import { uuidv7 } from '@/lib/ids';
import { reconcile } from '@/lib/counters';
import { IDS, SLUGS, GOAL_CENTS } from '@/fixtures';

// Loads the shared fixtures from the test case matrix. Wipes existing data first.
export async function seed(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    TRUNCATE users, slug_history, fundraisers, fundraiser_stats, donations, communities,
             community_members, community_fundraisers, posts, follows, shares, idempotency_keys,
             outbox_events, fundraiser_milestones, notifications, visit_snapshots, analytics_events, chat_messages, chat_reports, user_mutes, blocked_words CASCADE`);
  await getRedis().flushdb();

  const users: [string, string, string][] = [
    [IDS.U1, 'owner', 'Olivia Owner'],
    [IDS.U2, 'donor-dan', 'Dan Donor'],
    [IDS.U3, 'donor-dee', 'Dee Donor'],
    [IDS.U4, 'mod-max', 'Max Moderator'],
    [IDS.U5, 'newbie', 'Nia Newcomer'],
  ];
  for (const [id, handle, name] of users) {
    await pool.query('INSERT INTO users (id, handle, display_name) VALUES ($1, $2, $3)', [id, handle, name]);
  }

  const fundraisers: [string, string, string, number, string, string | null][] = [
    [IDS.F1, SLUGS.F1, 'Wildfire alerts for everyone', GOAL_CENTS, 'active', null],
    [IDS.F2, SLUGS.F2, 'Almost there', GOAL_CENTS, 'active', null],
    [IDS.F3, SLUGS.F3, 'Ended campaign', 200_000, 'ended', '2026-01-01T00:00:00Z'],
    [IDS.F4, SLUGS.F4, 'Removed campaign', 500_000, 'removed', null],
  ];
  for (const [id, slug, title, goal, status, endsAt] of fundraisers) {
    await pool.query(
      `INSERT INTO fundraisers (id, owner_id, slug, title, story, goal_cents, status, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, IDS.U1, slug, title, `Story for ${title}`, goal, status, endsAt],
    );
  }

  const donate = async (fid: string, donor: string, cents: number, n: number) =>
    pool.query(
      `INSERT INTO donations (id, fundraiser_id, donor_id, amount_cents, currency, status, succeeded_at, idempotency_key, provider_ref)
       VALUES ($1, $2, $3, $4, 'USD', 'succeeded', now(), $5, $6)`,
      [uuidv7(), fid, donor, cents, `seed-${fid}-${n}`, `seed_ref_${fid}-${n}`],
    );
  await donate(IDS.F2, IDS.U2, GOAL_CENTS - 1_000, 0); // 1,000 cents short of the goal
  for (let i = 0; i < 12; i++) await donate(IDS.F3, i % 2 ? IDS.U2 : IDS.U3, 10_000, i);
  for (let i = 0; i < 3; i++) await donate(IDS.F4, IDS.U2, 5_000, i);

  // Milestones already reached by the seeded totals, so they do not fire again
  const reached: [string, number[], number, number][] = [
    [IDS.F2, [25, 50, 75], GOAL_CENTS - 1_000, 1],
    [IDS.F3, [25, 50], 120_000, 12],
  ];
  for (const [fid, pcts, raised, donors] of reached) {
    for (const pct of pcts) {
      await pool.query(
        'INSERT INTO fundraiser_milestones (fundraiser_id, threshold_pct, raised_cents, donor_count) VALUES ($1,$2,$3,$4)',
        [fid, pct, raised, donors],
      );
    }
  }

  for (const f of [IDS.F1, IDS.F2, IDS.F3, IDS.F4]) await reconcile(f);

  await pool.query(
    'INSERT INTO communities (id, slug, name, description, created_by) VALUES ($1,$2,$3,$4,$5), ($6,$7,$8,$9,$5)',
    [IDS.C1, SLUGS.C1, 'Watch Duty', 'Wildfire watchers and supporters', IDS.U1, IDS.C2, SLUGS.C2, 'Empty community', 'Nothing here yet'],
  );
  for (const [uid, role] of [[IDS.U2, 'member'], [IDS.U3, 'member'], [IDS.U4, 'moderator']]) {
    await pool.query('INSERT INTO community_members (community_id, user_id, role) VALUES ($1,$2,$3)', [IDS.C1, uid, role]);
  }
  for (const f of [IDS.F1, IDS.F2, IDS.F3]) {
    await pool.query('INSERT INTO community_fundraisers (community_id, fundraiser_id, added_by) VALUES ($1,$2,$3)', [IDS.C1, f, IDS.U1]);
  }
  const authors = [IDS.U2, IDS.U3, IDS.U4, IDS.U2, IDS.U3];
  for (let i = 0; i < authors.length; i++) {
    await pool.query('INSERT INTO posts (id, community_id, author_id, body) VALUES ($1,$2,$3,$4)', [
      uuidv7(), IDS.C1, authors[i], `Seed post ${i + 1}`,
    ]);
  }
}

if (process.argv[1]?.endsWith('seed.ts')) {
  seed()
    .then(() => console.log('seeded'))
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(async () => { await closePool(); await closeRedis(); });
}
