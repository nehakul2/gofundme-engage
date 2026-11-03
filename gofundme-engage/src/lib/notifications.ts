import { z } from 'zod';
import { getPool } from './db';
import { ApiError } from './errors';
import { getRedis, keys } from './redis';
import { requireUser } from './engagement';

// In-app notifications (milestones today). The unread count comes from Postgres, the
// source of truth, using the partial index on unread rows; the Redis counter the milestone
// worker bumps is reset when the inbox is read.

export interface NotificationItem {
  id: string;
  type: 'milestone';
  target_type: string;
  target_id: string;
  threshold_pct: number | null;
  title: string | null;
  raised_cents: number | null;
  donor_count: number | null;
  created_at: string;
  read: boolean;
}

export async function unreadCount(userId: string | null): Promise<number> {
  const uid = requireUser(userId);
  const { rows } = await getPool().query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [uid]);
  return rows[0].n;
}

export async function listNotifications(userId: string | null, limit = 30): Promise<NotificationItem[]> {
  const uid = requireUser(userId);
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 30;
  const { rows } = await getPool().query(
    `SELECT id, type, target_type, target_id, payload, created_at, read_at
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [uid, n],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    target_type: r.target_type,
    target_id: r.target_id,
    threshold_pct: r.payload?.threshold_pct ?? null,
    title: r.payload?.title ?? null,
    raised_cents: r.payload?.raised_cents ?? null,
    donor_count: r.payload?.donor_count ?? null,
    created_at: r.created_at.toISOString(),
    read: r.read_at !== null,
  }));
}

const ReadSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }),
]);

// Marking read twice is harmless.
export async function markRead(userId: string | null, raw: unknown): Promise<{ marked: number }> {
  const uid = requireUser(userId);
  const parsed = ReadSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'validation_failed', 'Send { "all": true } or { "ids": [...] }');
  const body = parsed.data;
  const res = 'all' in body
    ? await getPool().query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [uid])
    : await getPool().query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::uuid[])', [uid, body.ids]);
  try { await getRedis().del(keys.unread(uid)); } catch { /* Postgres is the truth */ }
  return { marked: res.rowCount ?? 0 };
}
