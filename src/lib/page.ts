import { notFound } from 'next/navigation';
import { ApiError } from './errors';

// Pages treat 404 as not-found and 410 as "removed"; anything else is a real error.
export async function load<T>(fn: () => Promise<T>): Promise<T | 'gone'> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    if (e instanceof ApiError && e.status === 410) return 'gone';
    throw e;
  }
}
