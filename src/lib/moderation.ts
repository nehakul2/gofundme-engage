import { z } from 'zod';
import { getPool } from './db';
import { ApiError } from './errors';
import { uuidv7, UUID_RE } from './ids';
import { requireUser } from './engagement';
import { getRedis, keys } from './redis';

// ---- Admin guard ------------------------------------------------------------------------
// Open when ADMIN_KEY is not set (local development); otherwise the x-admin-key header must match.
export function requireAdmin(req: Request): void {
  const key = process.env.ADMIN_KEY;
  if (key && req.headers.get('x-admin-key') !== key) throw new ApiError(403, 'forbidden', 'Admin key required');
}

async function knownUser(header: string | null): Promise<string> {
  const userId = requireUser(header);
  const known = await getPool().query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (!known.rowCount) throw new ApiError(401, 'unauthenticated', 'Sign in to do this');
  return userId;
}

// ---- Word filter ------------------------------------------------------------------------
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole words only, any capitalisation: blocking "ass" does not block "class".
// `field` is the input being checked. Chat keeps its original error; titles, stories and community
// names get a more general one that names the field.
export async function assertAllowedWords(body: string, field = 'body'): Promise<void> {
  const { rows } = await getPool().query<{ word: string }>('SELECT word::text AS word FROM blocked_words');
  if (!rows.length) return;
  const lower = body.toLowerCase();
  for (const { word } of rows) {
    if (new RegExp(`(^|[^a-z0-9])${escapeRe(word.toLowerCase())}($|[^a-z0-9])`).test(lower)) {
      if (field === 'body') throw new ApiError(422, 'message_blocked', 'That message has a word that is not allowed in chat. Please reword it.', 'body');
      throw new ApiError(422, 'text_blocked', `The ${field} has a word that is not allowed here. Please reword it.`, field);
    }
  }
}

const WordSchema = z.object({ word: z.string().trim().min(2, 'A word needs at least 2 characters').max(40, 'A word can be at most 40 characters') });

export async function listWords(): Promise<string[]> {
  const { rows } = await getPool().query<{ word: string }>('SELECT word::text AS word FROM blocked_words ORDER BY word');
  return rows.map((r) => r.word);
}
export async function addWord(raw: unknown): Promise<{ word: string; changed: boolean }> {
  const p = WordSchema.safeParse(raw);
  if (!p.success) throw new ApiError(400, 'validation_failed', p.error.issues[0].message, 'word');
  const r = await getPool().query('INSERT INTO blocked_words (word) VALUES ($1) ON CONFLICT DO NOTHING', [p.data.word]);
  return { word: p.data.word.toLowerCase(), changed: (r.rowCount ?? 0) > 0 };
}
export async function removeWord(raw: unknown): Promise<{ removed: boolean }> {
  const p = WordSchema.safeParse(raw);
  if (!p.success) throw new ApiError(400, 'validation_failed', p.error.issues[0].message, 'word');
  const r = await getPool().query('DELETE FROM blocked_words WHERE word = $1', [p.data.word]);
  return { removed: (r.rowCount ?? 0) > 0 };
}

// ---- Reporting --------------------------------------------------------------------------
const ReportSchema = z.object({ reason: z.string().trim().max(200, 'The reason can be at most 200 characters').optional().default('') }).strict();

export async function reportMessage(userHeader: string | null, messageId: string, raw: unknown) {
  const uid = await knownUser(userHeader);
  if (!UUID_RE.test(messageId)) throw new ApiError(404, 'not_found', 'Message not found');
  const p = ReportSchema.safeParse(raw ?? {});
  if (!p.success) throw new ApiError(400, 'validation_failed', p.error.issues[0].message, 'reason');
  const m = (await getPool().query<{ user_id: string; deleted_at: Date | null }>('SELECT user_id, deleted_at FROM chat_messages WHERE id = $1', [messageId])).rows[0];
  if (!m || m.deleted_at) throw new ApiError(404, 'not_found', 'Message not found');
  if (m.user_id === uid) throw new ApiError(422, 'cannot_report_own', 'You cannot report your own message');
  const r = await getPool().query(
    'INSERT INTO chat_reports (id, message_id, reporter_id, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (message_id, reporter_id) DO NOTHING',
    [uuidv7(), messageId, uid, p.data.reason],
  );
  return { reported: true, changed: (r.rowCount ?? 0) > 0 };
}

