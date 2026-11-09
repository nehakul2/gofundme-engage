import { getPool } from './db';
import { getRedis, keys } from './redis';
import { ApiError } from './errors';
import { UUID_RE } from './ids';
import { percentOfGoal } from './money';

export interface FundraiserRow {
  id: string;
  owner_id: string;
  slug: string;
  title: string;
  goal_cents: number;
  status: 'draft' | 'active' | 'ended' | 'removed';
}

// The route param is a slug or a UUID.
export async function resolveFundraiser(ref: string): Promise<FundraiserRow> {
  const byId = UUID_RE.test(ref);
  const { rows } = await getPool().query(
    `SELECT id, owner_id, slug, title, goal_cents, status FROM fundraisers WHERE ${byId ? 'id' : 'slug'} = $1`,
    [ref],
  );
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Fundraiser not found');
  return rows[0];
}

export async function getStats(ref: string) {
  const f = await resolveFundraiser(ref);
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');

  let live = await getRedis().hgetall(keys.stats(f.id));
  let updatedAt: string | null = null;
  if (!live.raised_cents) {
    const row = (
      await getPool().query('SELECT * FROM fundraiser_stats WHERE fundraiser_id = $1', [f.id])
    ).rows[0];
    live = row ?? { raised_cents: 0, donor_count: 0, share_count: 0, follower_count: 0 };
    updatedAt = row?.updated_at?.toISOString?.() ?? null;
  }
  const raised = Number(live.raised_cents);
  return {
    fundraiser_id: f.id,
    status: f.status,
    goal_cents: f.goal_cents,
    currency: 'USD',
    raised_cents: raised,
    donor_count: Number(live.donor_count),
    share_count: Number(live.share_count ?? 0),
    follower_count: Number(live.follower_count ?? 0),
    percent_of_goal: percentOfGoal(raised, f.goal_cents),
    updated_at: updatedAt,
  };
}
