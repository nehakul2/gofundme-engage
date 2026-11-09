import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/lib/db';
import { closeRedis } from '@/lib/redis';
import { IDS, SLUGS } from '@/fixtures';
import { MAX_COVER_BYTES, sniffImage } from '@/lib/covers';
import { getFundraiserPage } from '@/lib/read';
import { resetAll } from './helpers';

beforeEach(resetAll);
afterAll(async () => { await closePool(); await closeRedis(); });

// Smallest valid-looking headers; the app checks the first bytes, not the whole image
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

async function route() { return import('@/app/api/v1/fundraisers/[ref]/cover/route'); }
const ctx = (ref: string = SLUGS.F1) => ({ params: Promise.resolve({ ref }) });
const upload = async (bytes: Uint8Array, type: string, user: string | null = IDS.U1, ref: string = SLUGS.F1) => {
  const { POST } = await route();
  const headers: Record<string, string> = { 'content-type': type };
  if (user) headers['x-user-id'] = user;
  return POST(new Request('http://x/', { method: 'POST', headers, body: bytes as unknown as BodyInit }), ctx(ref));
};

describe('COV: cover photos', () => {
  it('COV-01 recognises JPEG, PNG and WebP by their first bytes, and nothing else', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPG)).toBe('image/jpeg');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffImage(new Uint8Array([]))).toBeNull();
  });

  it('COV-02 the organizer uploads a photo, the page points at it, and it is served safely and cacheably', async () => {
    const res = await upload(PNG, 'image/png');
    expect(res.status).toBe(200);
    const { cover_image_url } = await res.json();
    expect(cover_image_url).toBe(`/api/v1/fundraisers/${IDS.F1}/cover?v=1`);
    expect((await getFundraiserPage(SLUGS.F1)).cover_image_url).toBe(cover_image_url);

    const { GET } = await route();
    const img = await GET(new Request('http://x/'), ctx());
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(img.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(img.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  });

  it('COV-03 guests get 401 and other people 403; nothing is stored', async () => {
    expect((await upload(PNG, 'image/png', null)).status).toBe(401);
    expect((await upload(PNG, 'image/png', IDS.U2)).status).toBe(403);
    expect((await getPool().query('SELECT 1 FROM fundraiser_covers')).rowCount).toBe(0);
  });

  it('COV-04 empty, too large, wrong type and mislabeled files are refused', async () => {
    expect((await upload(new Uint8Array([]), 'image/png')).status).toBe(400);
    const big = new Uint8Array(MAX_COVER_BYTES + 1); big.set(PNG);
    expect((await upload(big, 'image/png')).status).toBe(413);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r1 = await upload(svg, 'image/svg+xml');
    expect(r1.status).toBe(415);
    const r2 = await upload(svg, 'image/png'); // lies about being a PNG
    expect(r2.status).toBe(415);
    const r3 = await upload(JPG, 'image/png'); // a JPEG labelled as a PNG
    expect(r3.status).toBe(415);
    expect((await r3.json()).error.code).toBe('type_mismatch');
    expect((await getPool().query('SELECT 1 FROM fundraiser_covers')).rowCount).toBe(0);
  });

  it('COV-05 replacing a photo moves the version, so the new image gets a new address', async () => {
    await upload(PNG, 'image/png');
    const second = await (await upload(JPG, 'image/jpeg')).json();
    expect(second.cover_image_url).toBe(`/api/v1/fundraisers/${IDS.F1}/cover?v=2`);
    const { GET } = await route();
    expect((await GET(new Request('http://x/'), ctx())).headers.get('content-type')).toBe('image/jpeg');
  });

  it('COV-06 the organizer removes the photo; then there is nothing to serve', async () => {
    await upload(PNG, 'image/png');
    const { DELETE, GET } = await route();
    expect((await DELETE(new Request('http://x/', { method: 'DELETE' }), ctx())).status).toBe(401);
    expect((await DELETE(new Request('http://x/', { method: 'DELETE', headers: { 'x-user-id': IDS.U2 } }), ctx())).status).toBe(403);
    expect((await DELETE(new Request('http://x/', { method: 'DELETE', headers: { 'x-user-id': IDS.U1 } }), ctx())).status).toBe(200);
    expect((await getFundraiserPage(SLUGS.F1)).cover_image_url).toBeNull();
    expect((await GET(new Request('http://x/'), ctx())).status).toBe(404);
  });

  it('COV-07 an admin can take a photo down; a removed fundraiser takes no photo', async () => {
    await upload(PNG, 'image/png');
    const { DELETE } = await import('@/app/api/v1/admin/fundraisers/[ref]/cover/route');
    process.env.ADMIN_KEY = 'k';
    try {
      expect((await DELETE(new Request('http://x/', { method: 'DELETE' }), ctx())).status).toBe(403);
      expect((await DELETE(new Request('http://x/', { method: 'DELETE', headers: { 'x-admin-key': 'k' } }), ctx())).status).toBe(200);
    } finally { delete process.env.ADMIN_KEY; }
    expect((await getFundraiserPage(SLUGS.F1)).cover_image_url).toBeNull();
    expect((await upload(PNG, 'image/png', IDS.U1, SLUGS.F4)).status).toBe(410);
  });
});
