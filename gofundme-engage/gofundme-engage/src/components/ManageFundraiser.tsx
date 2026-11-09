'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders, useViewer } from './viewer';

// Owner-only controls: rename the fundraiser, or end it. Everyone else sees nothing.
// The API enforces this too (403 for anyone but the owner), so hiding the panel is only a courtesy.
export default function ManageFundraiser({ slug, ownerId }: { slug: string; ownerId: string }) {
  const viewer = useViewer();
  const router = useRouter();
  const isOwner = !!viewer && viewer === ownerId;
  const [etag, setEtag] = useState<string | null>(null);
  const [status, setStatus] = useState('active');
  const [title, setTitle] = useState('');
  const [saved, setSaved] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/v1/fundraisers/${slug}`, { headers: authHeaders(), cache: 'no-store' });
    if (!r.ok) return;
    const f = await r.json();
    setEtag(r.headers.get('etag')); setStatus(f.status); setTitle(f.title); setSaved(f.title);
  }, [slug]);

  useEffect(() => { if (isOwner) load().catch(() => {}); }, [isOwner, load]);
  if (!isOwner || !etag) return null;

  async function patch(body: Record<string, unknown>) {
    setBusy(true); setError(''); setNote('');
    try {
      const r = await fetch(`/api/v1/fundraisers/${slug}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': etag!, ...authHeaders() },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (r.ok) { setEtag(r.headers.get('etag')); setStatus(d.status); setTitle(d.title); setSaved(d.title); router.refresh(); window.dispatchEvent(new Event('fundraiser:changed')); return true; }
      if (r.status === 412) { await load(); setError('This fundraiser changed since you opened it. I reloaded it. Please try again.'); }
      else if (r.status === 403) setError('Only the organizer can change this fundraiser.');
      else setError(d.error?.message ?? 'That did not work.');
    } catch { setError('Could not reach the server. Nothing was changed.'); }
    finally { setBusy(false); }
    return false;
  }

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (t === saved) return setNote('That is already the name.');
    if (await patch({ title: t })) setNote('Name updated.');
  }
  async function end() {
    if (await patch({ status: 'ended' })) setConfirming(false);
  }

  return (
    <section className="card manage" aria-labelledby="manage-h">
      <h2 id="manage-h">Manage your fundraiser</h2>
      <form onSubmit={rename} className="manage-row">
        <label htmlFor="manage-title">Name</label>
        <div>
          <input id="manage-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          <button className="btn secondary" type="submit" disabled={busy || title.trim().length < 3} style={{ width: 'auto' }}>Save name</button>
        </div>
        <small className="muted">The web address stays the same, so shared links keep working.</small>
      </form>

      {status === 'ended' ? (
        <p className="muted" style={{ margin: '16px 0 0' }}>This fundraiser has ended. It no longer takes donations or chat messages, and it cannot be reopened.</p>
      ) : confirming ? (
        <div className="manage-confirm" role="alertdialog" aria-labelledby="end-q">
          <p id="end-q"><strong>End this fundraiser?</strong> Donations and chat stop for good. People can still read the page. This cannot be undone.</p>
          <div className="manage-actions">
            <button className="btn danger" onClick={end} disabled={busy} style={{ width: 'auto' }}>Yes, end it</button>
            <button className="btn secondary" onClick={() => setConfirming(false)} disabled={busy} style={{ width: 'auto' }}>Keep it open</button>
          </div>
        </div>
      ) : (
        <div className="manage-actions"><button className="btn secondary" onClick={() => setConfirming(true)} style={{ width: 'auto' }}>End fundraiser</button></div>
      )}
      {note && <p role="status" className="muted">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
