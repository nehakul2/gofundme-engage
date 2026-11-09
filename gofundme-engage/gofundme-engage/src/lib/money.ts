// Money is always integer cents in USD, the only supported currency.

// Largest single donation we accept: $1,000,000. Proposed limit; adjust with the team.
export const MAX_DONATION_CENTS = 100_000_000;

export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
  }).format(dollars);
}

// Integer percent of goal reached (floor), never negative
export function percentOfGoal(raisedCents: number, goalCents: number): number {
  if (goalCents <= 0) return 0;
  return Math.max(0, Math.floor((raisedCents * 100) / goalCents));
}
