import { z } from 'zod';
import { getPool } from './db';
import { ApiError } from './errors';
import { uuidv7, UUID_RE } from './ids';
import { getRedis, keys } from './redis';
import { resolveFundraiser, type FundraiserRow } from './stats';
import { requireUser } from './engagement';

// Chat room per fundraiser. Postgres holds the messages. A Redis counter ("seq") moves on
// every post or delete so the live stream only touches Postgres when something changed.

// The homepage lobby: one open room that is not tied to a fundraiser. It has no organizer,
// so only a message's author can remove it. Reserved ref: no fundraiser slug can look like this.
export const LOBBY_REF = '_lobby';
export const LOBBY_ID = '00000000-0000-4000-8000-00000000100b';
const LOBBY: FundraiserRow = { id: LOBBY_ID, owner_id: '', status: 'active' } as FundraiserRow;

export const MAX_BODY = 500;
export const RATE_LIMIT = 5;        // messages ...
export const RATE_WINDOW_S = 10;    // ... per this many seconds, per user

export interface ChatMessage {
  id: string;
  fundraiser_id: string;
  user: { id: string; handle: string; display_name: string };
  is_organizer: boolean;
  body: string;
  created_at: string;
}

const BodySchema = z.object({
  body: z.string(),
  client_id: z.string().min(1).max(64).optional(),
});

interface Row { id: string; fundraiser_id: string; body: string; created_at: Date; user_id: string; handle: string; display_name: string }

function shape(r: Row, ownerId: string): ChatMessage {
  return {
    id: r.id,
    fundraiser_id: r.fundraiser_id,
    user: { id: r.user_id, handle: r.handle, display_name: r.display_name },
    is_organizer: r.user_id === ownerId,
    body: r.body,
    created_at: r.created_at.toISOString(),
  };
}

const SELECT = `SELECT m.id, m.fundraiser_id, m.body, m.created_at, m.user_id, u.handle, u.display_name
                  FROM chat_messages m JOIN users u ON u.id = m.user_id`;

async function room(ref: string): Promise<FundraiserRow> {
  if (ref === LOBBY_REF) return LOBBY;
  const f = await resolveFundraiser(ref);
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');
  return f;
}

async function touch(fundraiserId: string) {
  try { await getRedis().incr(keys.chatSeq(fundraiserId)); } catch { /* the stream also polls on a timer */ }
}

// Control characters and runs of blank lines make a room unreadable; collapse them.
export function cleanBody(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function postMessage(ref: string, userId: string | null, raw: unknown): Promise<{ message: ChatMessage; replay: boolean }> {
  const uid = requireUser(userId);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'validation_failed', 'Send { "body": "your message" }', 'body');
  const body = cleanBody(parsed.data.body);
  if (!body) throw new ApiError(400, 'validation_failed', 'Write something first', 'body');
  if (body.length > MAX_BODY) throw new ApiError(400, 'validation_failed', `Messages are limited to ${MAX_BODY} characters`, 'body');

  const f = await room(ref);
  if (f.status !== 'active') {
    throw new ApiError(409, 'chat_closed', `Chat is closed because this fundraiser is ${f.status}`);
  }
  const pool = getPool();
  const known = await pool.query('SELECT 1 FROM users WHERE id = $1', [uid]);
  if (!known.rowCount) throw new ApiError(401, 'unauthenticated', 'Sign in to do this');

  const clientId = parsed.data.client_id ?? null;
  const existing = async () => {
    if (!clientId) return null;
    const { rows } = await pool.query<Row>(`${SELECT} WHERE m.user_id = $1 AND m.client_id = $2 AND m.deleted_at IS NULL`, [uid, clientId]);
    return rows[0] ? shape(rows[0], f.owner_id) : null;
  };
  // A retried send returns the first message and does not use up the rate limit
  const prior = await existing();
  if (prior) return { message: prior, replay: true };

  const r = getRedis();
  const rateKey = keys.chatRate(uid);
  const used = await r.incr(rateKey);
  if (used === 1) await r.expire(rateKey, RATE_WINDOW_S);
  if (used > RATE_LIMIT) {
    const ttl = Math.max(await r.ttl(rateKey), 1);
    throw new ApiError(429, 'rate_limited', `Slow down: ${RATE_LIMIT} messages every ${RATE_WINDOW_S} seconds`, undefined, { 'retry-after': String(ttl) });
  }

  const id = uuidv7();
  const ins = await pool.query(
    `INSERT INTO chat_messages (id, fundraiser_id, user_id, body, client_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL AND deleted_at IS NULL DO NOTHING`,
    [id, f.id, uid, body, clientId],
  );
  if (!ins.rowCount) {
    // Lost a race with another send of the same client_id: return the winner
    const raced = await existing();
    if (!raced) throw new ApiError(409, 'conflict', 'Could not post that message, try again');
    return { message: raced, replay: true };
  }
  await touch(f.id);
  const { rows } = await pool.query<Row>(`${SELECT} WHERE m.id = $1`, [id]);
  return { message: shape(rows[0], f.owner_id), replay: false };
}

