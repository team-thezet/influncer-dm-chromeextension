// Minimal service worker.
//
// The side panel owns queue controls and the Instagram content script owns page
// interaction. The worker only opens the side panel and seeds default settings.

import { getSettings, saveSettings } from '../lib/storage.js';
import { initSync, syncAll } from '../lib/sync.js';
import { bezierPath, correctionPoints, fittsDuration, easeInOutCubic } from './humanMouse.js';

// Mirror local campaigns/targets/logs to Supabase (outreach_* tables) for the web
// dashboard. Registers a storage hook + pushes existing data on worker startup.
initSync();

// Register at top level (idempotent) so a toolbar click opens the side panel even on a
// plain worker wake — onInstalled only fires on install/update, not on every re-spawn.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('sidePanel.setPanelBehavior failed', e));

// Explicit fallback: if the panel behavior hasn't applied yet (or fails), a click still opens it.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn('sidePanel.open failed', e);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  // Seed default settings once.
  const s = await getSettings();
  if (!s.initialized) {
    await saveSettings({
      initialized: true,
      vars: ['name', 'category', 'followers', 'note'],
      defaultCap: 250,
      dailyTarget: 40,
      maxLen: 900,
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Trusted input via chrome.debugger (CDP). Events dispatched through Input.* arrive
// at the page with isTrusted=true — the content script cannot forge that, so the
// actual clicks/keystrokes are driven from here. The content script computes WHERE
// (viewport coords / text) and asks us to perform the trusted input.
// ──────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const isMacUA = () => /Mac/.test(navigator.userAgent || '');

let _dbgTab = null;
let _idleTimer = null;
let _lastMouse = { x: 0, y: 0 }; // last cursor position (for typing-time mouse jitter)

async function cdpDetach() {
  clearTimeout(_idleTimer);
  if (_dbgTab != null) {
    const t = _dbgTab;
    _dbgTab = null;
    try { await chrome.debugger.detach({ tabId: t }); } catch {}
  }
}
function bumpIdle() {
  clearTimeout(_idleTimer);
  // 12-8 — minimize the debugger attach window: detach after 15s idle. Sub-actions within
  // one send are seconds apart (won't detach mid-send), but the minutes-long gaps the rate
  // governor + pacing impose between actions now clear the banner between sends too.
  _idleTimer = setTimeout(cdpDetach, 15000);
}
async function cdpAttach(tabId) {
  if (_dbgTab === tabId) { bumpIdle(); return; }
  if (_dbgTab != null) await cdpDetach();
  await chrome.debugger.attach({ tabId }, '1.3');
  _dbgTab = tabId;
  bumpIdle();
}
function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// Auto-clear our state if the user closes/cancels the debugger session.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === _dbgTab) { _dbgTab = null; clearTimeout(_idleTimer); }
});

// ── Learned-motion library (Option A: replay REAL human gestures) ───────────────
// Captured by the content script while the owner browses IG; we retarget a random
// gesture to the actual button coords + warp it, so the motion has true human
// velocity/jerk/tremor instead of a synthetic curve.
let _motionLib = { gestures: [], keyIntervals: [] };
function loadMotionLib() {
  try { chrome.storage.local.get('motionLib', (o) => { if (o && o.motionLib) _motionLib = o.motionLib; }); } catch {}
}
loadMotionLib();
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.motionLib && ch.motionLib.newValue) _motionLib = ch.motionLib.newValue;
});

// Settings cache for the SW-side motion/input features (mouse/scroll/typing/warm-up/circadian).
// ON-by-default flags use `!== false`, mirroring SETTINGS_DEFAULTS + the content cache.
let _swSettings = {};
try { chrome.storage.local.get('settings', (o) => { _swSettings = (o && o.settings) || {}; }); } catch {}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.settings) _swSettings = ch.settings.newValue || {};
});
const swOn = (k) => _swSettings[k] !== false;
const swNum = (k, d) => { const v = Number(_swSettings[k]); return Number.isFinite(v) ? v : d; };

