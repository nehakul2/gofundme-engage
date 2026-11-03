import Redis from 'ioredis';

let client: Redis | undefined;

export function getRedis(): Redis {
  client ??= new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return client;
}

export async function closeRedis(): Promise<void> {
  const c = client;
  client = undefined;
  await c?.quit();
}

// Key names. Keys for one fundraiser share a hash tag so they land in one cluster slot.
export const keys = {
  stats: (fid: string) => `fr:{${fid}}:stats`,
  delta: (fid: string) => `fr:{${fid}}:delta`,
  recent: (fid: string) => `fr:{${fid}}:recent`,
  pulse: (fid: string) => `fr:{${fid}}:pulse`,
  top: (fid: string) => `fr:{${fid}}:top`,
  chatSeq: (fid: string) => `fr:{${fid}}:chat:seq`,
  chatRate: (userId: string) => `chat:{${userId}}:rate`,
  createRate: (userId: string) => `fundraiser:{${userId}}:create-rate`,
  communityRate: (userId: string) => `community:{${userId}}:create-rate`,
  event: (fid: string, eventId: string | number) => `ev:{${fid}}:${eventId}`,
  dirty: 'flush:dirty',
  unread: (userId: string) => `me:{${userId}}:unread`,
};
