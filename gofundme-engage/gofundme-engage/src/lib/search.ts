import { z } from 'zod';
import { getPool } from './db';
import { ApiError } from './errors';
import { percentOfGoal } from './money';

// Fundraiser search. Only public fundraisers (active or ended) are searchable: drafts and
// removed fundraisers never appear. Every word must match the title, the story, the
// organizer's name or the slug. Each hit says whether the visitor can still contribute.

const QuerySchema = z.string().trim().min(2, 'Type at least 2 characters').max(100, 'Search is limited to 100 characters');

export interface SearchHit {
  id: string;
  slug: string;
  title: string;
  owner_name: string;
  owner_handle: string;
  status: 'active' | 'ended';
  goal_cents: number;
  raised_cents: number;
  donor_count: number;
  percent_of_goal: number;
  can_contribute: boolean;
  contribute_note: string | null;
}

// approximate = no exact match for the words typed, so these are the closest ones
export interface SearchResult { query: string; count: number; approximate: boolean; results: SearchHit[] }

// Words that say "do we have a fundraiser for ..." rather than what the fundraiser is about.
const FILLER = new Set(('a an and any anyone anything are be can could do does for from get give have has help how i if in is it find found '
  + 'is looking look me my need of on or our please search see show some someone there this that the to us want we what where which with would you '
  + 'fundraiser fundraisers fundraising campaign campaigns donate donation donations contribute exist exists').split(' '));

export function significantWords(words: string[]): string[] {
  const kept = words.filter((w) => !FILLER.has(w.toLowerCase().replace(/[^a-z]/g, '')));
  return kept.length ? kept : words;
}

const SIMILARITY = 0.5;

// % _ and \ are wildcards in LIKE; a visitor typing "50%" means the characters.
export function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchFundraisers(rawQuery: unknown, rawLimit: unknown = 20): Promise<SearchResult> {
  const parsed = QuerySchema.safeParse(typeof rawQuery === 'string' ? rawQuery : '');
  if (!parsed.success) throw new ApiError(400, 'validation_failed', parsed.error.issues[0].message, 'q');
  const query = parsed.data.replace(/\s+/g, ' ').replace(/\bfund[\s-]raisers?\b/gi, 'fundraiser');
  const typed = query.split(' ');
  const words = typed.slice(0, 6);
  const n = Number(rawLimit);
  const limit = Number.isInteger(n) ? Math.min(Math.max(n, 1), 50) : 20;

  const run = async (ws: string[], fuzzy: boolean) => {
    const like = ws.map(likePattern);
    const exact = ws.map((_, i) => `(f.title ILIKE $${i + 1} OR f.story ILIKE $${i + 1} OR u.display_name ILIKE $${i + 1} OR f.slug::text ILIKE $${i + 1})`);
    const params: unknown[] = [...like];
    let where: string;
    let score = '0::int';
    if (fuzzy) {
      // A word counts if it appears, or is spelled almost like a word in the title or organizer.
      const hit = ws.map((w, i) => {
        if (w.length < 3) return exact[i];           // too short to compare by spelling
        params.push(w);
        const raw = `$${params.length}::text`;
        return `(${exact[i]} OR word_similarity(${raw}, f.title) > ${SIMILARITY} OR word_similarity(${raw}, u.display_name) > ${SIMILARITY})`;
      });
      score = hit.map((h) => `(CASE WHEN ${h} THEN 1 ELSE 0 END)`).join(' + ');
      where = `(${score}) >= ${Math.max(1, Math.ceil(ws.length * 0.6))}`;
    } else {
      where = exact.join(' AND ');
    }
    params.push(likePattern(ws[0]), limit);
    const first = `$${params.length - 1}`;
    const res = await getPool().query(
      `SELECT f.id, f.slug, f.title, f.status, f.goal_cents,
              u.display_name AS owner_name, u.handle AS owner_handle,
              COALESCE(s.raised_cents, 0) AS raised_cents, COALESCE(s.donor_count, 0) AS donor_count
         FROM fundraisers f
         JOIN users u ON u.id = f.owner_id
         LEFT JOIN fundraiser_stats s ON s.fundraiser_id = f.id
        WHERE f.status IN ('active','ended') AND ${where}
        ORDER BY (${score}) DESC, (f.title ILIKE ${first}) DESC, (f.status = 'active') DESC, COALESCE(s.raised_cents, 0) DESC, f.id
        LIMIT $${params.length}`,
      params,
    );
    return res.rows;
  };

  // 1. every word typed; 2. without the "do we have a fundraiser for" part; 3. close spellings
  const core = significantWords(typed).slice(0, 8);   // questions are long: drop filler before capping
  let rows = await run(words, false);
  let approximate = false;
  if (!rows.length && core.join(' ') !== words.join(' ')) rows = await run(core, false);
  if (!rows.length) { rows = await run(core, true); approximate = rows.length > 0; }

  const results: SearchHit[] = rows.map((r) => {
    const active = r.status === 'active';
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      owner_name: r.owner_name,
      owner_handle: r.owner_handle,
      status: r.status,
      goal_cents: Number(r.goal_cents),
      raised_cents: Number(r.raised_cents),
      donor_count: Number(r.donor_count),
      percent_of_goal: percentOfGoal(Number(r.raised_cents), Number(r.goal_cents)),
      can_contribute: active,
      contribute_note: active ? null : 'This fundraiser has ended and is not accepting donations.',
    };
  });
  return { query, count: results.length, approximate, results };
}