// VIII — rate governor: per-session warm-up + rolling hourly caps. Only OUR automated
// actions are recorded (the side panel calls RATE_RECORD on each success), so the user's
// own manual activity never pollutes the counter. A 1-min chrome.alarm prunes the window
// so the MV3 worker can sleep between ticks (no setInterval, which the worker would evict).
const RG_KEY = 'rateGov';
let _rg = { startedAt: null, actions: [] }; // actions = action timestamps within the last hour
try { chrome.storage.local.get(RG_KEY, (o) => { if (o && o[RG_KEY]) _rg = o[RG_KEY]; }); } catch {}
function rgSave() { try { chrome.storage.local.set({ [RG_KEY]: _rg }); } catch {} }
function rgPrune(now) { _rg.actions = (_rg.actions || []).filter((t) => now - t < 3600000); }
function rgSessionState(now) {
  if (!_rg.startedAt) return 'cold';
  const mins = (now - _rg.startedAt) / 60000;
  if (mins < swNum('warmupColdMin', 8)) return 'cold';
  if (mins < 30) return 'warm';
  return 'active';
}
function rgCap(state) {
  return state === 'cold' ? swNum('capColdPerHour', 3)
    : state === 'warm' ? swNum('capWarmPerHour', 8)
    : swNum('capActivePerHour', 12);
}
// IX — circadian activity curve (browser local time). 0..1 — near-zero in the dead of
// night, ramped at the edges, full during the day/evening.
function circadianMultiplier(hour) {
  if (hour >= 2 && hour < 7) return 0.04; // 02–07: ~0–5%
  if (hour === 1 || hour === 7) return 0.3;
  if (hour === 0 || hour === 8) return 0.6;
  return 1;
}
function rgCheck() {
  const now = Date.now();
  if (!_rg.startedAt) { _rg.startedAt = now; rgSave(); }
  rgPrune(now);
  // IX — suppress activity in the dead of night even if warm-up/caps are off.
  if (swOn('circadianEnabled') && circadianMultiplier(new Date().getHours()) < 0.1) {
    return { allowed: false, waitMs: 30 * 60000, reason: '서카디언(심야) — 활동 억제' };
  }
  // Warm-up + hourly caps are OPT-IN (off by default; turn on in options for live runs).
  if (_swSettings.warmupEnabled === true) {
    if (now - _rg.startedAt < swNum('warmupColdMin', 8) * 60000) {
      return { allowed: false, warmup: true, waitMs: 60000, reason: '세션 warm-up' };
    }
    // IX — scale the hourly cap down outside peak hours.
    const baseCap = rgCap(rgSessionState(now));
    const cap = swOn('circadianEnabled')
      ? Math.max(1, Math.round(baseCap * circadianMultiplier(new Date().getHours())))
      : baseCap;
    if ((_rg.actions || []).length >= cap) {
      const oldest = Math.min(..._rg.actions);
      return { allowed: false, waitMs: Math.max(60000, 3600000 - (now - oldest)), reason: `시간당 캡(${cap}/h) 도달` };
    }
  }
  return { allowed: true, state: rgSessionState(now) };
}
function rgRecord() {
  const now = Date.now();
  if (!_rg.startedAt) _rg.startedAt = now;
  rgPrune(now);
  _rg.actions.push(now);
  rgSave();
}
function rgReset() { _rg.startedAt = Date.now(); rgSave(); } // new warm-up; hourly window persists
try {
  chrome.alarms.create('rate-gov-tick', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'rate-gov-tick') { rgPrune(Date.now()); rgSave(); } });
} catch (e) { console.warn('alarms unavailable', e); }

