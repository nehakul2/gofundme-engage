import { z } from 'zod';
import { getPool, withTx } from './db';
import { ApiError } from './errors';
import { uuidv7 } from './ids';
import { emit } from './outbox';
import { getRedis, keys } from './redis';
import { resolveFundraiser } from './stats';
import { assertAllowedWords } from './moderation';

// Organizer updates: short posts from the person running a fundraiser. They show on the fundraiser
// page next to the milestones, in the feed of every community the fundraiser belongs to, and in the
// bell of everyone who follows it or has given to it. They are the main reason to come back between
// milestones, which is what the repeat-visit metric measures.

export const UPDATE_LIMIT = 10;       // updates ...
export const UPDATE_WINDOW_S = 3600;  // ... per fundraiser, per hour

const PostSchema = z.object({
  body: z.string().trim().min(1, 'Write something first').max(2000, 'An update can be at most 2000 characters'),
  client_id: z.string().trim().min(8).max(80).optional(),
}).strict();

export interface UpdateItem { id: string; body: string; created_at: string; author_name: string; author_handle: string }

// The organizer posts; the post and its outbox event commit together, so followers are told
// exactly once even if the worker is slow or restarts.
export async function postUpdate(ref: string, userId: string | null, raw: unknown): Promise<{ update: UpdateItem; replay: boolean }> {
  if (!userId) throw new ApiError(401, 'unauthenticated', 'Sign in to post an update');
  const p = PostSchema.safeParse(raw);
  if (!p.success) throw new ApiError(400, 'validation_failed', p.error.issues[0].message, p.error.issues[0].path.join('.') || 'body');
  const f = await resolveFundraiser(ref);
  if (f.owner_id !== userId) throw new ApiError(403, 'forbidden', 'Only the organizer can post updates');
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');
  if (f.status === 'draft') throw new ApiError(422, 'fundraiser_not_active', 'Publish the fundraiser before posting updates');
  await assertAllowedWords(p.data.body, 'update');

  const pool = getPool();
  if (p.data.client_id) {
    const prior = await pool.query(
      `SELECT u.id, u.body, u.created_at, a.display_name, a.handle FROM fundraiser_updates u JOIN users a ON a.id = u.author_id
        WHERE u.author_id = $1 AND u.client_id = $2`,
      [userId, p.data.client_id],
    );
    if (prior.rows[0]) return { update: toItem(prior.rows[0]), replay: true };
  }
  const recent = await pool.query(
    `SELECT count(*)::int AS n FROM fundraiser_updates WHERE fundraiser_id = $1 AND created_at > now() - make_interval(secs => $2)`,
    [f.id, UPDATE_WINDOW_S],
  );
  if (recent.rows[0].n >= UPDATE_LIMIT) {
    throw new ApiError(429, 'rate_limited', `You can post ${UPDATE_LIMIT} updates an hour. Try again later.`, undefined, { 'retry-after': String(UPDATE_WINDOW_S) });
  }

  const id = uuidv7();
  const row = await withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO fundraiser_updates (id, fundraiser_id, author_id, body, client_id) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, body, created_at`,
      [id, f.id, userId, p.data.body, p.data.client_id ?? null],
    );
    await emit(c, 'update.posted', 'fundraiser', f.id, { fundraiser_id: f.id, update_id: id });
    return ins.rows[0];
  });
  const author = (await pool.query('SELECT display_name, handle FROM users WHERE id = $1', [userId])).rows[0];
  return { update: toItem({ ...row, display_name: author.display_name, handle: author.handle }), replay: false };
}

function toItem(r: { id: string; body: string; created_at: Date; display_name: string; handle: string }): UpdateItem {
  return { id: r.id, body: r.body, created_at: r.created_at.toISOString(), author_name: r.display_name, author_handle: r.handle };
}

export type TimelineItem =
  | ({ kind: 'update' } & UpdateItem)
  | { kind: 'milestone'; id: string; pct: number; raised_cents: number; donor_count: number; created_at: string };

// Organizer updates and milestones in one list, newest first.
export async function getTimeline(ref: string, limit = 30): Promise<TimelineItem[]> {
  const f = await resolveFundraiser(ref);
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 30;
  const pool = getPool();
  const [updates, milestones] = await Promise.all([
    pool.query(
      `SELECT u.id, u.body, u.created_at, a.display_name, a.handle FROM fundraiser_updates u JOIN users a ON a.id = u.author_id
        WHERE u.fundraiser_id = $1 ORDER BY u.created_at DESC, u.id DESC LIMIT $2`,
      [f.id, n],
    ),
    pool.query(
      'SELECT threshold_pct, raised_cents, donor_count, reached_at FROM fundraiser_milestones WHERE fundraiser_id = $1',
      [f.id],
    ),
  ]);
  const items: TimelineItem[] = [
    ...updates.rows.map((r): TimelineItem => ({ kind: 'update', ...toItem(r) })),
    ...milestones.rows.map((m): TimelineItem => ({
      kind: 'milestone',
      id: `milestone-${m.threshold_pct}`,
      pct: m.threshold_pct,
      raised_cents: Number(m.raised_cents),
      donor_count: m.donor_count,
      created_at: m.reached_at.toISOString(),
    })),
  ];
  // Same instant: the higher milestone first
  items.sort((a, b) => b.created_at.localeCompare(a.created_at) || (b.kind === 'milestone' ? b.pct : 0) - (a.kind === 'milestone' ? a.pct : 0));
  return items.slice(0, n);
}

interface UpdatePayload { fundraiser_id: string; update_id: string }

// Consumer for update.posted: one post per community and one notification per person.
// Recipients are the fundraiser's followers and its donors (signed-in ones), minus the author.
// Both inserts are idempotent, so a redelivered event changes nothing.
export async function deliverUpdate(p: UpdatePayload): Promise<{ posts: number; notified: number }> {
  const notified: string[] = [];
  let posts = 0;
  await withTx(async (c) => {
    const row = (await c.query(
      `SELECT u.id, u.body, u.author_id, f.title, f.slug FROM fundraiser_updates u JOIN fundraisers f ON f.id = u.fundraiser_id
        WHERE u.id = $1 AND f.status <> 'removed'`,
      [p.update_id],
    )).rows[0];
    if (!row) return;

    const communities = await c.query('SELECT community_id FROM community_fundraisers WHERE fundraiser_id = $1', [p.fundraiser_id]);
    for (const { community_id } of communities.rows) {
      const ins = await c.query(
        `INSERT INTO posts (id, community_id, author_id, body, kind, fundraiser_id, update_id)
         VALUES ($1,$2,$3,$4,'update',$5,$6) ON CONFLICT DO NOTHING`,
        [uuidv7(), community_id, row.author_id, row.body, p.fundraiser_id, p.update_id],
      );
      posts += ins.rowCount ?? 0;
    }

    const recipients = await c.query(
      `SELECT follower_id AS user_id FROM follows WHERE target_type = 'fundraiser' AND target_id = $1
       UNION
       SELECT donor_id FROM donations WHERE fundraiser_id = $1 AND status = 'succeeded' AND donor_id IS NOT NULL`,
      [p.fundraiser_id],
    );
    const excerpt = row.body.length > 140 ? `${row.body.slice(0, 137)}...` : row.body;
    for (const { user_id } of recipients.rows) {
      if (user_id === row.author_id) continue;
      const ins = await c.query(
        `INSERT INTO notifications (id, user_id, type, target_type, target_id, payload, dedupe_key)
         VALUES ($1,$2,'update','fundraiser',$3,$4,$5)
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING user_id`,
        [uuidv7(), user_id, p.fundraiser_id, JSON.stringify({ title: row.title, slug: row.slug, update_id: p.update_id, excerpt }), `${user_id}:update:${p.update_id}`],
      );
      if (ins.rowCount) notified.push(user_id);
    }
  });
  if (notified.length) {
    try {
      const r = getRedis();
      await Promise.all(notified.map((u) => r.incr(keys.unread(u))));
    } catch { /* Postgres holds the real unread count */ }
  }
  return { posts, notified: notified.length };
}
