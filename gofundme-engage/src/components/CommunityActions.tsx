'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders, useViewer } from './viewer';

interface State { member: boolean; role: string | null; can_add: { slug: string; title: string }[] }

// Join or leave the community, and (for members) list one of your own fundraisers in it.
export default function CommunityActions({ slug }: { slug: string }) {
  const viewer = useViewer();
  const router = useRouter();
  const [st, setSt] = useState<State | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/v1/communities/${slug}/me`, { headers: authHeaders(), cache: 'no-store' });
    if (r.ok) { const s = await r.json(); setSt(s); setPick(s.can_add[0]?.slug ?? ''); }
  }, [slug]);
  useEffect(() => { setSt(null); setNote(''); if (viewer) load().catch(() => {}); }, [viewer, load]);

  async function call(url: string, method: string, body?: unknown, ok = '') {
    setBusy(true); setNote('');
    try {
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...authHeaders() }, body: body ? JSON.stringify(body) : undefined });
      const d = await r.json();
      if (r.ok) { setNote(ok); await load(); router.refresh(); }
      else setNote(d.error?.message ?? 'That did not work.');
    } catch { setNote('Could not reach the server.'); }
    setBusy(false);
  }

  if (!viewer) return <p className="muted">Choose who you are under “Viewing as” to join this community.</p>;
  if (!st) return null;
  return (
    <section className="card manage" aria-label="Your membership">
      {st.member ? (
        <>
          <p style={{ marginTop: 0 }}>You are {st.role === 'owner' ? 'the owner' : 'a member'}.</p>
          {st.role !== 'owner' && (
            <button className="btn secondary" type="button" disabled={busy} style={{ width: 'auto' }}
              onClick={() => call(`/api/v1/communities/${slug}/members`, 'DELETE', undefined, 'You left the community.')}>Leave</button>
          )}
          {st.can_add.length > 0 && (
            <form style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); if (pick) call(`/api/v1/communities/${slug}/fundraisers`, 'POST', { fundraiser: pick }, 'Added to the community.'); }}>
              <label htmlFor="addfr" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>Add one of your fundraisers</label>
              <div className="manage-row"><div>
                <select id="addfr" value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1, minWidth: 0, font: 'inherit', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)' }}>
                  {st.can_add.map((f) => <option key={f.slug} value={f.slug}>{f.title}</option>)}
                </select>
                <button className="btn secondary" type="submit" disabled={busy || !pick} style={{ width: 'auto' }}>Add</button>
              </div></div>
            </form>
          )}
        </>
      ) : (
        <button className="btn primary" type="button" disabled={busy} style={{ width: 'auto' }}
          onClick={() => call(`/api/v1/communities/${slug}/members`, 'POST', undefined, 'Welcome. You joined the community.')}>Join this community</button>
      )}
      {note && <p role="status" className="muted">{note}</p>}
    </section>
  );
}