// Similarity-transform a captured gesture so its start→end maps to from→target,
// with small per-point spatial + per-interval timing warp (so replays never repeat).
function retargetGesture(g, fromX, fromY, toX, toY) {
  const srcLen = Math.hypot(g.ex, g.ey) || 1;
  const dx = toX - fromX, dy = toY - fromY;
  const dstLen = Math.hypot(dx, dy);
  const s = dstLen / srcLen;
  const ang = Math.atan2(dy, dx) - Math.atan2(g.ey, g.ex);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  // Fitts's law: a longer move genuinely takes longer (~log of distance). The captured
  // gesture's timing fits ITS distance; when we stretch/shrink it to a new distance,
  // scale the durations so the replay is not too fast for a far target.
  const tScale = Math.max(0.5, Math.min(2.2, Math.log2(2 + dstLen) / Math.log2(2 + srcLen)));
  return g.off.map((p, i) => {
    const rx = (p.x * ca - p.y * sa) * s;
    const ry = (p.x * sa + p.y * ca) * s;
    return {
      x: fromX + rx + (i ? (Math.random() - 0.5) * 2 : 0),
      y: fromY + ry + (i ? (Math.random() - 0.5) * 2 : 0),
      dt: Math.max(1, Math.round((p.dt || 0) * (0.85 + Math.random() * 0.3) * tScale)),
    };
  });
}

// Pick the captured gesture whose shape (length + direction) is closest to the move
// we actually need, so the similarity-transform distorts it as little as possible —
// then add randomness by choosing among the few closest (replays never identical).
function pickGesture(lib, dist, ang) {
  const usable = (lib || []).filter(
    (g) => g && g.off && g.off.length >= 4 && Math.hypot(g.ex, g.ey) >= 20
  );
  if (!usable.length) return null;
  const scored = usable
    .map((g) => {
      const gl = Math.hypot(g.ex, g.ey);
      const ga = Math.atan2(g.ey, g.ex);
      let da = Math.abs(ang - ga);
      if (da > Math.PI) da = 2 * Math.PI - da;        // shortest angular distance
      const lenCost = Math.abs(Math.log((dist || 1) / gl)); // scale-invariant length gap
      return { g, cost: da * 1.4 + lenCost };
    })
    .sort((a, b) => a.cost - b.cost);
  // Candidates = only those close to the BEST match (within a small cost margin),
  // capped at 4. Avoids picking a far/ill-fitting gesture just to add variety.
  const best = scored[0].cost;
  const near = scored.filter((s) => s.cost <= best + 0.8).slice(0, 4);
  return near[Math.floor(Math.random() * near.length)].g;
}

// Bias the press point off dead-centre using the owner's learned click-offset
// distribution (fractions of element size). Falls back to a small symmetric jitter.
function sampleClickPoint(x, y, w, h) {
  const co = _motionLib.clickOffsets || [];
  if (co.length > 8 && w > 0 && h > 0 && Math.random() < 0.85) {
    const o = co[Math.floor(Math.random() * co.length)];
    const fx = Math.max(-0.46, Math.min(0.46, o.fx || 0)); // stay inside the element
    const fy = Math.max(-0.46, Math.min(0.46, o.fy || 0));
    return { x: x + fx * w, y: y + fy * h };
  }
  const jx = Math.min(8, (w || 8) * 0.5), jy = Math.min(6, (h || 6) * 0.5);
  return { x: x + (Math.random() - 0.5) * jx, y: y + (Math.random() - 0.5) * jy };
}
// Per-keystroke delay sampled from the owner's REAL inter-key intervals when we have
// enough; otherwise fall back to the gaussian-ish range.
function sampleKeyDelay(min, max) {
  const k = _motionLib.keyIntervals;
  if (k && k.length > 15 && Math.random() < 0.85) {
    return Math.min(1500, k[Math.floor(Math.random() * k.length)] * (0.85 + Math.random() * 0.3));
  }
  return rnd(min, max);
}

// Small low-amplitude cursor drift around (x,y) for ~ms — a resting/reading hand is
// never perfectly still, so a frozen cursor between actions is a tell.
async function cdpIdle(tabId, x, y, ms) {
  const budget = Math.min(6000, Math.max(0, ms || 0));
  let spent = 0;
  while (spent < budget) {
    const dx = (Math.random() - 0.5) * 6, dy = (Math.random() - 0.5) * 5;
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: y + dy, button: 'none', buttons: 0, pointerType: 'mouse' });
    const step = rnd(120, 380);
    await sleep(step);
    spent += step;
  }
}

