'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authHeaders, useViewer } from './viewer';

const MAX_PHOTO = 2 * 1024 * 1024;
const field: React.CSSProperties = { width: '100%', font: 'inherit', padding: '12px 14px', border: '1px solid #BDBDBD', borderRadius: 10, background: 'var(--card)', color: 'var(--ink)' };

// The start-a-fundraiser form: title, goal, story, optional zip and photo. Creates and publishes, then opens the new page.
export default function StartFundraiser() {
  const viewer = useViewer();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [story, setStory] = useState('');
  const [zip, setZip] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErr, setFieldErr] = useState('');

  const goalCents = Math.round(parseFloat(goal) * 100);
  const valid = title.trim().length >= 3 && Number.isFinite(goalCents) && goalCents >= 100 && story.trim().length > 0;

  function pickPhoto(f: File | null) {
    setError('');
    if (f && !['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { setError('Use a JPEG, PNG or WebP photo.'); return; }
    if (f && f.size > MAX_PHOTO) { setError('That photo is over 2 MB. Choose a smaller one.'); return; }
    setPhoto(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !valid) return;
    setBusy(true); setError(''); setFieldErr('');
    try {
      const r = await fetch('/api/v1/fundraisers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ title, story, goal_cents: goalCents, publish: true, ...(zip.trim() ? { zip: zip.trim() } : {}) }),
      });
      const f = await r.json();
      if (!r.ok) {
        setFieldErr(f.error?.field ?? '');
        setError(r.status === 401 ? 'Choose who you are under “Viewing as” at the top of the page, then try again.' : f.error?.message ?? 'That did not work.');
        setBusy(false);
        return;
      }
      if (photo) {
        // The fundraiser is already live; a failed photo upload should not lose it.
        await fetch(`/api/v1/fundraisers/${f.slug}/cover`, { method: 'POST', headers: { 'content-type': photo.type, ...authHeaders() }, body: photo }).catch(() => undefined);
      }
      router.push(`/f/${f.slug}`);
    } catch { setError('Could not reach the server. Nothing was created.'); setBusy(false); }
  }

  return (
    <form className="startform" onSubmit={submit} aria-label="Start a fundraiser">
      {!viewer && <p className="banner" role="status">Choose who you are under “Viewing as” at the top of the page to continue.</p>}
      <div className="manage-row">
        <label htmlFor="sf-title">Fundraiser title</label>
        <input id="sf-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} style={field} placeholder="Help rebuild after the storm" aria-invalid={fieldErr === 'title'} />
      </div>
      <div className="manage-row">
        <label htmlFor="sf-goal">Goal (USD)</label>
        <input id="sf-goal" inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value.replace(/[^0-9.]/g, ''))} style={field} placeholder="5000" aria-invalid={fieldErr === 'goal_cents'} />
      </div>
      <div className="manage-row">
        <label htmlFor="sf-story">Your story</label>
        <textarea id="sf-story" rows={8} value={story} maxLength={20000} onChange={(e) => setStory(e.target.value)} style={field} placeholder="Who is this for, what happened, and how will the money be used?" aria-invalid={fieldErr === 'story'} />
      </div>
      <div className="manage-row">
        <label htmlFor="sf-zip">US zip code (optional, helps people nearby find it)</label>
        <input id="sf-zip" inputMode="numeric" value={zip} maxLength={5} onChange={(e) => setZip(e.target.value.replace(/\D/g, ''))} style={{ ...field, maxWidth: 180 }} aria-invalid={fieldErr === 'zip'} />
      </div>
      <div className="manage-row">
        <label htmlFor="sf-photo">Cover photo (optional, JPEG, PNG or WebP, up to 2 MB)</label>
        <input id="sf-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="manage-actions">
        <button className="btn primary" type="submit" disabled={busy || !valid || !viewer} style={{ width: 'auto' }}>{busy ? 'Creating…' : 'Publish fundraiser'}</button>
      </div>
    </form>
  );
}
