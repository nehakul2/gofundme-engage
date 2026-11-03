'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authHeaders, useViewer } from './viewer';

// Home-page form: name and a short description. The creator becomes the owner and lands on the new page.
export default function CreateCommunity() {
  const viewer = useViewer();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/v1/communities', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name, description }),
      });
      const c = await r.json();
      if (r.ok) { router.push(`/c/${c.slug}`); return; }
      setError(r.status === 401 ? 'Choose who you are under “Viewing as” at the top of the page, then try again.' : c.error?.message ?? 'That did not work.');
    } catch { setError('Could not reach the server. Nothing was created.'); }
    setBusy(false);
  }

  if (!open) return <button className="btn secondary" type="button" onClick={() => setOpen(true)} style={{ width: 'auto' }}>Start a community</button>;
  return (
    <form className="card manage" onSubmit={submit} aria-labelledby="newc-h">
      <h3 id="newc-h" style={{ marginTop: 0 }}>Start a community</h3>
      {!viewer && <p className="muted">Choose who you are under “Viewing as” at the top first.</p>}
      <div className="manage-row">
        <label htmlFor="newc-name">Name</label>
        <input id="newc-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} style={{ width: '100%', font: 'inherit', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)' }} />
      </div>
      <div className="manage-row" style={{ marginTop: 12 }}>
        <label htmlFor="newc-desc">What is it for? (optional)</label>
        <textarea id="newc-desc" rows={3} value={description} maxLength={280} onChange={(e) => setDescription(e.target.value)} style={{ width: '100%', font: 'inherit', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)' }} />
        <small className="muted">{description.length}/280</small>
      </div>
      <div className="manage-actions">
        <button className="btn primary" type="submit" disabled={busy || name.trim().length < 3 || !viewer} style={{ width: 'auto' }}>Create community</button>
        <button className="btn secondary" type="button" onClick={() => setOpen(false)} disabled={busy} style={{ width: 'auto' }}>Cancel</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
