import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getPool, withTx } from './db';
import { ApiError } from './errors';
import { getRedis, keys } from './redis';
import { resolveFundraiser } from './stats';
import { recordAction } from './analytics';

const TargetSchema = z.object({
  target_type: z.enum(['user', 'fundraiser', 'community']),
  target_id: z.string().uuid(),
});

export function requireUser(userId: string | null): string {
  if (!userId) throw new ApiError(401, 'unauthenticated', 'Sign in to do this');
  return userId;
}

async function bumpCounter(fundraiserId: string, field: 'follower_count' | 'share_count', by: 1 | -1) {
  await getPool().query(
    `INSERT INTO fundraiser_stats (fundraiser_id, ${field}) VALUES ($1, GREATEST($2, 0))
     ON CONFLICT (fundraiser_id) DO UPDATE SET ${field} = GREATEST(fundraiser_stats.${field} + $2, 0), updated_at = now()`,
    [fundraiserId, by],
  );
  const r = getRedis();
  if (await r.exists(keys.stats(fundraiserId))) await r.hincrby(keys.stats(fundraiserId), field, by);
}

// The composite primary key makes follow and unfollow idempotent.
export async function setFollow(userId: string, raw: unknown, on: boolean): Promise<{ following: boolean; changed: boolean }> {
  const parsed = TargetSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'validation_failed', parsed.error.issues[0].message, parsed.error.issues[0].path.join('.'));
  const { target_type, target_id } = parsed.data;
  if (target_type === 'user' && target_id === userId) throw new ApiError(422, 'cannot_follow_self', 'You cannot follow yourself');

  const table = { user: 'users', fundraiser: 'fundraisers', community: 'communities' }[target_type];
  const exists = await getPool().query(`SELECT 1 FROM ${table} WHERE id = $1`, [target_id]);
  if (!exists.rowCount) throw new ApiError(404, 'not_found', 'Nothing to follow here');

  const res = on
    ? await getPool().query(
        'INSERT INTO follows (follower_id, target_type, target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [userId, target_type, target_id],
      )
    : await getPool().query('DELETE FROM follows WHERE follower_id=$1 AND target_type=$2 AND target_id=$3', [
        userId, target_type, target_id,
      ]);
  const changed = (res.rowCount ?? 0) > 0;
  if (changed && target_type === 'fundraiser') await bumpCounter(target_id, 'follower_count', on ? 1 : -1);
  if (changed && on) await recordAction('follow', userId, { type: target_type, id: target_id }, userId);
  return { following: on, changed };
}

export async function isFollowing(userId: string, targetType: string, targetId: string): Promise<boolean> {
  const r = await getPool().query('SELECT 1 FROM follows WHERE follower_id=$1 AND target_type=$2 AND target_id=$3', [
    userId, targetType, targetId,
  ]);
  return r.rowCount === 1;
}

const ShareSchema = z.object({ channel: z.enum(['copy_link', 'facebook', 'x', 'whatsapp', 'email', 'other']) });

// One counted share per person, fundraiser, channel and day; repeat clicks are accepted but not counted.
export async function recordShare(ref: string, raw: unknown, actor: { userId: string | null; anonId: string | null }) {
  const parsed = ShareSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'validation_failed', parsed.error.issues[0].message, 'channel');
  const who = actor.userId ?? actor.anonId;
  if (!who) throw new ApiError(400, 'validation_failed', 'Send x-anon-id or sign in', 'x-anon-id');
  const f = await resolveFundraiser(ref);
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');

  const day = new Date().toISOString().slice(0, 10);
  const dedupe = createHash('sha256').update(`${who}|${f.id}|${parsed.data.channel}|${day}`).digest('hex');
  const inserted = await withTx(async (c) =>
    c.query(
      `INSERT INTO shares (id, fundraiser_id, user_id, channel, dedupe_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [f.id, actor.userId, parsed.data.channel, dedupe],
    ),
  );
  const counted = (inserted.rowCount ?? 0) > 0;
  if (counted) {
    await bumpCounter(f.id, 'share_count', 1);
    await recordAction('share', who, { type: 'fundraiser', id: f.id }, actor.userId);
  }
  return { counted };
}
