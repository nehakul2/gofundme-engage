import { z } from 'zod';
import { getPool } from './db';
import { ApiError } from './errors';
import { classify, type RequestFacts } from './botfilter';

export type ActionType = 'donate' | 'share' | 'follow';

// Server-side meaningful actions. These come from our own code paths, so they skip bot filtering.
export async function recordAction(
  type: ActionType,
  visitorKey: string | null,
  target: { type: string; id: string },
  userId: string | null = null,
): Promise<void> {
  if (!visitorKey) return;
  await getPool().query(
    `INSERT INTO analytics_events (type, visitor_key, user_id, target_type, target_id) VALUES ($1,$2,$3,$4,$5)`,
    [type, visitorKey, userId, target.type, target.id],
  );
}

const UUID = /^[0-9a-f-]{36}$/i;
const EventSchema = z.object({
  type: z.literal('page_view'),
  path: z.string().max(300).startsWith('/'),
  target_type: z.enum(['fundraiser', 'community', 'user']).optional(),
  target_id: z.string().regex(UUID).optional(),
  // Set when the visit started from a notification link (?from=notification)
  source: z.literal('notification').optional(),
});

// Browser beacon. Always cheap; flagged events are stored with a reason.
export async function recordPageView(raw: unknown, facts: RequestFacts, userId: string | null) {
  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'validation_failed', parsed.error.issues[0].message, parsed.error.issues[0].path.join('.'));
  const botReason = await classify(facts);
  const e = parsed.data;
  await getPool().query(
    `INSERT INTO analytics_events (type, visitor_key, user_id, target_type, target_id, path, bot_reason, source)
     VALUES ('page_view', $1, $2, $3, $4, $5, $6, $7)`,
    [facts.visitorKey, userId, e.target_type ?? null, e.target_id ?? null, e.path, botReason, e.source ?? null],
  );
  return { counted: botReason === null };
}

// Repeat visit: a visitor seen on two or more different days (UTC) inside the window.
// Meaningful action: donate, share or follow. Both are per visitor, bot traffic excluded.
export async function engagementMetrics(days: number) {
  const d = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
  const pool = getPool();
  const { rows } = await pool.query(
    `WITH win AS (
       SELECT * FROM analytics_events WHERE bot_reason IS NULL AND created_at >= now() - $1::int * interval '1 day'
     ), visitors AS (
       SELECT visitor_key, count(DISTINCT date_trunc('day', created_at AT TIME ZONE 'UTC')) AS active_days
         FROM win WHERE type = 'page_view' GROUP BY 1
     ), actors AS (
       SELECT DISTINCT visitor_key FROM win WHERE type IN ('donate','share','follow')
     )
     SELECT count(*)::int AS visitors,
            count(*) FILTER (WHERE v.active_days >= 2)::int AS repeat_visitors,
            count(*) FILTER (WHERE a.visitor_key IS NOT NULL)::int AS visitors_who_acted,
            count(*) FILTER (WHERE v.active_days >= 2 AND a.visitor_key IS NOT NULL)::int AS repeat_who_acted,
            count(*) FILTER (WHERE v.active_days < 2 AND a.visitor_key IS NOT NULL)::int AS new_who_acted
       FROM visitors v LEFT JOIN actors a USING (visitor_key)`,
    [d],
  );
  const actions = await pool.query(
    `SELECT type, count(*)::int AS n FROM analytics_events
      WHERE bot_reason IS NULL AND type <> 'page_view' AND created_at >= now() - $1::int * interval '1 day' GROUP BY 1`,
    [d],
  );
  const excluded = await pool.query(
    `SELECT bot_reason, count(*)::int AS n FROM analytics_events
      WHERE bot_reason IS NOT NULL AND created_at >= now() - $1::int * interval '1 day' GROUP BY 1 ORDER BY 2 DESC`,
    [d],
  );
  // Visits that began from a bell notification: how much the updates and milestones bring people back
  const fromBell = await pool.query(
    `SELECT count(*)::int AS visits, count(DISTINCT visitor_key)::int AS visitors FROM analytics_events
      WHERE bot_reason IS NULL AND type = 'page_view' AND source = 'notification' AND created_at >= now() - $1::int * interval '1 day'`,
    [d],
  );
  const r = rows[0];
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const newVisitors = r.visitors - r.repeat_visitors;
  return {
    window_days: d,
    visitors: r.visitors,
    repeat_visitors: r.repeat_visitors,
    repeat_visit_rate_pct: rate(r.repeat_visitors, r.visitors),
    visitors_who_acted: r.visitors_who_acted,
    action_rate_pct: rate(r.visitors_who_acted, r.visitors),
    action_rate_repeat_pct: rate(r.repeat_who_acted, r.repeat_visitors),
    action_rate_new_pct: rate(r.new_who_acted, newVisitors),
    notification_visits: fromBell.rows[0].visits as number,
    notification_visitors: fromBell.rows[0].visitors as number,
    actions: Object.fromEntries(actions.rows.map((x) => [x.type, x.n])),
    excluded_bot_events: Object.fromEntries(excluded.rows.map((x) => [x.bot_reason, x.n])),
  };
}
