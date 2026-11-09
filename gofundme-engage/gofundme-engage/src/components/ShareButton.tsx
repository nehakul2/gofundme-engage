'use client';
import { useState } from 'react';
import { authHeaders } from './viewer';

export default function ShareButton({ slug, onChange }: { slug: string; onChange?: () => void }) {
  const [msg, setMsg] = useState('');
  async function share() {
    const native = typeof navigator.share === 'function';
    const url = window.location.href;
    try {
      if (native) await navigator.share({ url });
      else await navigator.clipboard.writeText(url);
      setMsg(native ? 'Shared' : 'Link copied');
    } catch { setMsg('Copy the link from your address bar'); }
    fetch(`/api/v1/fundraisers/${slug}/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ channel: native ? 'other' : 'copy_link' }),
    }).then(() => onChange?.()).catch(() => undefined);
    setTimeout(() => setMsg(''), 2500);
  }
  return (
    <span className="follow">
      <button className="btn secondary" onClick={share}>Share</button>
      {msg && <small className="note" role="status">{msg}</small>}
    </span>
  );
}
