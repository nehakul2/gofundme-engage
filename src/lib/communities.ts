import { z } from 'zod';
import { assertAllowedWords } from './moderation';
import { getPool, withTx } from './db';
import { getRedis, keys } from './redis';
import { ApiError } from './errors';
import { uuidv7 } from './ids';
import { requireUser } from './engagement';

export const COMMUNITY_LIMIT = 3;          // new communities per person ...
export const COMMUNITY_WINDOW_S = 3600;    // ... per hour

const CreateSchema = z.object({
  name: z.string({ required_error: 'Give the community a name' }).trim().min(3, 'A name needs at least 3 characters').max(60, 'A name can be at most 60 characters'),
  description: z.string().trim().max(280, 'The description can be at most 280 characters').optional().default(''),
});

function fail(issue: z.ZodIssue): never {
  throw new ApiError(400, 'validation_failed', issue.message, issue.path.join('.') || undefined);
}
function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'community';
}

async function knownUser(header: string | null): Promise<string> {
  const userId = requireUser(header);
  const known = await getPool().query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (!known.rowCount) throw new ApiError(401, 'unauthenticated', 'Sign in to do this');
  return userId;
}

async function community(slug: string): Promise<{ id: string; slug: string; name: string }> {
  const c = (await getPool().query('SELECT id, slug::text AS slug, name FROM communities WHERE slug = $1', [slug])).rows[0];
  if (!c) throw new ApiError(404, 'not_found', 'Community not found');
  return c;
}

// The creator becomes the community's owner and first member.
export async function createCommunity(userHeader: string | null, raw: unknown) {
  const userId = await knownUser(userHeader);
  const p = CreateSchema.safeParse(raw);
  if (!p.success) fail(p.error.issues[0]);
  await assertAllowedWords(p.data.name, 'name');
  if (p.data.description) await assertAllowedWords(p.data.description, 'description');

  const r = getRedis();
  const rateKey = keys.communityRate(userId);
  const used = await r.incr(rateKey);
  if (used === 1) await r.expire(rateKey, COMMUNITY_WINDOW_S);
  if (used > COMMUNITY_LIMIT) {
    const ttl = Math.max(await r.ttl(rateKey), 1);
    throw new ApiError(429, 'rate_limited', `You can start ${COMMUNITY_LIMIT} communities per hour. Try again later.`, undefined, { 'retry-after': String(ttl) });
  }

  const id = uuidv7();
  const base = slugify(p.data.name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      return await withTx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO communities (id, slug, name, description, created_by) VALUES ($1,$2,$3,$4,$5)
           RETURNING id, slug::text AS slug, name, description, created_by, created_at`,
          [id, slug, p.data.name, p.data.description || null, userId],
        );
        await c.query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1,$2,'owner')", [id, userId]);
        return rows[0];
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') continue;
      throw e;
    }
  }
  throw new ApiError(409, 'slug_conflict', 'Could not pick a unique address. Try a different name.');
}

// Joining is idempotent. Leaving is blocked for the owner so a community is never left without one.
export async function setMembership(userHeader: string | null, slug: string, join: boolean) {
  const userId = await knownUser(userHeader);
  const c = await community(slug);
  if (join) {
    const r = await getPool().query(
      "INSERT INTO community_members (community_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING", [c.id, userId]);
    return { member: true, changed: (r.rowCount ?? 0) > 0 };
  }
  const cur = (await getPool().query('SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2', [c.id, userId])).rows[0];
  if (cur?.role === 'owner') throw new ApiError(422, 'owner_cannot_leave', 'The owner cannot leave their own community');
  const r = await getPool().query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [c.id, userId]);
  return { member: false, changed: (r.rowCount ?? 0) > 0 };
}

// A member may list a fundraiser they own in the community (idempotent). Removed fundraisers cannot be added.
export async function addFundraiser(userHeader: string | null, slug: string, raw: unknown) {
  const userId = await knownUser(userHeader);
  const ref = (raw as { fundraiser?: unknown } | null)?.fundraiser;
  if (typeof ref !== 'string' || !ref) throw new ApiError(400, 'validation_failed', 'Say which fundraiser to add', 'fundraiser');
  const c = await community(slug);
  const member = await getPool().query('SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [c.id, userId]);
  if (!member.rowCount) throw new ApiError(403, 'forbidden', 'Join the community first');
  const f = (await getPool().query('SELECT id, owner_id, status, title FROM fundraisers WHERE slug = $1', [ref])).rows[0];
  if (!f || f.status === 'removed') throw new ApiError(404, 'not_found', 'Fundraiser not found');
  if (f.owner_id !== userId) throw new ApiError(403, 'forbidden', 'You can only add your own fundraisers');
  const r = await getPool().query(
    'INSERT INTO community_fundraisers (community_id, fundraiser_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [c.id, f.id, userId]);
  return { added: true, changed: (r.rowCount ?? 0) > 0, title: f.title as string };
}

// What the page needs to know about the viewer: role, and which of their fundraisers can still be added.
export async function myCommunityState(userHeader: string | null, slug: string) {
  const c = await community(slug);
  if (!userHeader) return { member: false, role: null, can_add: [] as { slug: string; title: string }[] };
  const userId = requireUser(userHeader);
  const role = (await getPool().query('SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2', [c.id, userId])).rows[0]?.role ?? null;
  const can_add = role
    ? (await getPool().query(
        `SELECT f.slug::text AS slug, f.title FROM fundraisers f
          WHERE f.owner_id = $1 AND f.status IN ('active','ended')
            AND NOT EXISTS (SELECT 1 FROM community_fundraisers cf WHERE cf.community_id = $2 AND cf.fundraiser_id = f.id)
          ORDER BY f.created_at DESC LIMIT 50`, [userId, c.id])).rows
    : [];
  return { member: Boolean(role), role, can_add };
}

export async function searchCommunities(q: string) {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2).slice(0, 6);
  if (!words.length) return [];
  const conds = words.map((_, i) => `(c.name ILIKE $${i + 1} OR COALESCE(c.description,'') ILIKE $${i + 1})`).join(' AND ');
  const { rows } = await getPool().query(
    `SELECT c.slug::text AS slug, c.name, c.description,
            (SELECT count(*)::int FROM community_members m WHERE m.community_id = c.id) AS member_count
       FROM communities c WHERE ${conds} ORDER BY member_count DESC, c.name LIMIT 5`,
    words.map((w) => `%${w}%`),
  );
  return rows as { slug: string; name: string; description: string | null; member_count: number }[];
}
