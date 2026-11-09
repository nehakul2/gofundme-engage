import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError } from '@/lib/errors';
import { formatUsd } from '@/lib/money';
import { searchFundraisers, type SearchResult } from '@/lib/search';

export const dynamic = 'force-dynamic';
type P = { searchParams: Promise<{ q?: string | string[] }> };

export const metadata: Metadata = { title: 'Search fundraisers | Engage' };

export default async function SearchPage({ searchParams }: P) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? '';

  let result: SearchResult | null = null;
  let problem: string | null = null;
  if (q.trim()) {
    try {
      result = await searchFundraisers(q);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) problem = e.message;
      else throw e;
    }
  }

  return (
    <>
      <h1>Find a fundraiser</h1>
      <form action="/search" role="search" className="searchbar">
        <label htmlFor="q">Search by title, story, organizer or link name</label>
        <div>
          <input id="q" name="q" type="search" defaultValue={q} maxLength={100} placeholder="For example: wildfire" />
          <button className="btn primary" type="submit">Search</button>
        </div>
      </form>

      {problem && <p className="error" role="alert">{problem}</p>}
      {!q.trim() && <p className="muted">Type a few words to see if a fundraiser exists and whether you can still contribute.</p>}

      {result && (
        <section aria-live="polite">
          <h2>{result.count === 0 ? `No fundraisers match "${result.query}"` : `${result.count} ${result.count === 1 ? 'fundraiser' : 'fundraisers'} for "${result.query}"`}</h2>
          {result.approximate && <p className="muted">No exact match, so these are the closest.</p>}
          {result.count === 0 && <p className="muted">Check the spelling, try fewer words, or <Link href="/">browse all fundraisers</Link>.</p>}
          <ul className="results">
            {result.results.map((r) => (
              <li key={r.id} className="card result">
                <div>
                  <h3><Link href={`/f/${r.slug}`}>{r.title}</Link></h3>
                  <p className="muted" style={{ margin: 0 }}>by <Link href={`/u/${r.owner_handle}`}>{r.owner_name}</Link></p>
                  <div className="bar" aria-hidden><div style={{ width: `${Math.min(r.percent_of_goal, 100)}%` }} /></div>
                  <p style={{ margin: 0 }}>{formatUsd(r.raised_cents)} of {formatUsd(r.goal_cents)} · {r.donor_count} {r.donor_count === 1 ? 'supporter' : 'supporters'}</p>
                </div>
                <div className="verdict">
                  {r.can_contribute ? (
                    <>
                      <span className="tag yes">Accepting donations</span>
                      <Link className="btn primary" href={`/f/${r.slug}#donate`}>Contribute</Link>
                    </>
                  ) : (
                    <>
                      <span className="tag no">Ended</span>
                      <p className="muted" style={{ margin: 0 }}>{r.contribute_note}</p>
                      <Link className="btn secondary" href={`/f/${r.slug}`}>View</Link>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