// Open reports grouped by message, most reported first. Messages already removed drop out of the queue.
export async function openReports() {
  const { rows } = await getPool().query(
    `SELECT m.id AS message_id, m.body, m.created_at, u.id AS author_id, u.display_name AS author, u.handle,
            CASE WHEN m.fundraiser_id = '00000000-0000-4000-8000-00000000100b' THEN 'Homepage lobby'
                 ELSE COALESCE((SELECT title FROM fundraisers f WHERE f.id = m.fundraiser_id), 'Unknown room') END AS room,
            count(*)::int AS reports,
            COALESCE(array_agg(r.reason) FILTER (WHERE r.reason <> ''), '{}') AS reasons,
            min(r.created_at) AS first_reported_at
       FROM chat_reports r
       JOIN chat_messages m ON m.id = r.message_id
       JOIN users u ON u.id = m.user_id
      WHERE r.status = 'open' AND m.deleted_at IS NULL
      GROUP BY m.id, u.id
      ORDER BY reports DESC, first_reported_at ASC
      LIMIT 100`,
  );
  return rows;
}

// remove: hide the message for everyone and close its reports. dismiss: keep it and close its reports.
export async function resolveReports(messageId: string, raw: unknown) {
  const action = (raw as { action?: unknown } | null)?.action;
  if (action !== 'remove' && action !== 'dismiss') throw new ApiError(400, 'validation_failed', 'action must be "remove" or "dismiss"', 'action');
  if (!UUID_RE.test(messageId)) throw new ApiError(404, 'not_found', 'Message not found');
  const m = (await getPool().query<{ fundraiser_id: string }>('SELECT fundraiser_id FROM chat_messages WHERE id = $1', [messageId])).rows[0];
  if (!m) throw new ApiError(404, 'not_found', 'Message not found');
  if (action === 'remove') {
    await getPool().query('UPDATE chat_messages SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [messageId]);
    try { await getRedis().incr(keys.chatSeq(m.fundraiser_id)); } catch { /* the stream also polls on a timer */ }
  }
  const r = await getPool().query(
    "UPDATE chat_reports SET status = $2, handled_at = now() WHERE message_id = $1 AND status = 'open'",
    [messageId, action === 'remove' ? 'removed' : 'dismissed'],
  );
  return { action, closed: r.rowCount ?? 0 };
}

// ---- Muting (per viewer, chat only) -------------------------------------------------------
export async function listMutes(userHeader: string | null) {
  const uid = await knownUser(userHeader);
  const { rows } = await getPool().query(
    `SELECT u.id AS user_id, u.handle, u.display_name FROM user_mutes m JOIN users u ON u.id = m.muted_id
      WHERE m.user_id = $1 ORDER BY m.created_at`, [uid]);
  return { muted: rows as { user_id: string; handle: string; display_name: string }[] };
}

export async function setMute(userHeader: string | null, raw: unknown, on: boolean) {
  const uid = await knownUser(userHeader);
  const target = (raw as { user_id?: unknown } | null)?.user_id;
  if (typeof target !== 'string' || !UUID_RE.test(target)) throw new ApiError(400, 'validation_failed', 'Say which person with user_id', 'user_id');
  if (target === uid) throw new ApiError(422, 'cannot_mute_self', 'You cannot mute yourself');
  if (on) {
    const exists = await getPool().query('SELECT 1 FROM users WHERE id = $1', [target]);
    if (!exists.rowCount) throw new ApiError(404, 'not_found', 'Person not found');
    const r = await getPool().query('INSERT INTO user_mutes (user_id, muted_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [uid, target]);
    return { muted: true, changed: (r.rowCount ?? 0) > 0 };
  }
  const r = await getPool().query('DELETE FROM user_mutes WHERE user_id = $1 AND muted_id = $2', [uid, target]);
  return { muted: false, changed: (r.rowCount ?? 0) > 0 };
}