// Newest `limit` messages, oldest first. `before` pages back, `after` catches up.
export async function listMessages(ref: string, opts: { before?: string | null; after?: string | null; limit?: unknown } = {}): Promise<{ messages: ChatMessage[]; has_more: boolean }> {
  const f = await room(ref);
  for (const [k, v] of [['before', opts.before], ['after', opts.after]] as const) {
    if (v && !UUID_RE.test(v)) throw new ApiError(400, 'validation_failed', `${k} must be a message id`, k);
  }
  const n = Number(opts.limit ?? 50);
  const limit = Number.isInteger(n) ? Math.min(Math.max(n, 1), 100) : 50;

  if (opts.after) {
    const { rows } = await getPool().query<Row>(
      `${SELECT} WHERE m.fundraiser_id = $1 AND m.deleted_at IS NULL AND m.id > $2 ORDER BY m.id ASC LIMIT $3`,
      [f.id, opts.after, limit + 1],
    );
    return { messages: rows.slice(0, limit).map((r) => shape(r, f.owner_id)), has_more: rows.length > limit };
  }
  const { rows } = await getPool().query<Row>(
    `${SELECT} WHERE m.fundraiser_id = $1 AND m.deleted_at IS NULL AND ($2::uuid IS NULL OR m.id < $2::uuid)
      ORDER BY m.id DESC LIMIT $3`,
    [f.id, opts.before ?? null, limit + 1],
  );
  return { messages: rows.slice(0, limit).reverse().map((r) => shape(r, f.owner_id)), has_more: rows.length > limit };
}

// The author or the fundraiser's organizer can remove a message. Removing twice is fine.
export async function deleteMessage(ref: string, messageId: string, userId: string | null): Promise<void> {
  const uid = requireUser(userId);
  if (!UUID_RE.test(messageId)) throw new ApiError(404, 'not_found', 'Message not found');
  const f = await room(ref);
  const { rows } = await getPool().query<{ user_id: string; deleted_at: Date | null }>(
    'SELECT user_id, deleted_at FROM chat_messages WHERE id = $1 AND fundraiser_id = $2',
    [messageId, f.id],
  );
  const m = rows[0];
  if (!m) throw new ApiError(404, 'not_found', 'Message not found');
  if (m.user_id !== uid && f.owner_id !== uid) throw new ApiError(403, 'forbidden', 'Only the author or the organizer can remove this message');
  if (m.deleted_at) return;
  await getPool().query('UPDATE chat_messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL', [messageId, uid]);
  await touch(f.id);
}

// For the live stream: what happened in the room since the last look.
export async function changesSince(fundraiserId: string, ownerId: string, afterId: string, sinceMs: number) {
  const pool = getPool();
  const [added, removed] = await Promise.all([
    pool.query<Row>(`${SELECT} WHERE m.fundraiser_id = $1 AND m.deleted_at IS NULL AND m.id > $2 ORDER BY m.id ASC LIMIT 50`, [fundraiserId, afterId]),
    pool.query<{ id: string }>('SELECT id FROM chat_messages WHERE fundraiser_id = $1 AND deleted_at >= $2', [fundraiserId, new Date(sinceMs)]),
  ]);
  return { added: added.rows.map((r) => shape(r, ownerId)), removed: removed.rows.map((r) => r.id) };
}

export async function chatSeq(fundraiserId: string): Promise<string | null> {
  return getRedis().get(keys.chatSeq(fundraiserId));
}

export async function latestMessageId(fundraiserId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    'SELECT id FROM chat_messages WHERE fundraiser_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
    [fundraiserId],
  );
  return rows[0]?.id ?? '00000000-0000-0000-0000-000000000000';
}
export { room as resolveChatRoom };
