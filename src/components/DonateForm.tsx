'use client';
import { useRef, useState } from 'react';
import { MAX_DONATION_CENTS, formatUsd } from '@/lib/money';
import { authHeaders } from './viewer';

type Phase = 'idle' | 'sending' | 'confirming' | 'done' | 'failed';
const PRESETS = [2500, 5000, 10000, 25000];

export default function DonateForm({ slug, onDone, bare = false }: { slug: string; onDone: () => void; bare?: boolean }) {
  const [cents, setCents] = useState(5000);
  const [custom, setCustom] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [anon, setAnon] = useState(false);
  const [card, setCard] = useState('pm_test_ok');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  // One key per attempt: a double click or a retry after a network error reuses it
  const key = useRef<string | null>(null);

  function pickCustom(v: string) {
    setCustom(v);
    const n = Math.round(Number(v) * 100);
    setCents(Number.isFinite(n) ? n : 0);
    key.current = null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (phase === 'sending' || phase === 'confirming') return;
    if (!Number.isInteger(cents) || cents < 100 || cents > MAX_DONATION_CENTS) {
      setError(`Enter an amount between $1 and ${formatUsd(MAX_DONATION_CENTS)}.`);
      return;
    }
    setError(''); setPhase('sending');
    key.current ??= crypto.randomUUID();
    try {
      const res = await fetch(`/api/v1/fundraisers/${slug}/donations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key.current, ...authHeaders() },
        body: JSON.stringify({
          amount_cents: cents, currency: 'USD', is_anonymous: anon, payment_method_token: card,
          ...(name.trim() ? { display_name: name.trim() } : {}), ...(message.trim() ? { message: message.trim() } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) { key.current = res.status === 502 ? null : key.current; throw new Error(body.error?.message ?? 'Donation failed'); }
      setPhase('confirming');
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const s = await (await fetch(`/api/v1/donations/${body.id}`)).json();
        if (s.status === 'succeeded') { setPhase('done'); key.current = null; onDone(); return; }
        if (s.status === 'failed' || s.status === 'refunded') throw new Error('Your payment was declined. No money was taken.');
      }
      throw new Error('Still waiting on the payment provider. Your donation will show up once it confirms.');
    } catch (err) {
      setError((err as Error).message);
      setPhase('failed');
      if (card !== 'pm_test_ok') key.current = null;
    }
  }

  if (phase === 'done') {
    return (
      <div className={bare ? 'thanks' : 'card thanks'} role="status">
        <h3>Thank you!</h3>
        <p>Your {formatUsd(cents)} donation went through.</p>
        <button className="btn secondary" onClick={() => { setPhase('idle'); }}>Donate again</button>
      </div>
    );
  }
  const busy = phase === 'sending' || phase === 'confirming';
  return (
    <form className={bare ? 'donate' : 'card donate'} onSubmit={submit} noValidate>
      {bare ? <p className="legend" id="amount-legend">Choose an amount</p> : <h3>Donate</h3>}
      <div className="presets" role="group" aria-label="Amount" aria-labelledby={bare ? 'amount-legend' : undefined}>
        {PRESETS.map((p) => (
          <button type="button" key={p} className={cents === p && !custom ? 'chip on' : 'chip'} onClick={() => { setCents(p); setCustom(''); key.current = null; }}>
            {formatUsd(p)}
          </button>
        ))}
      </div>
      <label>Other amount (USD)
        <input inputMode="decimal" placeholder="e.g. 40" value={custom} onChange={(e) => pickCustom(e.target.value)} />
      </label>
      <label>Your name (optional)
        <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>Message (optional)
        <textarea value={message} maxLength={500} rows={2} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <label className="check"><input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} /> Donate anonymously</label>
      <label>Test card
        <select value={card} onChange={(e) => { setCard(e.target.value); key.current = null; }}>
          <option value="pm_test_ok">Visa 4242 (succeeds)</option>
          <option value="pm_test_decline">Visa 0002 (declined)</option>
        </select>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>
        {phase === 'sending' ? 'Sending…' : phase === 'confirming' ? 'Confirming payment…' : `Donate ${formatUsd(cents || 0)}`}
      </button>
    </form>
  );
}