async function cdpClick(tabId, x, y, fromX, fromY, w, h) {
  const f = { x: typeof fromX === 'number' ? fromX : x, y: typeof fromY === 'number' ? fromY : y };
  // Land the press on a human-biased point inside the element (not dead-centre).
  const press = sampleClickPoint(x, y, w, h);
  _lastMouse = { x: press.x, y: press.y }; // remember for typing-time mouse jitter

  // Occasionally settle/drift before reaching for the target (hand wasn't frozen).
  if (Math.random() < 0.35) await cdpIdle(tabId, f.x, f.y, rnd(140, 420));

  // Replay the captured gesture whose shape best matches this move, retargeted to the
  // press point, if we have a usable one.
  const dist = Math.hypot(press.x - f.x, press.y - f.y);
  const ang = Math.atan2(press.y - f.y, press.x - f.x);
  const naturalMotion = swOn('motionMouse');
  // III — hover dwell at the target before pressing; 11-9 — occasionally hover a nearby
  // wrong spot first, then correct onto the target (a misjudged reach).
  const hover = async () => {
    if (swOn('wrongHover') && Math.random() < 0.05) {
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: press.x + rnd(-50, 50), y: press.y + rnd(-40, 40), button: 'none', buttons: 0, pointerType: 'mouse' });
      await sleep(rnd(120, 320));
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: press.x, y: press.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    }
    await sleep(naturalMotion ? rnd(80, 250) : rnd(40, 140));
  };

  const g = pickGesture(_motionLib.gestures, dist, ang);
  if (g) {
    for (const p of retargetGesture(g, f.x, f.y, press.x, press.y)) {
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0, pointerType: 'mouse' });
      await sleep(p.dt);
    }
    await hover();
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: press.x, y: press.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await sleep(rnd(60, 160));
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: press.x, y: press.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    return;
  }

  // Fallback (no learned gesture yet): I/II — ghost-cursor cubic-Bezier path with
  // Fitts-law-scaled, eased step timing and optional overshoot + corrective hops.
  const { points, overshot } = bezierPath(f, press, { overshoot: naturalMotion });
  const total = naturalMotion ? fittsDuration(dist, w || 24) : rnd(120, 320);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0, pointerType: 'mouse' });
    const dt = total * (easeInOutCubic((i + 1) / points.length) - easeInOutCubic(i / points.length));
    await sleep(Math.max(4, dt));
  }
  if (overshot) {
    for (const cp of correctionPoints(press)) {
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cp.x, y: cp.y, button: 'none', buttons: 0, pointerType: 'mouse' });
      await sleep(rnd(30, 90));
    }
  }
  await hover();
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: press.x, y: press.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await sleep(rnd(60, 160));
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: press.x, y: press.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}

// Replay a real captured wheel pattern (delta sizes + cadence + momentum tail),
// scaled to the requested total, via trusted CDP wheel events. Falls back to
// synthetic ticks when nothing matching was captured.
async function cdpScroll(tabId, x, y, totalDy) {
  const want = Number(totalDy) || 0;
  if (!want) return;
  const sign = want >= 0 ? 1 : -1;
  const cands = (_motionLib.scrolls || []).filter(
    (s) => s && s.ticks && s.ticks.length >= 3 && Math.sign(s.total) === sign
  );
  const s = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
  // Scale to the sum of the ticks we actually replay — NOT the stored total, which
  // can over-count if the capture buffer dropped ticks (older libs) — so the replayed
  // distance matches `want`. Skip if the retained ticks don't net the right direction.
  const retained = s ? s.ticks.reduce((a, tk) => a + (tk.dy || 0), 0) : 0;
  if (s && Math.abs(retained) > 1 && Math.sign(retained) === sign) {
    const scale = want / retained;
    for (const tick of s.ticks) {
      const dy = tick.dy * scale * (0.9 + Math.random() * 0.2);
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, pointerType: 'mouse' });
      await sleep(Math.max(8, Math.round((tick.dt || 30) * (0.85 + Math.random() * 0.3))));
    }
    return;
  }
  // VI — eased wheel profile (slow→fast→slow) with ±2px jitter, ~8–15 ticks per 300px,
  // when no captured scroll pattern fits. Easing gives natural scroll inertia.
  if (swOn('motionScroll')) {
    const perBlock = 8 + Math.floor(Math.random() * 8); // 8–15 ticks / 300px
    const n = Math.max(5, Math.round((Math.abs(want) / 300) * perBlock));
    let prev = 0;
    for (let i = 1; i <= n; i++) {
      const eased = easeInOutCubic(i / n) * want;
      const dy = eased - prev + (Math.random() - 0.5) * 4; // ±2px jitter
      prev = eased;
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, pointerType: 'mouse' });
      await sleep(rnd(14, 42));
    }
    return;
  }
  const ticks = 4 + Math.floor(Math.random() * 8);
  const per = want / ticks;
  for (let i = 0; i < ticks; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: per * (0.7 + Math.random() * 0.6), pointerType: 'mouse' });
    await sleep(rnd(16, 55));
  }
}

