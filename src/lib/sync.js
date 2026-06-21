// Supabase sync — mirrors the local campaigns/targets/logs into the outreach_*
// tables so the web dashboard (CRM) can read & manage them.
//
// Direction: extension → DB (one-way mirror). chrome.storage.local stays the
// source of truth; this pushes a debounced, idempotent upsert (by id) on every
// change and propagates deletions by diffing old/new arrays. Runs in the service
// worker (which sees every storage mutation, whether from the side panel or a
// content-script-driven loop).

import { SUPABASE_URL, SUPABASE_ANON_KEY as ANON } from './config.js';

// PostgREST accepts the anon key as both apikey and Bearer. Access is governed by RLS
// on outreach_* — see supabase/migrations/0001_enable_rls.sql (and config.js note).
const REST = `${SUPABASE_URL}/rest/v1`;
const HEAD = { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` };

const chunk = (a, n) => {
  const r = [];
  for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n));
  return r;
};

async function upsert(table, rows) {
  if (!rows.length) return 0;
  let n = 0;
  for (const part of chunk(rows, 250)) {
    const res = await fetch(`${REST}/${table}?on_conflict=id`, {
      method: 'POST',
      headers: { ...HEAD, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(part),
    });
    if (!res.ok) throw new Error(`${table} ${res.status} ${await res.text().catch(() => '')}`);
    n += part.length;
  }
  return n;
}

async function remove(table, ids) {
  if (!ids.length) return;
  for (const part of chunk(ids, 100)) {
    const inList = `(${part.map((x) => encodeURIComponent(String(x))).join(',')})`;
    await fetch(`${REST}/${table}?id=in.${inList}`, {
      method: 'DELETE',
      headers: { ...HEAD, Prefer: 'return=minimal' },
    }).catch((e) => console.warn('sync delete failed', table, e));
  }
}

const nowIso = () => new Date().toISOString();
const toIso = (ms) => (ms ? new Date(ms).toISOString() : nowIso());

const mapCampaign = (c) => ({
  id: c.id,
  name: c.name ?? null,
  sender_handle: c.senderHandle ?? null,
  cap: c.cap ?? null,
  cooldown_until: c.cooldownUntil ?? null,
  block_strikes: c.blockStrikes ?? 0,
  updated_at: nowIso(),
});
const mapTarget = (t) => ({
  id: t.id,
  campaign_id: t.campaignId ?? null,
  handle: t.handle,
  status: t.status ?? 'pending',
  email: t.email ?? null,
  email_confidence: t.emailConfidence ?? null,
  email_reason: t.emailReason ?? null,
  vars: t.vars ?? {},
  updated_at: toIso(t.updatedAt),
  synced_at: nowIso(),
});
const mapLog = (l) => ({
  id: l.id,
  campaign_id: l.campaignId ?? null,
  target_handle: l.targetHandle ?? null,
  ts: l.ts ?? null,
  final_text: l.finalText ?? null,
  result: l.result ?? null,
  synced_at: nowIso(),
});

// Full idempotent upsert of everything currently in storage.
export async function syncAll() {
  const o = await chrome.storage.local.get(['campaigns', 'targets', 'logs']);
  const counts = {
    campaigns: await upsert('outreach_campaigns', (o.campaigns || []).map(mapCampaign)),
    targets: await upsert('outreach_targets', (o.targets || []).map(mapTarget)),
    logs: await upsert('outreach_logs', (o.logs || []).map(mapLog)),
  };
  await chrome.storage.local.set({ syncState: { lastAt: Date.now(), ok: true, counts } });
  return counts;
}

// ── Debounced auto-sync ────────────────────────────────────────────────────
let _timer = null;
let _running = false;
let _again = false;

export function scheduleSync(delay = 2500) {
  clearTimeout(_timer);
  _timer = setTimeout(runSync, delay);
}

async function runSync() {
  if (_running) {
    _again = true;
    return;
  }
  _running = true;
  try {
    await syncAll();
  } catch (e) {
    await chrome.storage.local.set({
      syncState: { lastAt: Date.now(), ok: false, error: String((e && e.message) || e) },
    });
    console.warn('sync failed:', e);
  } finally {
    _running = false;
    if (_again) {
      _again = false;
      scheduleSync(1500);
    }
  }
}

// Diff removed ids out of an onChanged record and delete them from the DB.
function diffDeletes(table, change) {
  const oldA = change.oldValue || [];
  const newIds = new Set((change.newValue || []).map((x) => x.id));
  const removed = oldA.filter((x) => x && !newIds.has(x.id)).map((x) => x.id);
  if (removed.length) remove(table, removed);
}

// Register the storage hook + push existing data once. Called by the service worker.
export function initSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Ignore our own bookkeeping + the motion library (not synced).
    if (!changes.campaigns && !changes.targets && !changes.logs) return;
    if (changes.targets) diffDeletes('outreach_targets', changes.targets);
    if (changes.campaigns) diffDeletes('outreach_campaigns', changes.campaigns);
    // logs are append-only + capped locally; keep full history in the DB (no delete).
    scheduleSync();
  });
  scheduleSync(3000); // initial mirror on worker startup
}
