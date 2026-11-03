'use client';
import { useEffect, useRef, useState } from 'react';
import { authHeaders, useViewer } from './viewer';

export default function FollowButton({ type, id, label = 'Follow', onChange }: { type: 'user' | 'fundraiser' | 'community'; id: string; label?: string; onChange?: () => void }) {
  const viewer = useViewer();
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const touched = useRef(false); // a click beats a slower initial lookup

  useEffect(() => {
    setFollowing(false);
    touched.current = false;
    if (!viewer) return;
    let live = true;
    fetch(`/api/v1/me/relations?type=${type}&id=${id}`, { headers: authHeaders() })
      .then((r) => r.json()).then((j) => live && !touched.current && setFollowing(Boolean(j.following))).catch(() => undefined);
    return () => { live = false; };
  }, [viewer, type, id]);

  async function toggle() {
    if (!viewer) { setNote('Pick a user in “Viewing as” to follow.'); return; }
    touched.current = true;
    setBusy(true); setNote('');
    const next = !following;
    setFollowing(next); // optimistic; rolled back on error
    const res = await fetch('/api/v1/follows', {
      method: next ? 'POST' : 'DELETE',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ target_type: type, target_id: id }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setFollowing(!next);
      setNote((await res?.json().catch(() => null))?.error?.message ?? 'Could not update. Try again.');
    } else onChange?.();
    setBusy(false);
  }
  return (
    <span className="follow">
      <button className={following ? 'btn ghost' : 'btn secondary'} onClick={toggle} disabled={busy} aria-pressed={following}>
        {following ? 'Following' : label}
      </button>
      {note && <small className="note" role="status">{note}</small>}
    </span>
  );
}
