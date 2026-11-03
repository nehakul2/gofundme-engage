'use client';
import { useCallback, useEffect, useState } from 'react';

interface Metrics {
  window_days: number; visitors: number; repeat_visitors: number; repeat_visit_rate_pct: number;
  visitors_who_acted: number; action_rate_pct: number; action_rate_repeat_pct: number; action_rate_new_pct: number;
  actions: Record<string, number>; excluded_bot_events: Record<string, number>;
}
interface Report { message_id: string; body: string; author: string; handle: string; room: string; reports: number; reasons: string[] }

const KEY = 'admin-key';
const read = () => { try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; } };
const write = (v: string) => { try { sessionStorage.setItem(KEY, v); } catch { /* storage blocked */ } };
const field = { font: 'inherit', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)', color: 'var(--ink)', minHeight: 44 } as const;

// Admin view: engagement numbers, the chat report queue and the blocked-word list.
// The key is only kept for this browser tab. When the server has no ADMIN_KEY (local dev) it is not needed.
export default function AdminDashboard() {
  const [key, setKey] = useState('');
  const [days, setDays] = useState(7);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const [word, setWord] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => { setKey(read()); }, []);
  const hdr = useCallback((): Record<string, string> => (key ? { 'x-admin-key': key } : {}), [key]);

  const load = useCallback(async () => {
    setError('');
    try {
      const [m, r, w] = await Promise.all([
        fetch(`/api/v1/metrics/engagement?days=${days}`, { headers: hdr(), cache: 'no-store' }),
        fetch('/api/v1/admin/reports', { headers: hdr(), cache: 'no-store' }),
        fetch('/api/v1/admin/words', { headers: hdr(), cache: 'no-store' }),
      ]);
      if (m.status === 403 || r.status === 403 || w.status === 403) {
        setMetrics(null); setReports(null); setWords(null);
        setError(key ? 'That admin key was not accepted.' : 'Enter the admin key to continue.');
        return;
      }
      setMetrics(m.ok ? await m.json() : null);
      setReports(r.ok ? (await r.json()).reports : null);
      setWords(w.ok ? (await w.json()).words : null);
    } catch { setError('Could not reach the server.'); }
  }, [days, hdr, key]);
  useEffect(() => { load(); }, [load]);

  async function resolve(id: string, action: 'remove' | 'dismiss') {
    setNote('');
    const r = await fetch(`/api/v1/admin/reports/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr() }, body: JSON.stringify({ action }) });
    if (r.ok) { setNote(action === 'remove' ? 'Message removed.' : 'Report dismissed.'); load(); }
    else setError((await r.json().catch(() => null))?.error?.message ?? 'That did not work.');
  }
  async function wordOp(method: 'POST' | 'DELETE', w: string) {
    setNote(''); setError('');
    const r = await fetch('/api/v1/admin/words', { method, headers: { 'content-type': 'application/json', ...hdr() }, body: JSON.stringify({ word: w }) });
    if (r.ok) { if (method === 'POST') setWord(''); load(); }
    else setError((await r.json().catch(() => null))?.error?.message ?? 'That did not work.');
  }

  const pct = (n: number) => `${n}%`;
  const m = metrics;
  return (
    <article>
      <h1>Admin</h1>
      <section className="card manage" aria-label="Admin key">
        <form onSubmit={(e) => { e.preventDefault(); write(key); load(); }} className="manage-row">
          <label htmlFor="adminkey">Admin key</label>
          <div>
            <input id="adminkey" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} style={{ ...field, flex: 1, minWidth: 0 }} />
            <button className="btn secondary" type="submit" style={{ width: 'auto' }}>Open</button>
          </div>
          <small className="muted">Kept in this browser tab only. Not needed when the server has no ADMIN_KEY set.</small>
        </form>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {note && <p role="status" className="muted">{note}</p>}

      <h2>Engagement</h2>
      <label htmlFor="days" style={{ marginRight: 8 }}>Window</label>
      <select id="days" value={days} onChange={(e) => setDays(Number(e.target.value))} style={field}>
        {[1, 7, 30, 90].map((d) => <option key={d} value={d}>Last {d} {d === 1 ? 'day' : 'days'}</option>)}
      </select>
      {!m ? <p className="empty">{error ? 'Metrics need the admin key.' : 'Loading…'}</p> : (
        <>
          <ul className="grid" style={{ marginTop: 16 }}>
            <li className="card"><div className="muted">Visitors</div><strong style={{ fontSize: 28 }}>{m.visitors}</strong></li>
            <li className="card"><div className="muted">Repeat visitors (2+ days)</div><strong style={{ fontSize: 28 }}>{m.repeat_visitors}</strong><div className="muted">{pct(m.repeat_visit_rate_pct)} of visitors</div></li>
            <li className="card"><div className="muted">Visitors who acted</div><strong style={{ fontSize: 28 }}>{m.visitors_who_acted}</strong><div className="muted">{pct(m.action_rate_pct)} of visitors</div></li>
          </ul>
          <table className="admin-table">
            <caption className="sr-only">Action rate by visitor type</caption>
            <thead><tr><th scope="col">Who</th><th scope="col">Share who donated, shared or followed</th></tr></thead>
            <tbody>
              <tr><th scope="row">Repeat visitors</th><td>{pct(m.action_rate_repeat_pct)}</td></tr>
              <tr><th scope="row">New visitors</th><td>{pct(m.action_rate_new_pct)}</td></tr>
              <tr><th scope="row">Everyone</th><td>{pct(m.action_rate_pct)}</td></tr>
            </tbody>
          </table>
          <table className="admin-table">
            <caption className="sr-only">Meaningful actions</caption>
            <thead><tr><th scope="col">Action</th><th scope="col">Count</th></tr></thead>
            <tbody>
              {['donate', 'share', 'follow'].map((a) => <tr key={a}><th scope="row">{a[0].toUpperCase() + a.slice(1)}</th><td>{m.actions[a] ?? 0}</td></tr>)}
            </tbody>
          </table>
          {Object.keys(m.excluded_bot_events).length > 0 && (
            <p className="muted">Left out as bot traffic: {Object.entries(m.excluded_bot_events).map(([k, v]) => `${k} (${v})`).join(', ')}.</p>
          )}
        </>
      )}

      <h2>Chat reports</h2>
      {reports === null ? <p className="empty">{error ? 'Reports need the admin key.' : 'Loading…'}</p>
        : reports.length === 0 ? <p className="empty">No open reports.</p> : (
        <ul className="stack">
          {reports.map((r) => (
            <li key={r.message_id} className="card">
              <p style={{ margin: 0 }}>“{r.body}”</p>
              <p className="muted" style={{ margin: '6px 0' }}>
                {r.author} (@{r.handle}) in {r.room} · {r.reports} {r.reports === 1 ? 'report' : 'reports'}{r.reasons.length ? ` · ${r.reasons.join('; ')}` : ''}
              </p>
              <div className="manage-actions" style={{ marginTop: 8 }}>
                <button className="btn danger" onClick={() => resolve(r.message_id, 'remove')} style={{ width: 'auto' }}>Remove message</button>
                <button className="btn secondary" onClick={() => resolve(r.message_id, 'dismiss')} style={{ width: 'auto' }}>Dismiss</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>Blocked words</h2>
      <p className="muted">Chat refuses messages that contain one of these as a whole word, in any capitalisation.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (word.trim()) wordOp('POST', word.trim()); }} className="manage-row">
        <label htmlFor="newword" className="sr-only">Word to block</label>
        <div>
          <input id="newword" value={word} maxLength={40} onChange={(e) => setWord(e.target.value)} placeholder="Word to block" style={{ ...field, flex: 1, minWidth: 0 }} />
          <button className="btn secondary" type="submit" disabled={word.trim().length < 2} style={{ width: 'auto' }}>Block word</button>
        </div>
      </form>
      {words === null ? null : words.length === 0 ? <p className="empty">No blocked words.</p> : (
        <ul className="pills">
          {words.map((w) => <li key={w}><span className="tag">{w} <button className="linklike" onClick={() => wordOp('DELETE', w)} aria-label={`Allow ${w} again`}>Remove</button></span></li>)}
        </ul>
      )}
    </article>
  );
}
