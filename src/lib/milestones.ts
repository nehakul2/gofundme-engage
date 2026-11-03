import { withTx } from './db';
import { emit } from './outbox';
import { getRedis, keys } from './redis';
import { uuidv7 } from './ids';
import { formatUsd } from './money';

export const THRESHOLDS = [25, 50, 75, 100] as const;

// Called after each stats flush. Records any threshold the fundraiser has newly crossed.
// The (fundraiser, threshold) primary key is the fires-once guard: only the insert that
// creates the row counts as "newly reached", so concurrent flushes or a replay cannot
// fire a milestone twice. Rows are never deleted, so a refund cannot re-fire one either.
// One outbox event is written per call, carrying every threshold crossed together.
export async function detectMilestones(fundraiserId: string): Promise<number[]> {
  return withTx(async (c) => {
    const { rows } = await c.query(
      `SELECT f.goal_cents, f.status, s.raised_cents, s.donor_count
         FROM fundraisers f JOIN fundraiser_stats s ON s.fundraiser_id = f.id
        WHERE f.id = $1`,
      [fundraiserId],
    );
    const f = rows[0];
    if (!f || f.status === 'removed') return [];

    const fresh: number[] = [];
    for (const t of THRESHOLDS) {
      if (f.raised_cents * 100 < f.goal_cents * t) continue;
      const ins = await c.query(
        `INSERT INTO fundraiser_milestones (fundraiser_id, threshold_pct, raised_cents, donor_count)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING threshold_pct`,
        [fundraiserId, t, f.raised_cents, f.donor_count],
      );
      if (ins.rowCount) fresh.push(t);
    }
    if (!fresh.length) return [];

    if (fresh.includes(100)) {
      await c.query(
        'UPDATE fundraisers SET goal_reached_at = now() WHERE id = $1 AND goal_reached_at IS NULL',
        [fundraiserId],
      );
    }
    await emit(c, 'milestone.reached', 'fundraiser', fundraiserId, {
      fundraiser_id: fundraiserId,
      thresholds: fresh,
      raised_cents: f.raised_cents,
      donor_count: f.donor_count,
    });
    return fresh;
  });
}

interface MilestonePayload {
  fundraiser_id: string;
  thresholds: number[];
  raised_cents: number;
  donor_count: number;
}

// Consumer for milestone.reached: one templated post per community per threshold, and
// one notification per person (collapsed to the highest threshold in this event).
// Both inserts are idempotent, so a redelivered event changes nothing.
export async function deliverMilestone(p: MilestonePayload): Promise<{ posts: number; notified: number }> {
  const top = Math.max(...p.thresholds);
  const notified: string[] = [];
  let posts = 0;

  await withTx(async (c) => {
    const fr = (
      await c.query('SELECT title, owner_id, slug FROM fundraisers WHERE id = $1', [p.fundraiser_id])
    ).rows[0];
    if (!fr) return;

    const communities = await c.query(
      'SELECT community_id FROM community_fundraisers WHERE fundraiser_id = $1',
      [p.fundraiser_id],
    );
    for (const { community_id } of communities.rows) {
      for (const t of [...p.thresholds].sort((a, b) => a - b)) {
        const body = `"${fr.title}" has reached ${t}% of its goal: ${formatUsd(p.raised_cents)} raised by ${p.donor_count} supporters.`;
        const ins = await c.query(
          `INSERT INTO posts (id, community_id, author_id, body, kind, fundraiser_id, milestone_pct)
           VALUES ($1, $2, $3, $4, 'milestone', $5, $6)
           ON CONFLICT DO NOTHING`,
          [uuidv7(), community_id, fr.owner_id, body, p.fundraiser_id, t],
        );
        posts += ins.rowCount ?? 0;
      }
    }

    const recipients = await c.query(
      `SELECT $2::uuid AS user_id
       UNION
       SELECT follower_id FROM follows WHERE target_type = 'fundraiser' AND target_id = $1`,
      [p.fundraiser_id, fr.owner_id],
    );
    for (const { user_id } of recipients.rows) {
      const ins = await c.query(
        `INSERT INTO notifications (id, user_id, type, target_type, target_id, payload, dedupe_key)
         VALUES ($1, $2, 'milestone', 'fundraiser', $3, $4, $5)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING user_id`,
        [
          uuidv7(),
          user_id,
          p.fundraiser_id,
          JSON.stringify({
            threshold_pct: top,
            raised_cents: p.raised_cents,
            donor_count: p.donor_count,
            title: fr.title,
            slug: fr.slug,
          }),
          `${user_id}:${p.fundraiser_id}:${top}`,
        ],
      );
      if (ins.rowCount) notified.push(user_id);
    }
  });

  if (notified.length) {
    const r = getRedis();
    await Promise.all(notified.map((u) => r.incr(keys.unread(u))));
  }
  return { posts, notified: notified.length };
}
