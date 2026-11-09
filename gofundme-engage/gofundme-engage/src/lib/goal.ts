// Turns what a person types as a goal ("$5,000", "5000", "2.5k") into integer cents.
// Returns null when it is not a usable amount. Limits match the create API: $1 to $1,000,000,000.
export const MIN_GOAL_CENTS = 100;
export const MAX_GOAL_CENTS = 100_000_000_000;

export function parseGoalCents(input: string): number | null {
  const m = /^\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?|\.[0-9]{1,2})\s*([km])?\s*(?:usd|dollars?)?\s*$/i.exec(input);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const scale = m[2] ? (m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1;
  const cents = Math.round(n * scale * 100);
  return cents >= MIN_GOAL_CENTS && cents <= MAX_GOAL_CENTS ? cents : null;
}
