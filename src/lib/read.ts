import { getPool } from './db';
import { ApiError } from './errors';
import { getStats, resolveFundraiser } from './stats';
import { listDonations } from './donations';
import { percentOfGoal } from './money';
import { getTimeline } from './updates';

// Read models for the three pages. Pages call these directly on the server.

interface Card { id: string; slug: string; title: string; status: string; goal_cents: number; raised_cents: number; donor_count: number; percent_of_goal: number }

export async function getFundraiserPage(ref: string) {
  const f = await resolveFundraiser(ref);
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');
  const pool = getPool();
  const [{ rows: detail }, stats, donations, communities, timeline] = await Promise.all([
    pool.query<{ owner_id: string; story: string; cover_image_url: string | null; ends_at: Date | null; created_at: Date; owner_handle: string; owner_name: string }>(
      `SELECT f.owner_id, f.story, f.cover_image_url, f.ends_at, f.created_at, u.handle AS owner_handle, u.display_name AS owner_name
         FROM fundraisers f JOIN users u ON u.id = f.owner_id WHERE f.id = $1`,
      [f.id],
    ),
    getStats(f.id),
    listDonations(f.id, 10),
    pool.query(
      `SELECT c.slug, c.name FROM community_fundraisers cf JOIN communities c ON c.id = cf.community_id
        WHERE cf.fundraiser_id = $1 ORDER BY c.name`,
      [f.id],
    ),
    getTimeline(f.id, 30),
  ]);
  return {
    id: f.id,
    slug: f.slug,
    title: f.title,
    status: f.status,
    ...detail[0],
    stats,
    donations,
    communities: communities.rows as { slug: string; name: string }[],
    timeline,
  };
}

async function fundraiserCards(where: string, params: unknown[]): Promise<Card[]> {
  const { rows } = await getPool().query<Omit<Card, 'percent_of_goal'>>(
    `SELECT f.id, f.slug, f.title, f.status, f.goal_cents,
            COALESCE(s.raised_cents, 0) AS raised_cents, COALESCE(s.donor_count, 0) AS donor_count
       FROM fundraisers f LEFT JOIN fundraiser_stats s ON s.fundraiser_id = f.id
      WHERE f.status IN ('active','ended') AND ${where}
      ORDER BY f.created_at DESC`,
    params,
  );
  return rows.map((r) => ({ ...r, percent_of_goal: percentOfGoal(r.raised_cents, r.goal_cents) }));
}

export async function getProfilePage(handle: string) {
  const pool = getPool();
  const user = (await pool.query<{ id: string; handle: string; display_name: string; bio: string | null; created_at: Date }>('SELECT id, handle, display_name, bio, created_at FROM users WHERE handle = $1', [handle])).rows[0];
  if (!user) throw new ApiError(404, 'not_found', 'Profile not found');
  const [fundraisers, communities, followers, given] = await Promise.all([
    fundraiserCards('f.owner_id = $1', [user.id]),
    pool.query(
      `SELECT c.slug, c.name, m.role FROM community_members m JOIN communities c ON c.id = m.community_id
        WHERE m.user_id = $1 ORDER BY c.name`,
      [user.id],
    ),
    pool.query("SELECT count(*)::int AS n FROM follows WHERE target_type = 'user' AND target_id = $1", [user.id]),
    pool.query("SELECT count(*)::int AS n FROM donations WHERE donor_id = $1 AND status = 'succeeded' AND NOT is_anonymous", [user.id]),
  ]);
  return {
    ...user,
    fundraisers,
    communities: communities.rows as { slug: string; name: string; role: string }[],
    follower_count: followers.rows[0].n as number,
    donations_made: given.rows[0].n as number,
  };
}

export async function getCommunityPage(slug: string) {
  const pool = getPool();
  const c = (await pool.query<{ id: string; slug: string; name: string; description: string | null; created_at: Date }>('SELECT id, slug, name, description, created_at FROM communities WHERE slug = $1', [slug])).rows[0];
  if (!c) throw new ApiError(404, 'not_found', 'Community not found');
  const [fundraisers, posts, members, counts] = await Promise.all([
    fundraiserCards('f.id IN (SELECT fundraiser_id FROM community_fundraisers WHERE community_id = $1)', [c.id]),
    pool.query(
      `SELECT p.id, p.body, p.kind, p.milestone_pct, p.created_at, u.handle, u.display_name,
              f.slug AS fundraiser_slug, f.title AS fundraiser_title
         FROM posts p JOIN users u ON u.id = p.author_id LEFT JOIN fundraisers f ON f.id = p.fundraiser_id
        WHERE p.community_id = $1 AND p.status = 'visible'
        ORDER BY p.created_at DESC, p.id DESC LIMIT 20`,
      [c.id],
    ),
    pool.query(
      `SELECT u.handle, u.display_name, m.role FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.community_id = $1 ORDER BY m.joined_at LIMIT 12`,
      [c.id],
    ),
    pool.query<{ members: number; followers: number; post_count: number }>(
      `SELECT (SELECT count(*)::int FROM community_members WHERE community_id = $1) AS members,
              (SELECT count(*)::int FROM follows WHERE target_type = 'community' AND target_id = $1) AS followers,
              (SELECT count(*)::int FROM posts WHERE community_id = $1 AND status = 'visible') AS post_count`,
      [c.id],
    ),
  ]);
  return {
    ...c,
    member_count: counts.rows[0].members,
    follower_count: counts.rows[0].followers,
    post_count: counts.rows[0].post_count,
    raised_cents: fundraisers.reduce((sum, f) => sum + Number(f.raised_cents), 0),
    fundraisers,
    posts: posts.rows as { id: string; body: string; kind: string; milestone_pct: number | null; fundraiser_slug: string | null; fundraiser_title: string | null; created_at: Date; handle: string; display_name: string }[],
    members: members.rows as { handle: string; display_name: string; role: string }[],
  };
}
