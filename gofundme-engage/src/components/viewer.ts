'use client';
import { useSyncExternalStore } from 'react';

// Dev stand-in for sign-in: the chosen user id is kept in the browser and sent as x-user-id.
const KEY = 'viewer';
const listeners = new Set<() => void>();

function read(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function setViewer(id: string | null) {
  try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY); } catch { /* storage blocked */ }
  listeners.forEach((l) => l());
}
export function useViewer(): string | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); window.addEventListener('storage', cb); return () => { listeners.delete(cb); window.removeEventListener('storage', cb); }; },
    read,
    () => null,
  );
}

let anon: string | undefined;
function anonId(): string {
  if (anon) return anon;
  try {
    anon = localStorage.getItem('anon') ?? crypto.randomUUID();
    localStorage.setItem('anon', anon);
  } catch { anon = crypto.randomUUID(); }
  return anon;
}
export function authHeaders(): Record<string, string> {
  const id = read();
  return id ? { 'x-user-id': id } : { 'x-anon-id': anonId() };
}