async function cdpKey(tabId, opts) {
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...opts });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...opts, text: undefined, unmodifiedText: undefined });
}

// QWERTY neighbours for realistic adjacent-key typos (IV). ASCII letters only.
const KEY_NEIGHBORS = {
  a: 'sqwz', b: 'vghn', c: 'xdfv', d: 'serfcx', e: 'wsdr', f: 'drtgvc', g: 'ftyhbv',
  h: 'gyujnb', i: 'ujko', j: 'huikmn', k: 'jiolm', l: 'kop', m: 'njk', n: 'bhjm',
  o: 'iklp', p: 'ol', q: 'wa', r: 'edft', s: 'awedxz', t: 'rfgy', u: 'yhji',
  v: 'cfgb', w: 'qase', x: 'zsdc', y: 'tghu', z: 'asx',
};

async function cdpType(tabId, text, opts = {}) {
  const {
    minCharDelay = 45,
    maxCharDelay = 180,
    hesitationProb = 0.08,
    clear = false,
    allowTypos = false,
    allowWordRevision = false,
    typoChance = swNum('typoChance', 0.03),
  } = opts;
  if (clear) {
    const mod = isMacUA() ? 4 : 2; // CDP modifiers: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: mod });
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: mod });
    await sleep(rnd(40, 90));
    await cdpKey(tabId, { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await sleep(rnd(40, 90));
  }
  const chars = [...text];
  let lastWord = '';   // 11-4 — characters of the word currently being typed
  let revised = false; // 11-4 — at most one word revision per message
  for (const ch of chars) {
    const isBoundary = ch === ' ' || ch === '\n';
    // 11-4 — at a word boundary, occasionally rewrite the just-typed word (delete it and
    // type it again — a "reconsidered" gesture, distinct from the IV typo correction).
    if (allowWordRevision && isBoundary && !revised && swOn('wordRevision') && /^[A-Za-z0-9._\-가-힣]+$/.test(lastWord) && lastWord.length >= 3 && Math.random() < 0.08) {
      revised = true;
      await sleep(rnd(200, 500));
      for (let k = 0; k < lastWord.length; k++) {
        await cdpKey(tabId, { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await sleep(rnd(40, 120));
      }
      await sleep(rnd(250, 700));
      for (const wc of lastWord) {
        await cdpKey(tabId, { key: wc, text: wc, unmodifiedText: wc });
        await sleep(rnd(50, 150));
      }
    }

    // 11-5 — brief pause before an emoji (as if reaching for the emoji panel).
    if (swOn('emojiPause') && /\p{Extended_Pictographic}/u.test(ch)) await sleep(rnd(200, 600));

    let d = sampleKeyDelay(minCharDelay, maxCharDelay);
    if (Math.random() < hesitationProb) d += rnd(250, 650);
    await sleep(d);

    // IV — occasional adjacent-key typo → backspace → correct. ASCII letters only;
    // Hangul, punctuation and spaces are never given typos, so IME composition is
    // never disturbed and only completed characters are involved.
    if (allowTypos && swOn('typoCorrection') && /[a-zA-Z]/.test(ch) && Math.random() < typoChance) {
      const neigh = KEY_NEIGHBORS[ch.toLowerCase()];
      if (neigh) {
        let wrong = neigh[Math.floor(Math.random() * neigh.length)];
        if (ch === ch.toUpperCase()) wrong = wrong.toUpperCase();
        await cdpKey(tabId, { key: wrong, text: wrong, unmodifiedText: wrong });
        await sleep(rnd(50, 200));
        await cdpKey(tabId, { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await sleep(rnd(40, 140));
      }
    }

    if (ch === '\n') {
      await cdpKey(tabId, { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    } else {
      // `text` makes dispatchKeyEvent insert the (unicode/Korean-safe) character as trusted input.
      await cdpKey(tabId, { key: ch, text: ch, unmodifiedText: ch });
    }

    // V — micro-pause after punctuation (clause/sentence boundaries), plus a rare longer
    // "thinking" beat. Korean sentence punctuation uses the same . , ? ! marks.
    if (swOn('punctuationPause')) {
      if (ch === ',') await sleep(rnd(150, 400));
      else if (ch === '.' || ch === '?' || ch === '!') await sleep(rnd(400, 900));
      else if (ch === '\n') await sleep(rnd(800, 2000));
      if (Math.random() < 0.05) await sleep(rnd(1500, 4000));
    }

    // 11-1 — tiny mouse move between keystrokes (a hand resting on the mouse isn't frozen).
    if (swOn('typingMouseJitter') && Math.random() < 0.08) {
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: _lastMouse.x + rnd(-8, 8), y: _lastMouse.y + rnd(-8, 8), button: 'none', buttons: 0, pointerType: 'mouse' });
    }
    // 11-4 — track the current word for the revision check.
    lastWord = isBoundary ? '' : lastWord + ch;
  }
}

// A single trusted named keypress (Enter to submit, Backspace for typo recovery).
async function cdpNamedKey(tabId, name) {
  const KEYS = {
    Enter:     { key: 'Enter',     code: 'Enter',     windowsVirtualKeyCode: 13, text: '\r' },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Tab:       { key: 'Tab',       code: 'Tab',       windowsVirtualKeyCode: 9 },
    Escape:    { key: 'Escape',    code: 'Escape',    windowsVirtualKeyCode: 27 },
  };
  const opts = KEYS[name];
  if (!opts) throw new Error('unknown key: ' + name);
  await cdpKey(tabId, opts);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const act = msg && msg.action ? String(msg.action) : '';
  if (!act.startsWith('CDP_') && !act.startsWith('SYNC_') && !act.startsWith('RATE_')) return; // not ours

  if (act === 'SYNC_NOW') {
    syncAll()
      .then((counts) => sendResponse({ ok: true, counts }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async
  }
  if (act === 'RATE_CHECK') { sendResponse(rgCheck()); return true; }
  if (act === 'RATE_RECORD') { rgRecord(); sendResponse({ ok: true }); return true; }
  if (act === 'RATE_RESET') { rgReset(); sendResponse({ ok: true }); return true; }

  const tabId = sender.tab && sender.tab.id;
  (async () => {
    try {
      if (msg.action === 'CDP_DETACH') { await cdpDetach(); sendResponse({ ok: true }); return; }
      if (tabId == null) { sendResponse({ ok: false, error: 'no tab' }); return; }
      await cdpAttach(tabId);
      if (msg.action === 'CDP_CLICK') await cdpClick(tabId, msg.x, msg.y, msg.fromX, msg.fromY, msg.w, msg.h);
      else if (msg.action === 'CDP_TYPE') await cdpType(tabId, msg.text || '', msg.opts || {});
      else if (msg.action === 'CDP_KEY') await cdpNamedKey(tabId, msg.key);
      else if (msg.action === 'CDP_SCROLL') await cdpScroll(tabId, msg.x, msg.y, msg.dy);
      else if (msg.action === 'CDP_IDLE') await cdpIdle(tabId, msg.x, msg.y, msg.ms);
      bumpIdle();
      sendResponse({ ok: true });
    } catch (e) {
      console.warn('CDP input failed:', e && e.message);
      sendResponse({ ok: false, error: e && e.message });
    }
  })();
  return true; // async response
});
