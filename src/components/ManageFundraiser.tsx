'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { authHeaders, useViewer } from './viewer';

// Owner-only controls: post an update, change the goal or the photo, rename the fundraiser, or end it.
// Everyone else sees nothing.
// The API enforces this too (403 for anyone but the owner), so hiding the panel is only a courtesy.
const MAX_PHOTO = 2 * 1024 * 1024;

export default function ManageFundraiser({ slug, ownerId, hasCover }: { slug: string; ownerId: string; hasCover: boolean }) {
  const viewer = useViewer();
  const router = useRouter();
  const isOwner = !!viewer && viewer === ownerId;
  const [etag, setEtag] = useState<string | null>(null);
  const [status, setStatus] = useState('active');
  const [title, setTitle] = useState('');
  const [saved, setSaved] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [goal, setGoal] = useState('');
  const [savedGoal, setSavedGoal] = useState(0);
  const [cover, setCover] = useState(hasCover);
  const [draft, setDraft] = useState('');
  const [draftId, setDraftId] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/v1/fundraisers/${slug}`, { headers: authHeaders(), cache: 'no-store' });
    if (!r.ok) return;
    const f = await r.json();
    setEtag(r.headers.get('etag')); setStatus(f.status); setTitle(f.title); setSaved(f.title);
    setSavedGoal(Number(f.goal_cents)); setGoal(String(Number(f.goal_cents) / 100));
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
      if (r.ok) { setEtag(r.headers.get('etag')); setStatus(d.status); setTitle(d.title); setSaved(d.title); setSavedGoal(Number(d.goal_cents)); setGoal(String(Number(d.goal_cents) / 100)); router.refresh(); window.dispatchEvent(new Event('fundraiser:changed')); return true; }
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
  async function saveGoal(e: React.FormEvent) {
    e.preventDefault();
    const dollars = Number(goal);
    if (!Number.isFinite(dollars) || dollars < 1) return setError('The goal must be at least $1.');
    const cents = Math.round(dollars * 100);
    if (cents === savedGoal) return setNote('That is already the goal.');
    if (await patch({ goal_cents: cents })) setNote('Goal updated.');
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setNote('');
    if (file.size > MAX_PHOTO) return setError('The photo must be 2 MB or smaller.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setError('Use a JPEG, PNG or WebP image.');
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/fundraisers/${slug}/cover`, { method: 'POST', headers: { 'content-type': file.type, ...authHeaders() }, body: file });
      const d = await r.json();
      if (r.ok) { setCover(true); setNote('Photo updated.'); router.refresh(); }
      else setError(d.error?.message ?? 'That did not work.');
    } catch { setError('Could not reach the server. Nothing was changed.'); }
    finally { setBusy(false); }
  }
  async function removePhoto() {
    setBusy(true); setError(''); setNote('');
    try {
      const r = await fetch(`/api/v1/fundraisers/${slug}/cover`, { method: 'DELETE', headers: authHeaders() });
      if (r.ok) { setCover(false); setNote('Photo removed.'); router.refresh(); }
      else setError((await r.json().catch(() => null))?.error?.message ?? 'That did not work.');
    } catch { setError('Could not reach the server. Nothing was changed.'); }
    finally { setBusy(false); }
  }

  // The same client_id goes with every retry of one update, so a double click or a flaky connection posts it once.
  async function postUpdate(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setError(''); setNote('');
    const id = draftId || crypto.randomUUID();
    setDraftId(id);
    try {
      const r = await fetch(`/api/v1/fundraisers/${slug}/updates`, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ body, client_id: id }) });
      const d = await r.json();
      if (r.ok) { setDraft(''); setDraftId(''); setNote('Update posted. Followers and supporters will see it in their notifications.'); window.dispatchEvent(new Event('fundraiser:changed')); }
      else setError(d.error?.message ?? 'That did not work.');
    } catch { setError('Could not reach the server. Your update was not posted. Try again.'); }
    finally { setBusy(false); }
  }

  async function end() {
    if (await patch({ status: 'ended' })) setConfirming(false);
  }

  return (
    <section className="card manage" aria-labelledby="manage-h">
      <h2 id="manage-h">Manage your fundraiser</h2>
      {status !== 'draft' && (
        <form onSubmit={postUpdate} className="manage-row manage-block">
          <label htmlFor="manage-update">Post an update</label>
          <textarea id="manage-update" value={draft} maxLength={2000} rows={3} placeholder="Tell supporters what has happened and what the money is doing" onChange={(e) => setDraft(e.target.value)} />
          <div>
            <button className="btn" type="submit" disabled={busy || draft.trim().length === 0} style={{ width: 'auto' }}>Post update</button>
            <small className="muted" style={{ alignSelf: 'center' }}>{draft.length}/2000 · followers and supporters are notified</small>
          </div>
        </form>
      )}

      <form onSubmit={rename} className="manage-row manage-block">
        <label htmlFor="manage-title">Name</label>
        <div>
          <input id="manage-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          <button className="btn secondary" type="submit" disabled={busy || title.trim().length < 3} style={{ width: 'auto' }}>Save name</button>
        </div>
        <small className="muted">The web address stays the same, so shared links keep working.</small>
      </form>

      {status === 'active' && (
        <form onSubmit={saveGoal} className="manage-row manage-block">
          <label htmlFor="manage-goal">Goal (USD)</label>
          <div>
            <input id="manage-goal" inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <button className="btn secondary" type="submit" disabled={busy || goal.trim() === ''} style={{ width: 'auto' }}>Save goal</button>
          </div>
          <small className="muted">It cannot go below what has already been raised.</small>
        </form>
      )}

      <div className="manage-row manage-block">
        <label htmlFor="manage-photo">Cover photo</label>
        <div>
          <input id="manage-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={upload} disabled={busy} />
          {cover && <button className="btn secondary" type="button" onClick={removePhoto} disabled={busy} style={{ width: 'auto' }}>Remove photo</button>}
        </div>
        <small className="muted">JPEG, PNG or WebP, up to 2 MB.</small>
      </div>

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
