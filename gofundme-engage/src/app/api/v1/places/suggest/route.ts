import { handle, json } from '@/lib/errors';
import { nearbyFundraisers, resolvePlace, starterIdeas } from '@/lib/places';
import { recentIncidents } from '@/lib/incidents';

// GET /api/v1/places/suggest?q=94404  or  ?q=Foster City, CA     US places only
// Returns the place, fundraisers already near it, what happened there in the last 6 months, and
// ideas for starting one (taken from those incidents first, then general starters).
export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  const place = resolvePlace(q);
  const [nearby, inc] = await Promise.all([nearbyFundraisers(place), recentIncidents(place)]);
  const fromIncidents = [...new Set(inc.incidents.map((i) => i.idea))];
  const ideas = [...fromIncidents, ...starterIdeas(place)].slice(0, 4);
  return json({ place, nearby, incidents: inc.incidents, incident_sources: { checked: inc.checked, failed: inc.failed }, ideas }, 200, { 'cache-control': 'private, no-store' });
});
