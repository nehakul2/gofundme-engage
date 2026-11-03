// Fixed IDs that match the "Shared fixtures" table in the test case matrix.
// Used by the seed script and by the automated tests.

const id = (kind: string, n: number) =>
  `01930000-0000-7000-8000-${kind}${n.toString(16).padStart(8, '0')}`;

export const IDS = {
  U1: id('0001', 1), // fundraiser owner
  U2: id('0001', 2), // donor
  U3: id('0001', 3), // donor
  U4: id('0001', 4), // moderator of C1
  U5: id('0001', 5), // new user, no fundraisers
  F1: id('0002', 1), // active, goal $50,000, nothing raised
  F2: id('0002', 2), // active, 1,000 cents short of goal
  F3: id('0002', 3), // ended, 12 donations
  F4: id('0002', 4), // removed
  C1: id('0003', 1), // public community with F1, F2, F3
  C2: id('0003', 2), // empty community
} as const;

export const SLUGS = {
  F1: 'wildfire-alerts',
  F2: 'near-goal',
  F3: 'ended-campaign',
  F4: 'removed-campaign',
  C1: 'watch-duty',
  C2: 'empty-community',
} as const;

export const GOAL_CENTS = 5_000_000; // $50,000
