import { z } from 'zod';
import { getPool, withTx } from './db';
import { ApiError } from './errors';
import { uuidv7 } from './ids';
import { resolveFundraiser } from './stats';
import { resolveZip } from './places';
import { assertAllowedWords } from './moderation';

export const CREATE_LIMIT = 5;           // new fundraisers ...
export const CREATE_WINDOW_S = 3600;     // ... per hour, per user

export const etagOf = (version: number) => `"v${version}"`;

const CreateSchema = z.object({
  title: z.string().trim().min(3, 'title must be at least 3 characters').max(120),
  story: z.string().trim().min(1, 'story is required').max(20_000),
  goal_cents: z.number().int('goal_cents must be a whole number of cents').min(100, 'goal must be at least $1').max(100_000_000_000),
  ends_at: z.string().datetime().optional(),
  publish: z.boolean().default(true),
  zip: z.string().regex(/^\d{5}$/, 'zip must be a 5-digit US zip code').optional(),
});

const PatchSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    story: z.string().trim().min(1).max(20_000),
    goal_cents: z.number().int().min(100).max(100_000_000_000),
    ends_at: z.string().datetime().nullable(),
    status: z.enum(['active', 'ended']),
  })
  .partial()
  .strict();

function fail(issue: z.ZodIssue): never {
  throw new ApiError(400, 'validation_failed', issue.message, issue.path.join('.') || undefined);
}

function slugify(title: string): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return base || 'fundraiser';
}

const COLUMNS = 'id, owner_id, slug, title, story, goal_cents, currency, status, ends_at, version, created_at, updated_at';

// Returns the created object, so the client never has to read it back (no read-after-write gap).
export async function createFundraiser(userId: string, raw: unknown) {
  const p = CreateSchema.safeParse(raw);
  if (!p.success) fail(p.error.issues[0]);
  const body = p.data;
  await assertAllowedWords(body.title, 'title');
  await assertAllowedWords(body.story, 'story');
  const where = body.zip ? resolveZip(body.zip) : null;
  if (body.zip && !where) throw new ApiError(400, 'validation_failed', `${body.zip} is not a US zip code I know`, 'zip');
  const id = uuidv7();
  const base = slugify(body.title);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const row = await withTx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO fundraisers (id, owner_id, slug, title, story, goal_cents, status, ends_at, city, state, postal_code, lat, lng)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${COLUMNS}`,
          [id, userId, slug, body.title, body.story, body.goal_cents, body.publish ? 'active' : 'draft', body.ends_at ?? null,
           where?.city ?? null, where?.state ?? null, where?.zip ?? null, where?.lat ?? null, where?.lng ?? null],
        );
        await c.query('INSERT INTO fundraiser_stats (fundraiser_id) VALUES ($1)', [id]);
        return rows[0];
      });
      return row;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') continue; // slug taken: try a suffixed one
      throw e;
    }
  }
  throw new ApiError(409, 'slug_conflict', 'Could not pick a unique address. Try a different title.');
}

// PATCH needs If-Match with the version the client last saw (ETag "v<version>").
//   no header        428 precondition_required
//   stale version    412 precondition_failed (with the current ETag)
// The version check is part of the UPDATE, so two simultaneous edits cannot both win.
export async function patchFundraiser(ref: string, userId: string | null, ifMatch: string | null, raw: unknown) {
  if (!userId) throw new ApiError(401, 'unauthenticated', 'Sign in to edit');
  if (!ifMatch) throw new ApiError(428, 'precondition_required', 'Send If-Match with the ETag you last received');
  const m = /^"?v(\d+)"?$/.exec(ifMatch.trim());
  if (!m) throw new ApiError(400, 'validation_failed', 'If-Match must be an ETag like "v3"', 'if-match');
  const expected = Number(m[1]);

  const p = PatchSchema.safeParse(raw);
  if (!p.success) fail(p.error.issues[0]);
  const patch = p.data;
  if (!Object.keys(patch).length) throw new ApiError(400, 'validation_failed', 'Nothing to update');
  if (patch.title !== undefined) await assertAllowedWords(patch.title, 'title');
  if (patch.story !== undefined) await assertAllowedWords(patch.story, 'story');

  const f = await resolveFundraiser(ref);
  if (f.owner_id !== userId) throw new ApiError(403, 'forbidden', 'Only the owner can edit this fundraiser');
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');

  return withTx(async (c) => {
    const cur = (await c.query('SELECT version, status, goal_cents FROM fundraisers WHERE id = $1 FOR UPDATE', [f.id])).rows[0];
    if (cur.version !== expected) {
      throw new ApiError(412, 'precondition_failed', 'This fundraiser changed since you loaded it. Reload and retry.', undefined, {
        etag: etagOf(cur.version),
      });
    }
    if (patch.status) {
      const ok = (cur.status === 'draft' && patch.status === 'active') || (cur.status === 'active' && patch.status === 'ended');
      if (!ok && patch.status !== cur.status) {
        throw new ApiError(422, 'invalid_transition', `Cannot change status from ${cur.status} to ${patch.status}`, 'status');
      }
    }
    if (patch.goal_cents !== undefined) {
      const raised = (await c.query('SELECT raised_cents FROM fundraiser_stats WHERE fundraiser_id = $1', [f.id])).rows[0]?.raised_cents ?? 0;
      if (patch.goal_cents < raised) throw new ApiError(422, 'goal_below_raised', 'The goal cannot be lower than the amount already raised', 'goal_cents');
    }
    const sets: string[] = [];
    const vals: unknown[] = [f.id];
    for (const [k, v] of Object.entries(patch)) {
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    const { rows } = await c.query(
      `UPDATE fundraisers SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
      vals,
    );
    return rows[0];
  });
}

export async function getFundraiserVersion(ref: string) {
  const f = await resolveFundraiser(ref);
  const { rows } = await getPool().query(`SELECT ${COLUMNS} FROM fundraisers WHERE id = $1`, [f.id]);
  return rows[0];
}
