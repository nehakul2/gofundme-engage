import { getRedis } from './redis';

// Three layers, cheapest first. A flagged event is stored with its reason and
// excluded from metrics, so a rule can be tuned later without losing data.
//   1. static network rules   INTERNAL_CIDRS (office and VPN ranges, health checkers)
//   2. deterministic markers  internal key header, synthetic visitor ids, our own test agent
//   3. behavior               crawler user agents, and visitors firing events too fast

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|httpclient/i;
export const MAX_EVENTS_PER_MINUTE = 30;

function ipToInt(ip: string): number | null {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.trim().split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export interface RequestFacts {
  ip: string | null;
  userAgent: string | null;
  internalKey: string | null;
  visitorKey: string;
}

export async function classify(f: RequestFacts, now = Date.now()): Promise<string | null> {
  const cidrs = (process.env.INTERNAL_CIDRS ?? '').split(',').filter(Boolean);
  if (f.ip && cidrs.some((c) => inCidr(f.ip!, c))) return 'internal_network';

  const secret = process.env.INTERNAL_TRAFFIC_KEY;
  if (secret && f.internalKey === secret) return 'internal_key';
  if (f.visitorKey.startsWith('synthetic_')) return 'synthetic_visitor';
  if (f.userAgent?.includes('GoFundMe-Synthetic')) return 'synthetic_agent';

  if (!f.userAgent || BOT_UA.test(f.userAgent)) return 'bot_user_agent';

  const r = getRedis();
  const key = `bot:rate:${f.visitorKey}:${Math.floor(now / 60_000)}`;
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, 120);
  if (n > MAX_EVENTS_PER_MINUTE) return 'rate_limit';
  return null;
}
