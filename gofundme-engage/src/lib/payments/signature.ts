import { createHmac, timingSafeEqual } from 'node:crypto';

function secret(): string {
  return process.env.WEBHOOK_SECRET ?? 'dev-secret';
}

export function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', secret()).update(body).digest('hex');
}

export function verifySignature(body: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
