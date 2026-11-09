import { getPool, withTx } from './db';
import { ApiError } from './errors';
import { resolveFundraiser } from './stats';

// Cover photos. The image bytes live in Postgres (a 2 MB cap keeps that cheap) so the app needs no
// object store and a Railway redeploy cannot lose them. Moving to S3 later only changes this file.
//
// Safety: only the organizer can upload; the type is checked against the file's own first bytes, not
// just the header the browser sent; the image is served with nosniff and a locked-down CSP; an admin
// can remove one. There is no automatic image scanning, which is listed as a known gap in the README.

export const MAX_COVER_BYTES = 2 * 1024 * 1024;
export type CoverType = 'image/jpeg' | 'image/png' | 'image/webp';

export function sniffImage(b: Uint8Array): CoverType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export const coverUrl = (fundraiserId: string, version: number) => `/api/v1/fundraisers/${fundraiserId}/cover?v=${version}`;

export async function setCover(ref: string, userId: string | null, declaredType: string | null, bytes: Uint8Array) {
  if (!userId) throw new ApiError(401, 'unauthenticated', 'Sign in to change the photo');
  const f = await resolveFundraiser(ref);
  if (f.owner_id !== userId) throw new ApiError(403, 'forbidden', 'Only the organizer can change the photo');
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');
  if (bytes.length === 0) throw new ApiError(400, 'validation_failed', 'Choose an image first', 'file');
  if (bytes.length > MAX_COVER_BYTES) throw new ApiError(413, 'file_too_large', 'The photo must be 2 MB or smaller', 'file');
  const real = sniffImage(bytes);
  if (!real) throw new ApiError(415, 'unsupported_type', 'Use a JPEG, PNG or WebP image', 'file');
  if (declaredType && declaredType.split(';')[0].trim().toLowerCase() !== real) {
    throw new ApiError(415, 'type_mismatch', 'The file is not the type it says it is. Use a JPEG, PNG or WebP image', 'file');
  }
  return withTx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO fundraiser_covers (fundraiser_id, content_type, data) VALUES ($1,$2,$3)
       ON CONFLICT (fundraiser_id) DO UPDATE
         SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, version = fundraiser_covers.version + 1, updated_at = now()
       RETURNING version`,
      [f.id, real, Buffer.from(bytes)],
    );
    const url = coverUrl(f.id, rows[0].version);
    await c.query('UPDATE fundraisers SET cover_image_url = $2, updated_at = now() WHERE id = $1', [f.id, url]);
    return { cover_image_url: url };
  });
}

async function clear(fundraiserId: string) {
  await withTx(async (c) => {
    await c.query('DELETE FROM fundraiser_covers WHERE fundraiser_id = $1', [fundraiserId]);
    await c.query('UPDATE fundraisers SET cover_image_url = NULL, updated_at = now() WHERE id = $1', [fundraiserId]);
  });
}

export async function removeCover(ref: string, userId: string | null) {
  if (!userId) throw new ApiError(401, 'unauthenticated', 'Sign in to change the photo');
  const f = await resolveFundraiser(ref);
  if (f.owner_id !== userId) throw new ApiError(403, 'forbidden', 'Only the organizer can change the photo');
  await clear(f.id);
  return { cover_image_url: null };
}

// Admin removal, for an image that should not be on the site.
export async function adminRemoveCover(ref: string) {
  const f = await resolveFundraiser(ref);
  await clear(f.id);
  return { cover_image_url: null };
}

export async function getCover(ref: string) {
  const f = await resolveFundraiser(ref);
  if (f.status === 'removed') throw new ApiError(410, 'gone', 'This fundraiser has been removed');
  const { rows } = await getPool().query<{ content_type: string; data: Buffer }>(
    'SELECT content_type, data FROM fundraiser_covers WHERE fundraiser_id = $1', [f.id]);
  if (!rows[0]) throw new ApiError(404, 'not_found', 'No photo');
  return rows[0];
}
