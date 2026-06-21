/**
 * Instagram DM Automator Content Script
 * Injected into *://*.instagram.com/*
 *
 * === 인간 모방 철학 (진짜 사람처럼 보이게 하기 위한 전체 접근) ===
 * - 검색은 언제나 "현재 화면(DM 채팅 포함)에서 왼쪽 영구 네비 검색 클릭"으로 시작
 * - 모든 클릭은 simulateHumanClick (mouseover → mousemove → mousedown → mouseup → click)
 * - 입력은 simulateHumanTyping (글자 단위 지터 + 가끔 망설임/수정)
 * - 대기는 MutationObserver로 실제 UI 변화에 반응 (고정 폴링 최소화)
 * - 프로필 단계: 스크롤 + 긴 변수적 "소비/판단" 시간
 * - 메시지: 붙여넣기+리뷰 vs 전체 타이핑 무작위 선택
 * - 전송 후: 자기 메시지 다시 보는 시간 + 자연스러운 다음 검색 전환
 * - 세션 레벨: bulk 루프에서 가끔 추가 긴 휴식 + IG 탭 미세 스크롤
 * - 모든 주요 단계에 "이게 인간이 하는 행동" 주석 + 상세 콘솔 로그
 *
 * 핵심 목표: 패턴이 너무 규칙적이지 않고, 실제 사람이 왼쪽 검색 → 결과 선택 → 프로필 확인 → 메시지 보내는
 * 흐름을 최대한 재현하는 것.
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PING') {
    sendResponse({ success: true });
    return false;
  }

  const traced = request.action === 'SEARCH_AND_SEND' || request.action === 'SCRAPE_EMAIL' || request.action === 'PROCESS_TARGET';
  if (traced) traceStart(request.action === 'SCRAPE_EMAIL' ? 'scrape' : request.action === 'PROCESS_TARGET' ? 'process' : 'send', request.handle);
  (async () => {
    try {
      _automating = true; // pause passive motion capture while WE drive the page
      const soft = () => (featureOn('softSignalGuard') ? detectSoftSignal() : null);
      if (request.action === 'SEARCH_AND_SEND') {
        const result = await handleSearchAndSend(request.handle, request.text, request.entry);
        sendResponse({ success: true, ...(result || {}), softSignal: soft(), trace: traceDump('ok') });
      } else if (request.action === 'CHECK_REPLY') {
        const hasReplied = await handleCheckReply(request.handle);
        sendResponse({ success: true, hasReplied });
      } else if (request.action === 'DUMP_PAGE_STATE') {
        const state = dumpPageState();
        sendResponse({ success: true, state });
      } else if (request.action === 'SCRAPE_EMAIL') {
        const result = await handleScrapeEmail(request.handle, request.entry);
        sendResponse({ success: true, ...result, softSignal: soft(), trace: traceDump('ok') });
      } else if (request.action === 'PROCESS_TARGET') {
        const result = await handleProcessTarget(request.handle, request.text, request.entry);
        sendResponse({ success: true, ...result, softSignal: soft(), trace: traceDump('ok') });
      } else if (request.action === 'NATURAL_MODE') {
        await naturalModeBrowse(request.ms);
        sendResponse({ success: true });
      } else if (request.action === 'INTENT_NOISE') {
        await intentNoise(request.kind);
        sendResponse({ success: true });
      }
    } catch (err) {
      console.error(`[Automator] ${request.action} failed:`, err);
      if (traced) traceFail(classifyFail(err.message));
      sendResponse({ success: false, error: err.message, reason: traced ? classifyFail(err.message) : undefined, trace: traced ? traceDump('fail') : null });
    } finally {
      _automating = false;
    }
  })();

  return true; // Keep the message channel open
});

// Box-Muller transform for sub-millisecond Gaussian distribution
function gaussianRandom(min, max, skew = 1) {
  let u = 0, v = 0;
  while(u === 0) u = Math.random();
  while(v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);

  num = num / 10.0 + 0.5;
  if (num > 1 || num < 0) return gaussianRandom(min, max, skew);
  num = Math.pow(num, skew);
  num *= max - min;
  num += min;
  return num;
}

function delay(minMs, maxMs) {
  const ms = maxMs ? gaussianRandom(minMs, maxMs) : minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A single random integer in [min,max] (gaussian-ish), for callers that need a value
// rather than a pause (e.g. handing a dwell duration to humanDwell).
function rndInt(min, max) {
  return Math.max(min, Math.round(gaussianRandom(min, max)));
}

// ── Human-like simulation utilities ────────────────────────────────────────────

/**
 * waitForCondition / waitForElement
 * Uses MutationObserver for natural, reactive waiting instead of dumb fixed polling.
 * This is one of the biggest flow-quality improvements — we react to actual DOM changes
 * like a human watching the screen.
 */
function waitForCondition(checkFn, { timeout = 15000, pollInterval = 120 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const start = Date.now();

    const observer = new MutationObserver(() => {
      if (done) return;
      if (checkFn()) {
        done = true;
        observer.disconnect();
        resolve(true);
      }
    });

    // Observe broadly
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    // Also do an immediate check + light polling fallback
    const check = () => {
      if (done) return;
      if (checkFn()) {
        done = true;
        observer.disconnect();
        resolve(true);
        return;
      }
      if (Date.now() - start > timeout) {
        done = true;
        observer.disconnect();
        resolve(false);
        return;
      }
      setTimeout(check, pollInterval);
    };

    // First immediate check
    if (checkFn()) {
      done = true;
      observer.disconnect();
      resolve(true);
      return;
    }
    setTimeout(check, 50);
  });
}

async function waitForElement(selector, { timeout = 12000 } = {}) {
  const found = await waitForCondition(() => document.querySelector(selector), { timeout });
  return found ? document.querySelector(selector) : null;
}

// ── Virtual-cursor state for continuous, curved mouse paths ────────────────────
let _mouseX = Math.floor((window.innerWidth || 1280) / 2);
let _mouseY = Math.floor((window.innerHeight || 720) / 2);

// ── Trusted input via the service worker (chrome.debugger / CDP) ────────────────
// The SW performs the real click/keystroke so the page sees isTrusted=true. We send
// viewport coords / text and await. If CDP is unavailable (DevTools open, attach
// denied, etc.) we flip _cdpInput off and fall back to synthetic DOM events.
let _cdpInput = true;
function cdpRequest(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(!!(resp && resp.ok));
      });
    } catch { resolve(false); }
  });
}

// ── Passive motion learning ────────────────────────────────────────────────────
// Capture REAL (isTrusted) human cursor gestures + keystroke timing while the owner
// browses IG normally, and store them so the SW can RETARGET+replay them (option A).
// Critically, capture is paused while WE are automating — CDP input is also
// isTrusted, so without this guard we'd learn our own generated motion and pollute the lib.
let _automating = false;
const MOTION_KEY = 'motionLib';
let _motionLearn = true;
const _moveBuf = [];                 // rolling buffer of recent real mousemoves
const _capBuf = { gestures: [], keyIntervals: [], scrolls: [], clickOffsets: [] }; // pending captures (flushed periodically)
let _lastKeyT = 0;
let _scrollBuf = null;               // wheel ticks of the scroll currently in progress
let _scrollLastT = 0;

try { chrome.storage.local.get('settings', (o) => { _motionLearn = (o && o.settings && o.settings.motionLearn) !== false; }); } catch {}
try {
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) _motionLearn = (ch.settings.newValue && ch.settings.newValue.motionLearn) !== false;
  });
} catch {}

// Full settings cache for the naturalization features. The content script can't import
// storage.js (classic content script), so ON-by-default flags use `!== false` (undefined
// or true → on; only an explicit stored false turns them off) — mirroring SETTINGS_DEFAULTS.
let _settings = {};
try { chrome.storage.local.get('settings', (o) => { _settings = (o && o.settings) || {}; }); } catch {}
try {
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) _settings = ch.settings.newValue || {};
  });
} catch {}
// `featureOn('x')` → true unless x is stored exactly false. `settingNum('x', d)` → numeric or d.
const featureOn = (k) => _settings[k] !== false;
const settingNum = (k, d) => { const v = Number(_settings[k]); return Number.isFinite(v) ? v : d; };

// ── Run tracer (feedback loop) ──────────────────────────────────────────────────
// Every send/scrape produces a structured trace: per-step ok/ms, and on failure an
// AUTOMATIC DOM snapshot (action buttons, aria signals, finder results, trimmed main
// HTML). Returned to the side panel, which stores + exports it — so each real run yields
// a precise "what failed and why" record instead of needing manual reproduction.
let _trace = null;
function traceStart(kind, handle) {
  _trace = { kind, handle, startedAt: Date.now(), steps: [], outcome: null, t0: performance.now(), last: performance.now() };
}
function traceStep(step, detail) {
  if (!_trace) return;
  const now = performance.now();
  _trace.steps.push({ step, ms: Math.round(now - _trace.last), ...(detail || {}) });
  _trace.last = now;
}
function traceFail(reason) {
  if (!_trace) return;
  _trace.failStep = _trace.steps.length ? _trace.steps[_trace.steps.length - 1].step : 'start';
  _trace.reason = reason;
  try { _trace.capture = captureState(reason); } catch (e) { _trace.capture = { error: String((e && e.message) || e) }; }
}
function traceDump(outcome) {
  if (!_trace) return null;
  const t = _trace;
  t.outcome = outcome;
  t.totalMs = Math.round(performance.now() - t.t0);
  delete t.t0; delete t.last;
  _trace = null;
  return t;
}
// Classify an error message into a stable failure reason (for aggregating across runs).
function classifyFail(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('action_blocked')) return 'blocked';
  if (m.includes('typed_text_mismatch') || m.includes('입력 검증 실패')) return 'typed_text_mismatch';
  if (m.includes('메시지 보내기 버튼') || (m.includes('메시지') && m.includes('찾을 수 없'))) return 'no_message_button';
  if (m.includes('작성창')) return 'composer_not_ready';
  if (m.includes('프로필을 찾을 수 없') || m.includes('검색 결과')) return 'profile_not_found';
  if (m.includes('검색 입력창') || m.includes('검색 아이콘')) return 'search_open_failed';
  if (m.includes('로딩') || m.includes('네비')) return 'nav_not_found';
  return 'other';
}
// Snapshot of the page at the moment of failure — the heart of the feedback loop.
function captureState(reason) {
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  const actionButtons = safe(() => [...document.querySelectorAll('header button, header div[role="button"], header a, main button, main div[role="button"]')]
    .map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 24).slice(0, 24)) || [];
  const ariaSignals = safe(() => [...document.querySelectorAll('[aria-label]')]
    .map((e) => e.getAttribute('aria-label')).filter((a) => /메시지|message|더\s*보기|더보기|팔로|follow/i.test(a || '')).slice(0, 14)) || [];
  return {
    reason,
    url: location.pathname,
    finders: {
      searchButton: safe(() => !!findSearchButton()),
      messageButton: safe(() => !!findMessageButton()),
      messageInput: safe(() => !!findMessageInput()),
      bioExpander: safe(() => !!findBioExpander()),
      followers: safe(() => extractFollowersCount()),
      isPrivate: safe(() => detectPrivateAccount()),
    },
    actionButtons,
    ariaSignals,
    bodyHasBlock: safe(() => detectBlockDialog()),
    mainHTML: safe(() => (document.querySelector('main')?.innerHTML || '').replace(/\s+/g, ' ').slice(0, 4000)) || '',
  };
}

function _pushScroll(s) {
  if (!s || s.ticks.length < 3 || Math.abs(s.total) < 30) return;
  _capBuf.scrolls.push(s);
}
function _flushMotion() {
  // A scroll that has gone quiet (no new tick) is finished — commit it.
  if (_scrollBuf && performance.now() - _scrollLastT > 500) { _pushScroll(_scrollBuf); _scrollBuf = null; }
  if (!_capBuf.gestures.length && !_capBuf.keyIntervals.length && !_capBuf.scrolls.length && !_capBuf.clickOffsets.length) return;
  const g = _capBuf.gestures.splice(0), k = _capBuf.keyIntervals.splice(0);
  const sc = _capBuf.scrolls.splice(0), co = _capBuf.clickOffsets.splice(0);
  try {
    chrome.storage.local.get(MOTION_KEY, (o) => {
      const lib = (o && o[MOTION_KEY]) || { gestures: [], keyIntervals: [], scrolls: [], clickOffsets: [] };
      if (!lib.scrolls) lib.scrolls = [];            // migrate libs captured before this version
      if (!lib.clickOffsets) lib.clickOffsets = [];
      lib.gestures.push(...g); if (lib.gestures.length > 60) lib.gestures.splice(0, lib.gestures.length - 60);
      lib.keyIntervals.push(...k); if (lib.keyIntervals.length > 800) lib.keyIntervals.splice(0, lib.keyIntervals.length - 800);
      lib.scrolls.push(...sc); if (lib.scrolls.length > 40) lib.scrolls.splice(0, lib.scrolls.length - 40);
      lib.clickOffsets.push(...co); if (lib.clickOffsets.length > 200) lib.clickOffsets.splice(0, lib.clickOffsets.length - 200);
      chrome.storage.local.set({ [MOTION_KEY]: lib });
    });
  } catch {}
}
setInterval(_flushMotion, 5000);

window.addEventListener('mousemove', (e) => {
  if (!e.isTrusted || _automating || !_motionLearn) return;
  const t = performance.now();
  const last = _moveBuf[_moveBuf.length - 1];
  if (last && t - last.t < 35) return;          // throttle ~28Hz
  _moveBuf.push({ x: e.clientX, y: e.clientY, t });
  while (_moveBuf.length && _moveBuf[0].t < t - 2500) _moveBuf.shift();
}, true);

window.addEventListener('mousedown', (e) => {
  if (!e.isTrusted || _automating || !_motionLearn) return;
  const t = performance.now();

  // Where inside the target did the click land? Learn the owner's personal bias
  // (people don't click dead-centre). Stored as a fraction of element size so it
  // generalises across button sizes. Captured regardless of how far the cursor travelled.
  try {
    const el = e.target;
    const r = el && el.getBoundingClientRect && el.getBoundingClientRect();
    if (r && r.width > 6 && r.height > 6 && r.width < 1200 && r.height < 900) {
      const fx = (e.clientX - (r.left + r.width / 2)) / r.width;
      const fy = (e.clientY - (r.top + r.height / 2)) / r.height;
      if (Math.abs(fx) <= 0.6 && Math.abs(fy) <= 0.6) {
        _capBuf.clickOffsets.push({ fx: +fx.toFixed(3), fy: +fy.toFixed(3) });
      }
    }
  } catch {}

  const pts = _moveBuf.filter((p) => p.t > t - 1600);   // the approach to this click
  if (pts.length < 5) return;
  const s = pts[0];
  const ex = e.clientX - s.x, ey = e.clientY - s.y;
  if (Math.hypot(ex, ey) < 40) return;                   // need real travel to retarget
  const off = pts.map((p, i) => ({ x: p.x - s.x, y: p.y - s.y, dt: i ? Math.round(p.t - pts[i - 1].t) : 0 }));
  off.push({ x: ex, y: ey, dt: Math.max(1, Math.round(t - pts[pts.length - 1].t)) });
  _capBuf.gestures.push({ off, ex, ey });
}, true);

// Capture real wheel telemetry (delta sizes + cadence + momentum) so the SW can
// replay a genuine scroll pattern instead of synthetic even ticks.
window.addEventListener('wheel', (e) => {
  if (!e.isTrusted || _automating || !_motionLearn) return;
  const t = performance.now();
  let firstTick = false;
  if (!_scrollBuf || t - _scrollLastT > 220) {          // >220ms gap = a new, separate scroll
    if (_scrollBuf) _pushScroll(_scrollBuf);
    _scrollBuf = { ticks: [], total: 0 };
    firstTick = true;                                   // opening tick has no intra-scroll gap
  }
  // First tick of a scroll has dt 0 (don't leak the idle gap between two scrolls).
  const dt = firstTick ? 0 : Math.min(400, Math.round(t - _scrollLastT));
  const dy = Math.round(e.deltaY);
  _scrollBuf.ticks.push({ dy, dt });
  _scrollBuf.total += dy;
  // Keep total consistent with the RETAINED ticks: when we drop the oldest tick,
  // drop its dy from total too (else total over-counts and replay under-scrolls).
  if (_scrollBuf.ticks.length > 40) {
    const drop = _scrollBuf.ticks.shift();
    _scrollBuf.total -= drop.dy;
  }
  _scrollLastT = t;
}, true);

window.addEventListener('keydown', (e) => {
  if (!e.isTrusted || _automating || !_motionLearn) return;
  const t = performance.now();
  if (_lastKeyT && t - _lastKeyT < 2000) _capBuf.keyIntervals.push(Math.round(t - _lastKeyT));
  _lastKeyT = t;
}, true);

function pointerOpts(x, y, extra = {}) {
  return {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra,
  };
}
function mouseOpts(x, y, extra = {}) {
  return {
    bubbles: true, cancelable: true, composed: true, view: window, detail: 1,
    clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY, ...extra,
  };
}

// Move the virtual cursor toward (toX,toY) along a gentle Bezier curve with tremor,
// dispatching pointermove/mousemove on the element under each step. Real users emit
// dozens of move ticks between hover and press — a single mousemove is too abrupt.
async function moveCursorTo(toX, toY) {
  const fromX = _mouseX, fromY = _mouseY;
  const steps = 6 + Math.floor(Math.random() * 12);
  const cx = (fromX + toX) / 2 + (Math.random() - 0.5) * 60;
  const cy = (fromY + toY) / 2 + (Math.random() - 0.5) * 40;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, mt = 1 - t;
    let x = mt * mt * fromX + 2 * mt * t * cx + t * t * toX + (Math.random() - 0.5) * 2;
    let y = mt * mt * fromY + 2 * mt * t * cy + t * t * toY + (Math.random() - 0.5) * 2;
    const mvX = x - _mouseX, mvY = y - _mouseY;
    _mouseX = x; _mouseY = y;
    const cxp = Math.max(0, Math.min((window.innerWidth || 1280) - 1, x));
    const cyp = Math.max(0, Math.min((window.innerHeight || 720) - 1, y));
    const target = document.elementFromPoint(cxp, cyp) || document.body;
    try {
      target.dispatchEvent(new PointerEvent('pointermove', pointerOpts(x, y, { movementX: mvX, movementY: mvY, pressure: 0, buttons: 0 })));
      target.dispatchEvent(new MouseEvent('mousemove', mouseOpts(x, y, { movementX: mvX, movementY: mvY, buttons: 0 })));
    } catch {}
    await delay(8, 22);
  }
}

// Scroll like a real wheel/trackpad: emit WheelEvent ticks (a programmatic smooth
// scroll fires ZERO input-device events — "scrolled with no wheel telemetry" is a tell).
function _cursorVp() {
  return {
    x: Math.max(0, Math.min((window.innerWidth || 1280) - 1, _mouseX)),
    y: Math.max(0, Math.min((window.innerHeight || 720) - 1, _mouseY)),
  };
}

// A reading/checking pause that, on the CDP path, drifts the real cursor slightly
// (a resting hand is never perfectly still) instead of freezing it. Falls back to
// a plain wait when CDP is unavailable.
async function _idleChunk(ms) {
  if (_cdpInput) {
    const { x, y } = _cursorVp();
    const ok = await cdpRequest({ action: 'CDP_IDLE', x, y, ms });
    if (ok) return;
  }
  await new Promise((r) => setTimeout(r, ms));
}
async function humanDwell(ms) {
  // 11-8 — while dwelling, occasionally micro-scroll (±10–30px) instead of being
  // perfectly still; a reading person nudges the page now and then.
  if (featureOn('readingMicroScroll') && ms > 1500) {
    let spent = 0;
    while (spent < ms) {
      const chunk = Math.min(ms - spent, rndInt(900, 1800));
      await _idleChunk(chunk);
      spent += chunk;
      if (spent < ms && Math.random() < 0.1) {
        await simulateHumanScroll((Math.random() < 0.5 ? 1 : -1) * rndInt(10, 30));
      }
    }
    return;
  }
  await _idleChunk(ms);
}

async function simulateHumanScroll(deltaTotal) {
  // Prefer replaying a captured wheel pattern via CDP (trusted + real momentum).
  if (_cdpInput) {
    const { x, y } = _cursorVp();
    const ok = await cdpRequest({ action: 'CDP_SCROLL', x, y, dy: deltaTotal });
    if (ok) return;
    // A scroll failure alone doesn't prove CDP is dead (clicks/typing may still work),
    // so don't flip _cdpInput here — just fall through to the synthetic path once.
  }
  const scroller = document.scrollingElement || document.documentElement || document.body;
  const ticks = 4 + Math.floor(Math.random() * 8);
  const per = deltaTotal / ticks;
  for (let i = 0; i < ticks; i++) {
    const dy = per * (0.7 + Math.random() * 0.6);
    const target = document.elementFromPoint(
      Math.max(0, Math.min((window.innerWidth || 1280) - 1, _mouseX)),
      Math.max(0, Math.min((window.innerHeight || 720) - 1, _mouseY))
    ) || document.body;
    try {
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true, composed: true,
        clientX: _mouseX, clientY: _mouseY,
      }));
    } catch {}
    try { scroller.scrollBy(0, dy); } catch {}
    await delay(16, 55);
  }
}

/**
 * simulateHumanClick
 * Curved cursor approach + PointerEvent + MouseEvent sequence + focus/blur, then a
 * single native el.click() (the reliable React-onClick trigger). Note: synthetic
 * events are always isTrusted=false — this matches the event *types* IG listens on
 * (pointer/mouse), which is the realistic win; it can't fake isTrusted.
 */
async function simulateHumanClick(el, options = {}) {
  if (!el) return false;
  const { offsetX = 0, offsetY = 0 } = options;

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    await delay(180, 350);
    await delay(60, 140);
  } catch {}

  const rect = el.getBoundingClientRect();
  const cx0 = rect.left + rect.width / 2 + (offsetX || 0);
  const cy0 = rect.top + rect.height / 2 + (offsetY || 0);

  // Prefer real trusted input (CDP via the SW); fall back to synthetic DOM events.
  // We send the element CENTRE + size; the SW biases the actual press point using
  // the owner's learned click-offset distribution (don't double-apply jitter here).
  if (_cdpInput) {
    const ok = await cdpRequest({ action: 'CDP_CLICK', x: cx0, y: cy0, w: rect.width, h: rect.height, fromX: _mouseX, fromY: _mouseY });
    if (ok) { _mouseX = cx0; _mouseY = cy0; return true; }
    _cdpInput = false; // CDP unavailable this session → synthetic from here on
  }

  // Synthetic path owns its own small jitter (the SW isn't doing it for us here).
  const x = cx0 + (offsetX ? 0 : (Math.random() - 0.5) * 6);
  const y = cy0 + (offsetY ? 0 : (Math.random() - 0.5) * 4);
  await moveCursorTo(x, y);

  try {
    el.dispatchEvent(new PointerEvent('pointerover', pointerOpts(x, y, { pressure: 0, buttons: 0 })));
    el.dispatchEvent(new PointerEvent('pointerenter', pointerOpts(x, y, { pressure: 0, buttons: 0 })));
    el.dispatchEvent(new MouseEvent('mouseover', mouseOpts(x, y)));
    el.dispatchEvent(new MouseEvent('mouseenter', mouseOpts(x, y)));
  } catch {}
  await delay(40, 140);

  // Real users move focus off the previous control.
  try { const a = document.activeElement; if (a && a !== el && typeof a.blur === 'function') a.blur(); } catch {}

  try {
    el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts(x, y, { pressure: 0.5, buttons: 1 })));
    el.dispatchEvent(new MouseEvent('mousedown', mouseOpts(x, y, { button: 0, buttons: 1 })));
  } catch {}
  try { if (typeof el.focus === 'function') el.focus(); } catch {}
  await delay(60, 160);

  try {
    el.dispatchEvent(new PointerEvent('pointerup', pointerOpts(x, y, { pressure: 0, buttons: 0 })));
    el.dispatchEvent(new MouseEvent('mouseup', mouseOpts(x, y, { button: 0, buttons: 0 })));
  } catch {}
  await delay(15, 50);

  // Single click via the native method (avoids double-firing a manual 'click' + .click()).
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent(new MouseEvent('click', mouseOpts(x, y, { button: 0 })));

  return true;
}

/**
 * ensureVisibleAndConfirm
 * Humans scroll to make sure something is visible, then pause briefly to "check/confirm" before acting.
 */
async function ensureVisibleAndConfirm(el, description = 'element') {
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await delay(220, 480);
    // "Checking" pause – person visually confirms the element looks correct
    await delay(80, 180);
    console.log(`[Automator] Confirmed visible: ${description}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * simulateHumanTyping
 * Types text into an input/textarea/contenteditable as a real person would.
 * - Character-by-character with variable speed.
 * - Small pauses, occasional "hesitation".
 * - Low probability of backspace + correction (for realism on longer text).
 * - Proper events so React-controlled fields update.
 */
// Map a character to keyboard-event fields (covers the handle + message alphabet).
function keyInfoFor(ch) {
  const out = { code: 'Unidentified', keyCode: ch.charCodeAt(0), shiftKey: false };
  if (/[a-z]/.test(ch)) { out.code = 'Key' + ch.toUpperCase(); out.keyCode = ch.toUpperCase().charCodeAt(0); }
  else if (/[A-Z]/.test(ch)) { out.code = 'Key' + ch; out.keyCode = ch.charCodeAt(0); out.shiftKey = true; }
  else if (/[0-9]/.test(ch)) { out.code = 'Digit' + ch; out.keyCode = 48 + Number(ch); }
  else {
    const m = { '.': ['Period', 190, false], ',': ['Comma', 188, false], '_': ['Minus', 189, true], '-': ['Minus', 189, false], '@': ['Digit2', 50, true], ' ': ['Space', 32, false], '!': ['Digit1', 49, true], '?': ['Slash', 191, true], '/': ['Slash', 191, false], ':': ['Semicolon', 186, true], '+': ['Equal', 187, true], '\n': ['Enter', 13, false] };
    if (m[ch]) { out.code = m[ch][0]; out.keyCode = m[ch][1]; out.shiftKey = m[ch][2]; }
  }
  return out;
}

const nativeInputSetter = () =>
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

// Type one character with a realistic keyboard order: keydown → beforeinput →
// value mutate → input → keyup, honoring a cancelled beforeinput. Korean syllables
// are wrapped in composition events (IG locale is ko — typing Korean with zero
// composition events is a clear automation tell).
function typeOneChar(el, char, isCE) {
  const info = keyInfoFor(char);
  const isHangul = /[가-힣ᄀ-ᇿ㄰-㆏]/.test(char);
  const kbd = (type, composing) => new KeyboardEvent(type, {
    key: char, code: info.code, keyCode: info.keyCode, which: info.keyCode,
    shiftKey: info.shiftKey, location: 0, repeat: false, isComposing: composing,
    bubbles: true, cancelable: true, composed: true,
  });
  el.dispatchEvent(kbd('keydown', isHangul));
  if (isHangul) {
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true, composed: true }));
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: char, bubbles: true, composed: true }));
  }
  const inputType = isHangul ? 'insertCompositionText' : 'insertText';
  const proceed = el.dispatchEvent(new InputEvent('beforeinput', { inputType, data: char, bubbles: true, cancelable: true, composed: true }));
  if (proceed) {
    if (isCE) {
      document.execCommand('insertText', false, char);
    } else {
      const setter = nativeInputSetter();
      if (setter) setter.call(el, el.value + char); else el.value = el.value + char;
      el.dispatchEvent(new InputEvent('input', { inputType, data: char, bubbles: true, composed: true }));
    }
  }
  if (isHangul) el.dispatchEvent(new CompositionEvent('compositionend', { data: char, bubbles: true, composed: true }));
  el.dispatchEvent(kbd('keyup', false));
}

function deleteOneChar(el, isCE) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true, composed: true }));
  if (isCE) {
    document.execCommand('delete', false, null);
  } else {
    const setter = nativeInputSetter();
    if (setter) setter.call(el, el.value.slice(0, -1)); else el.value = el.value.slice(0, -1);
    el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
  }
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, composed: true }));
}

// Read the committed text of an editable element: `.value` for <input>/<textarea>,
// `.innerText` for a contentEditable (the IG DM composer). A contentEditable often
// reports a phantom trailing newline, so we strip a single one.
function readEditableText(el, isCE) {
  if (isCE) {
    const s = el.innerText ?? el.textContent ?? '';
    return s.replace(/\n$/, '');
  }
  return el.value ?? '';
}

// After typing, verify the element actually holds `text`; if characters were dropped
// (React-controlled <input> live search) or the contentEditable composer swallowed
// some, recover ONE char at a time — never a single force-set of the whole string,
// which is a definitive automation signature. Works for BOTH <input> and the DM
// composer (contentEditable). Prefers trusted CDP input; falls back to synthetic.
// Korean note: composition has ended by the time we read, so we compare on NFC-
// normalized committed text (composed vs decomposed Hangul must compare equal).
async function verifyTypedText(el, text, isCE) {
  const nfc = (s) => { try { return s.normalize('NFC'); } catch { return s; } };
  const target = nfc(text);
  const tLen = [...target].length;
  let guard = 0;
  const maxGuard = tLen + 8;
  let previous = null;
  let staleReads = 0;
  while (guard++ < maxGuard) {
    const cur = nfc(readEditableText(el, isCE));
    if (cur === target) return true;
    if (cur === previous) staleReads++;
    else staleReads = 0;
    previous = cur;
    if (staleReads >= 2) return false;
    if (target.startsWith(cur)) {
      if (staleReads > 0) {
        el.focus();
        await delay(140, 260);
        continue;
      }
      // Dropped suffix → type the next missing character.
      const idx = [...cur].length;
      const nextChar = [...target][idx] ?? target.slice(-1);
      let typed = false;
      if (_cdpInput) typed = await cdpRequest({ action: 'CDP_TYPE', text: nextChar, opts: { clear: false, minCharDelay: 80, maxCharDelay: 180, allowTypos: false, allowWordRevision: false } });
      if (!typed) typeOneChar(el, nextChar, isCE);
    } else if ([...cur].length > tLen) {
      // Genuine overshoot → delete the trailing char.
      let deleted = false;
      if (_cdpInput) deleted = await cdpRequest({ action: 'CDP_KEY', key: 'Backspace' });
      if (!deleted) deleteOneChar(el, isCE);
    } else {
      // Diverged without a clean prefix/overshoot — leave it rather than thrash
      // (safer than risking corruption of an otherwise-correct message).
      break;
    }
    await delay(40, 110);
  }
  return nfc(readEditableText(el, isCE)) === target;
}

// Verified clear of an editable element before typing. CDP's clear (select-all +
// Delete) can silently no-op on a React-controlled / contentEditable field, which
// would leave the old text in place and make us APPEND to it. So clear, then confirm
// the field is actually empty; retry up to 3x, fall back to a synthetic clear, and
// report whether it ended up empty.
async function clearEditable(el, isCE) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (readEditableText(el, isCE) === '') return true;
    let cleared = false;
    if (_cdpInput) cleared = await cdpRequest({ action: 'CDP_TYPE', text: '', opts: { clear: true } });
    if (!cleared) {
      el.focus();
      if (isCE) {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      } else {
        const setter = nativeInputSetter();
        if (setter) setter.call(el, ''); else el.value = '';
        el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
      }
    }
    await delay(60, 140);
  }
  return readEditableText(el, isCE) === '';
}

async function simulateHumanTyping(el, text, options = {}) {
  if (!el) return;
  const {
    minCharDelay = 45,
    maxCharDelay = 180,
    hesitationProb = 0.08,
    correctionProb = 0.04,
    allowTypos = false,
    allowWordRevision = false,
    requireExact = true,
  } = options;

  el.focus();
  await delay(80, 180);

  const isCE = el.getAttribute('contenteditable') === 'true' || el.isContentEditable;

  // Prefer real trusted keystrokes (CDP via the SW): it clears + types into the focused
  // element with isTrusted=true. Fall back to synthetic DOM typing if CDP is unavailable.
  if (_cdpInput) {
    el.focus();
    await delay(40, 90);
    // Clear is a SEPARATE, verified step (not bundled into the type) so a silently
    // failed clear can't leave us appending the new text onto stale content.
    if (await clearEditable(el, isCE)) {
      const ok = await cdpRequest({ action: 'CDP_TYPE', text, opts: { minCharDelay, maxCharDelay, hesitationProb, clear: false, allowTypos, allowWordRevision } });
      if (ok) {
        await delay(180, 520);
        const exact = await verifyTypedText(el, text, isCE);
        return requireExact ? exact : true;
      }
    }
    _cdpInput = false; // CDP clear or type failed → synthetic path (which re-clears)
  }

  // Clear existing content.
  if (isCE) {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const setter = nativeInputSetter();
    if (setter) setter.call(el, ''); else el.value = '';
    el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
  }
  await delay(60, 140);

  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (featureOn('emojiPause') && /\p{Extended_Pictographic}/u.test(char)) await delay(200, 600);

    let charDelay = gaussianRandom(minCharDelay, maxCharDelay);
    if (Math.random() < hesitationProb) charDelay += gaussianRandom(250, 650);
    await delay(charDelay);

    typeOneChar(el, char, isCE);

    // Occasional human correction: backspace then retype. ASCII letters only, mirroring
    // the CDP path so fallback typing never disrupts Korean IME composition.
    if (allowTypos && /[A-Za-z]/.test(char) && Math.random() < correctionProb && i > 2) {
      await delay(120, 280);
      deleteOneChar(el, isCE);
      await delay(180, 420);
      typeOneChar(el, char, isCE);
    }

    if (featureOn('punctuationPause')) {
      if (char === ',' || char === '，') await delay(150, 400);
      else if (char === '.' || char === '?' || char === '!' || char === '。') await delay(400, 900);
      else if (char === '\n') await delay(800, 2000);
      if (Math.random() < 0.05) await delay(1500, 4000);
    }
  }

  await delay(180, 520);

  // Recovery for dropped chars (React-controlled <input> live search, or the
  // contentEditable DM composer) — re-type the missing suffix ONE CHAR AT A TIME.
  const exact = await verifyTypedText(el, text, isCE);
  return requireExact ? exact : true;
}

// ── DOM Element Finders ────────────────────────────────────────────────────────

// Robust search button finder — designed to work from DM chat / inbox as well as home.
// On desktop web the search control is usually a persistent item in the left primary navigation.
// We prioritize aria-label + nav container, then text, then legacy explore/search links.
function findSearchButton() {
  // 1. Best: SVG with aria-label inside primary/left nav (most common on wide desktop)
  // 실제 DOM에서 aria-label이 "Search" / "검색" 인 경우가 많지만,
  // 때로는 button 자체에 aria-label이 있고 SVG는 icon만 있는 경우도 있음.
  const svgs = document.querySelectorAll('svg');
  for (const svg of svgs) {
    const label = (svg.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('search') || label.includes('검색')) {
      // Prefer an ancestor that looks like a nav item (left sidebar)
      const parent = svg.closest('a, div[role="link"], div[role="button"], button, li') || svg.parentElement;
      if (parent) {
        // If we can find a nav container ancestor, prefer those
        if (parent.closest('nav, [role="navigation"], aside, [data-testid*="nav"]')) return parent;
        return parent;
      }
    }
  }

  // 2. Look for explicit left/primary nav containers and search within them (key for DM view)
  const navContainers = document.querySelectorAll('nav[role="navigation"], [role="navigation"], aside, nav');
  for (const nav of navContainers) {
    const candidates = nav.querySelectorAll('a, [role="link"], [role="button"], button, div[role="button"], li');
    for (const el of candidates) {
      const txt = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (txt === 'search' || txt === '검색' || aria.includes('search') || aria.includes('검색')) {
        return el;
      }
      // Also check child SVG aria inside this nav item
      const childSvg = el.querySelector('svg');
      if (childSvg) {
        const cl = (childSvg.getAttribute('aria-label') || '').toLowerCase();
        if (cl.includes('search') || cl.includes('검색')) return el;
      }
    }
  }

  // 3. Legacy fallbacks (mobile/responsive or older layouts)
  const searchLinks = document.querySelectorAll('a[href*="/explore/"], a[href*="/search/"]');
  if (searchLinks.length > 0) return searchLinks[0];

  const elements = document.querySelectorAll('a, button, div[role="button"]');
  for (const el of elements) {
    const text = el.textContent.trim().toLowerCase();
    if (text === 'search' || text === '검색') {
      return el;
    }
  }
  return null;
}

// Robust search input finder
function findSearchInput() {
  const selectors = [
    'input[placeholder="Search"]',
    'input[placeholder="검색"]',
    'input[aria-label="Search input"]',
    'input[aria-label="검색 입력"]',
    'input[role="searchbox"]',
    'input[type="text"][placeholder*="Search" i]',
    'input[type="text"][placeholder*="검색" i]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  // Fallback: search all text inputs for placeholder containing search words
  const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
  for (const input of inputs) {
    const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
    const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
    if (placeholder.includes('search') || placeholder.includes('검색') ||
        ariaLabel.includes('search') || ariaLabel.includes('검색')) {
      return input;
    }
  }
  return null;
}

// Robust profile result link finder (after search panel opens)
// Looks for user result rows/cards. On desktop results often appear in a left panel list.
function findProfileResultLink(handle) {
  const lowerHandle = handle.toLowerCase().replace(/^@/, '').trim();

  // 1. Exact href match (most reliable when result is a profile link)
  const exactSelector = `a[href="/${lowerHandle}/"], a[href="/${handle}/"]`;
  let exact = document.querySelector(exactSelector);
  if (exact) return exact;

  // 2. Any link whose href contains the handle
  const links = document.querySelectorAll('a');
  for (const link of links) {
    const href = (link.getAttribute('href') || '').toLowerCase();
    if (href === `/${lowerHandle}/` || href === `/${lowerHandle}`) return link;
    if (href.includes(`/${lowerHandle}/`)) return link;
  }

  // 3. Fallback: look for text containing the handle inside common result containers (user cards)
  const resultContainers = document.querySelectorAll('div[role="dialog"], div[role="list"], [role="listitem"], a[href^="/"]');
  for (const c of resultContainers) {
    if ((c.textContent || '').toLowerCase().includes(lowerHandle)) {
      const linkInside = c.closest('a') || c.querySelector('a');
      if (linkInside) return linkInside;
      // If the container itself acts clickable
      if (c.getAttribute('role') === 'listitem' || c.tagName === 'A') return c;
    }
  }
  return null;
}

// Robust message button finder on the PROFILE. Hard rules:
//  - NEVER return the left-nav "메시지" (Direct inbox) link — it opens the inbox.
//  - NEVER return a Follow/Following button — clicking that would follow the person.
// Matches on text OR aria-label (so an icon-only "메시지 보내기" button is still found).
function isFollowControl(el) {
  const t = (el.textContent || '').trim();
  const a = ((el.getAttribute && el.getAttribute('aria-label')) || '').trim();
  return /^(팔로우|팔로잉|맞팔로우|follow|following|follow back|requested|요청됨)$/i.test(t)
      || /^(팔로우|팔로잉|follow|following)$/i.test(a);
}
function findMessageButton() {
  const elements = document.querySelectorAll('a, button, div[role="button"]');
  const isNavInbox = (el) => !!(el.closest && el.closest('nav')) || /^\/direct\/?$/.test((el.getAttribute && el.getAttribute('href')) || '');
  const labelOf = (el) => `${(el.getAttribute && el.getAttribute('aria-label')) || ''} ${el.textContent || ''}`.trim().toLowerCase();
  const eligible = (el) => !isNavInbox(el) && !isFollowControl(el);
  const exact = (el, opts) => {
    const t = (el.textContent || '').trim().toLowerCase();
    const a = ((el.getAttribute && el.getAttribute('aria-label')) || '').trim().toLowerCase();
    return opts.some((o) => t === o || a === o);
  };
  // 1. Explicit profile "send message" action (text OR aria-label), never follow/nav inbox.
  for (const el of elements) { if (eligible(el) && exact(el, ['message', '메시지 보내기', '메시지보내기'])) return el; }
  // 2. Bare "메시지"/"message" (some variants label the profile button just "메시지").
  for (const el of elements) { if (eligible(el) && exact(el, ['메시지', 'message'])) return el; }
  // 3. A /direct/<thread> action link, excluding the nav inbox.
  for (const el of document.querySelectorAll('a[href*="/direct/"]')) { if (!isNavInbox(el)) return el; }
  // 4. Loose contains-match (text OR aria), still excluding follow + nav inbox.
  for (const el of elements) {
    if (eligible(el) && /message|메시지/.test(labelOf(el))) return el;
  }
  return null;
}

function findMessageInput() {
  // DM composer input (desktop often has role=textbox contenteditable in the thread footer area)
  const textboxes = document.querySelectorAll('div[contenteditable="true"][role="textbox"]');
  if (textboxes.length > 0) return textboxes[0];

  // Fallback: last contenteditable (sometimes the composer is the last one after search/profile)
  const anyContentEditable = document.querySelectorAll('div[contenteditable="true"]');
  if (anyContentEditable.length > 0) {
    return anyContentEditable[anyContentEditable.length - 1];
  }
  return null;
}

function findSendButton() {
  const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
  for (const b of buttons) {
    const text = (b.textContent || '').trim();
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    if (text === 'Send' || text === '보내기' || aria.includes('send') || aria.includes('보내기')) {
      return b;
    }
  }
  return null;
}

// ── Situational Awareness, Diagnosis & Fallback Logic ───────────────────────────

/**
 * assessCurrentInstagramState
 * 주기적으로 페이지 상태를 파악.
 * 단순 phase뿐만 아니라 "왜 이 단계가 안 되는지"를 진단할 수 있는 신호도 함께 수집.
 */
async function assessCurrentInstagramState() {
  const pathname = location.pathname.toLowerCase();
  const hasSearchInput = !!findSearchInput();
  const hasSearchButton = !!findSearchButton();
  const hasMessageInput = !!findMessageInput();
  const hasSendButton = !!findSendButton();
  const hasMessageButton = !!findMessageButton();
  const blockDialogReason = detectBlockDialogReason();
  const hasBlock = !!blockDialogReason;

  let currentProfile = null;
  const urlMatch = pathname.match(/^\/([a-z0-9._]+)\/?$/);
  if (urlMatch) currentProfile = urlMatch[1];
  if (!currentProfile) {
    const header = document.querySelector('header');
    if (header) {
      const headerText = header.textContent.toLowerCase();
      const possible = headerText.match(/@?([a-z0-9._]{1,30})/);
      if (possible) currentProfile = possible[1];
    }
  }

  const inDMThread = pathname.includes('/direct/') || hasMessageInput;
  const searchResultsCount = document.querySelectorAll('a[href^="/"], [role="listitem"]').length;
  const inSearchResults = hasSearchInput && searchResultsCount > 3;

  // 추가 진단 신호 (왜 진행이 안 되는지 파악하기 위함)
  const bodyText = (document.body.textContent || '').toLowerCase();
  const tryAgainLaterSignal = bodyText.includes('try again later')
    ? 'try again later'
    : bodyText.includes('나중에 다시 시도')
      ? '나중에 다시 시도'
      : null;
  const hasTryAgainLater = !!tryAgainLaterSignal;
  const restrictPhrases = [
    'we limit how often',
    'restrict certain activity',
    'temporarily restricted',
    'action blocked',
    '일부 활동을 제한',
    '활동이 제한',
    '일시적으로 제한',
    '작업이 차단',
  ];
  const restrictSignal = restrictPhrases.find((phrase) => bodyText.includes(phrase)) || null;
  const hasRestrictMessage = !!restrictSignal;
  const restrictionSignals = [...new Set([blockDialogReason, tryAgainLaterSignal, restrictSignal].filter(Boolean))];
  const leftNavVisible = hasSearchButton; // nav가 보이면 검색 버튼이 있어야 함
  const isNarrowViewport = window.innerWidth < 900;

  let phase = 'unknown';
  if (hasBlock) phase = 'blocked';
  else if (hasMessageInput) phase = 'dm_composer_ready';
  else if (inDMThread) phase = 'dm_thread';
  else if (hasMessageButton && currentProfile) phase = 'on_profile';
  else if (inSearchResults || hasSearchInput) phase = 'search_results_or_panel';
  else if (pathname === '/' || pathname === '/explore/' || hasSearchButton) phase = 'feed_or_home';

  const state = {
    pathname,
    phase,
    currentProfile,
    hasSearchInput,
    hasSearchButton,
    hasMessageInput,
    hasSendButton,
    hasMessageButton,
    hasBlockDialog: hasBlock,
    url: location.href,
    leftNavVisible,
    isNarrowViewport,
    searchResultsCount,
    hasTryAgainLater,
    hasRestrictMessage,
    restrictionSignals,
    timestamp: Date.now()
  };

  if (Math.random() < 0.12) {
    console.log('[Automator] State assessment:', state);
  }
  return state;
}

/**
 * diagnoseWhyStuck
 * 특정 단계에서 "왜 진행이 안 되는지 / 왜 요소가 없는지"를 분석.
 * 예상되는 상황별로 메시지를 만들어서 로그 + 에러에 활용.
 */
function diagnoseWhyStuck(phase, targetHandle, state) {
  const reasons = [];

  if (phase === 'search_button' || phase === 'search_results_or_panel') {
    if (!state.hasSearchButton) {
      if (state.isNarrowViewport) reasons.push('뷰포트가 좁아서 왼쪽 네비가 collapsed 상태일 수 있음');
      else reasons.push('현재 화면에서 왼쪽 검색 네비 버튼을 찾을 수 없음 (DM 리스트 내부일 가능성 높음)');
    }
    if (state.hasSearchInput && state.searchResultsCount < 3) {
      reasons.push('검색 패널은 열렸으나 결과가 거의 없음 (핸들 오타, IG 검색 지연, 또는 계정 숨김)');
    }
    if (state.hasTryAgainLater) reasons.push('IG가 "나중에 다시 시도" 제한 상태');
  }

  if (phase === 'profile' || phase === 'on_profile') {
    if (!state.currentProfile) {
      reasons.push('URL이나 헤더에서 현재 프로필을 감지하지 못함 (로딩 중이거나 이동 실패)');
    }
    if (targetHandle && state.currentProfile && !state.currentProfile.includes(targetHandle.toLowerCase().slice(0,5))) {
      reasons.push(`현재 프로필(${state.currentProfile})이 목표(${targetHandle})와 다름 — 잘못된 결과 클릭 가능성`);
    }
    if (!state.hasMessageButton) {
      reasons.push('프로필에 메시지 버튼이 없음 (비공개 계정, 메시지 차단, 또는 "메시지 보내기" 텍스트 변형)');
    }
  }

  if (phase === 'dm_composer' || phase === 'dm_composer_ready') {
    if (!state.hasMessageInput) {
      if (state.hasMessageButton) reasons.push('메시지 버튼은 찾았으나 클릭 후 composer가 열리지 않음');
      else reasons.push('DM 작성창(contenteditable)이 현재 페이지에 없음 — 아직 스레드가 완전히 로드되지 않았거나 inbox 리스트에 있을 수 있음');
    }
  }

  if (state.hasBlockDialog || state.hasTryAgainLater || state.hasRestrictMessage) {
    reasons.push('IG 제한 다이얼로그 감지됨 (rate limit, spam filter, 또는 "try again later")');
  }

  if (reasons.length === 0) {
    reasons.push('명확한 원인을 특정하기 어려움. UI 구조 변경, 네트워크 지연, 또는 A/B 테스트 가능성 높음');
  }

  return {
    phase,
    targetHandle,
    suspectedReasons: reasons,
    rawState: state
  };
}

function throwIfRestrictedState(state, phase = 'unknown') {
  if (state && (state.hasBlockDialog || state.hasTryAgainLater || state.hasRestrictMessage)) {
    const reason = Array.isArray(state.restrictionSignals) && state.restrictionSignals.length
      ? state.restrictionSignals.join(' / ')
      : '제한 문구 감지';
    throw new Error(`ACTION_BLOCKED: IG 제한 상태 감지됨 (${phase}) — ${reason}`);
  }
}

/**
 * ensureInGoodStateForPhase + 진단 기반 fallback
 */
async function ensureInGoodStateForPhase(expectedPhase, targetHandle) {
  let state = await assessCurrentInstagramState();

  throwIfRestrictedState(state, expectedPhase);

  const diagnosis = diagnoseWhyStuck(expectedPhase, targetHandle, state);

  // 상황별 판단 + fallback
  if (expectedPhase === 'search_results_or_panel' && !state.hasSearchInput) {
    console.warn('[Automator] 진단:', diagnosis);
    console.log('[Automator] 검색 패널이 없음 → 검색 버튼 재시도 (fallback)');
    let btn = findSearchButton();
    if (!btn && state.isNarrowViewport) {
      window.scrollBy(0, -300); // collapsed nav를 보이게
      await delay(300, 600);
      btn = findSearchButton();
    }
    if (btn) {
      await simulateHumanClick(btn);
      await delay(700, 1400);
    }
  }

  if (expectedPhase === 'on_profile' && state.phase !== 'on_profile' && targetHandle) {
    console.warn('[Automator] 진단:', diagnosis);
    console.log('[Automator] 프로필이 아님 → 검색 재시도 (fallback)');
    const btn = findSearchButton();
    if (btn) {
      await simulateHumanClick(btn);
      await delay(600, 1100);
      const inp = findSearchInput();
      if (inp) {
        // 전체 다시 타이핑 (이전 입력이 partial이었을 수 있음)
        const typed = await simulateHumanTyping(inp, targetHandle, {
          minCharDelay: 55,
          maxCharDelay: 145,
          hesitationProb: 0.06,
          correctionProb: 0,
          allowTypos: false,
          allowWordRevision: false,
        });
        if (!typed) throw new Error('검색어 입력 검증 실패');
        await delay(900, 1500);
      }
    }
  }

  if (expectedPhase === 'dm_composer_ready' && !state.hasMessageInput) {
    console.warn('[Automator] 진단:', diagnosis);
    console.log('[Automator] DM composer가 없음 → 추가 대기 + 상태 재확인 (fallback)');
    await delay(900, 1800);
  }

  return await assessCurrentInstagramState();
}

// ── Automated Sequences ───────────────────────────────────────────────────────

async function handleSearchAndSend(handle, text, entry) {
  console.log(`[Automator] Starting search sequence for @${handle} | current path=${location.pathname} | entry=${entry || 'search'}`);

  const cleanHandle = handle.replace(/^@/, '').trim();

  // === 사람 흐름 + 지연 전략 (사용자가 원하는 동작) ===
  // - 사람은 검색 아이콘을 보고 비교적 빠르게 클릭 (decisive action).
  // - 타이핑은 자연 속도 (simulateHumanTyping이 담당).
  // - 결과가 보이면 빠르게 정확한 카드 클릭.
  // - 프로필 도착 후에는 실제로 읽고 판단하는 긴 변수 시간 (cognitive load).
  // - 메시지 작성 후 리뷰 시간은 길게.
  // - 전체적으로 "무조건 랜덤하게 오래 쉬기"가 아니라 단계별로 빠를 땐 빠르게, 생각할 땐 길게.
  //
  // 전체 Flow 요약 (이 파일 + sidepanel.js):
  // 1. Sidepanel bulk/single 루프 → sendSingleTarget
  // 2. IG 탭 활성화 + PING
  // 3. SEARCH_AND_SEND 메시지 전송
  // 4. handleSearchAndSend (아래 상세)
  // 5. handleAutoSend (아래 상세)
  // 6. 성공 시 sidepanel에서 status='sent' + log 기록
  // 7. 다음 타겟은 현재 열린 DM 스레드 상태에서 다시 왼쪽 검색부터 시작 (홈 복귀 없음)
  //
  // - 현재 화면이 홈이든, 이전 DM 채팅이든 상관없이 왼쪽 사이드바(영구 네비)의 검색 아이콘을 클릭
  // - 검색 패널 열기 → 핸들 입력 → 결과 클릭 → 프로필 → 메시지 버튼 → DM 작성창
  // - 발송 후 탭은 DM 채팅에 남고, 다음 iteration에서 다시 왼쪽 검색을 클릭 (홈 복귀 없음)

  // 주기적으로 상태 파악 + fallback
  let state = await assessCurrentInstagramState();

  // Track A — entry diversification: if the side panel pre-navigated us straight onto the
  // target's profile (URL route), skip the whole search phase; otherwise run the normal
  // left-nav search. A 'feed' route browses the home feed first for a more natural origin.
  const onTargetProfile = location.pathname.toLowerCase().replace(/\/+$/, '') === `/${cleanHandle.toLowerCase()}`;
  if (!onTargetProfile) {
  await maybeFeedDetour(entry);
  state = await ensureInGoodStateForPhase('search_results_or_panel', cleanHandle);

  // Phase 1: 검색 컨트롤 (이미 열려있을 수 있음)
  let searchInput = findSearchInput();
  if (searchInput) {
    console.log('[Automator] Search panel already open — reusing it (human would do this)');
  } else {
    let searchBtn = null;
    for (let i = 0; i < 12; i++) {
      searchBtn = findSearchButton();
      if (searchBtn) break;
      await delay(400, 900);
      // 주기적 재평가
      if (i % 3 === 0) state = await assessCurrentInstagramState();
    }
    if (!searchBtn) {
      // Fallback: DM 화면에서 검색 버튼이 안 보이면 전체 페이지 살짝 스크롤해서 nav 보이게 시도
      window.scrollBy(0, -200);
      await delay(300, 600);
      searchBtn = findSearchButton();
    }
    if (!searchBtn) {
      const diag = diagnoseWhyStuck('search_button', cleanHandle, await assessCurrentInstagramState());
      console.error('[Automator] 검색 버튼 진단:', diag);
      throw new Error(`인스타그램 로딩 지연 혹은 왼쪽 검색 아이콘(네비)을 찾을 수 없습니다. 진단: ${diag.suspectedReasons.join(' / ')}`);
    }
    await simulateHumanClick(searchBtn);
    // Human: saw the search icon in the left sidebar and clicked it fairly quickly (decisive, low-cognitive action).
    // Short purposeful wait for the panel to animate in, not long random.
    await delay(280, 520);
  }

  const searchInputReady = await waitForCondition(() => findSearchInput(), { timeout: 8000 });
  if (!searchInputReady) {
    const diag = diagnoseWhyStuck('search_panel_open', cleanHandle, await assessCurrentInstagramState());
    console.error('[Automator] 검색 패널 진단:', diag);
    // Recovery attempt
    state = await ensureInGoodStateForPhase('search_results_or_panel', cleanHandle);
    if (!findSearchInput()) throw new Error(`검색 입력창이 열리지 않았습니다. 진단: ${diag.suspectedReasons.join(' / ')}`);
  }

  searchInput = findSearchInput();
  if (!searchInput) throw new Error('검색 입력창이 열리지 않았습니다. 왼쪽 검색 아이콘 클릭이 제대로 되었는지 확인하세요.');

  // Phase 3: 핸들 입력
  console.log('[Automator] Typing handle naturally into search...');
  const typedSearch = await simulateHumanTyping(searchInput, cleanHandle, {
    minCharDelay: 55,
    maxCharDelay: 165,
    hesitationProb: 0.06,
    correctionProb: 0,
    allowTypos: false,
    allowWordRevision: false,
  });
  if (!typedSearch) throw new Error('검색어 입력 검증 실패');

  console.log(`[Automator] Search input value after typing: "${searchInput?.value || ''}" (target: "${cleanHandle}")`);

  // (simulateHumanTyping now self-recovers dropped chars one-at-a-time, so the old
  // single force-set of the whole handle — a definitive automation signature — is gone.)

  // Humans periodically check if results updated correctly
  await waitForCondition(() => {
    const txt = document.body.textContent.toLowerCase();
    return txt.includes(cleanHandle.toLowerCase());
  }, { timeout: 7000 });

  // Phase 4: 결과 확인 + 선택
  let resultLink = null;
  for (let i = 0; i < 8; i++) {
    await delay(280, 550);
    resultLink = findProfileResultLink(cleanHandle);
    if (resultLink && resultLink.textContent?.toLowerCase().includes(cleanHandle.toLowerCase())) {
      break;
    }
    resultLink = null;
    if (i % 2 === 0) {
      state = await assessCurrentInstagramState();
      if (state.phase === 'on_profile') {
        console.log('[Automator] Already landed on profile during result polling — proceeding');
        break;
      }
    }
  }

  if (!resultLink) {
    // Fallback: 결과가 안 보이면 전체 검색 결과 영역 스크롤해서 더 많은 결과 로드 시도
    const resultsArea = document.querySelector('[role="list"], [role="dialog"]');
    if (resultsArea) resultsArea.scrollBy(0, 300);
    await delay(400, 700);
    resultLink = findProfileResultLink(cleanHandle);
  }

  if (!resultLink) {
    const st = await assessCurrentInstagramState();
    throwIfRestrictedState(st, 'search_results');
    const diag = diagnoseWhyStuck('search_results', cleanHandle, st);
    console.error('[Automator] 검색 결과 진단:', diag);
    throw new Error(`검색 결과에서 @${cleanHandle} 프로필을 찾을 수 없습니다. 진단: ${diag.suspectedReasons.join(' / ')}`);
  }

  await ensureVisibleAndConfirm(resultLink, 'search result for ' + cleanHandle);
  await simulateHumanClick(resultLink);

  console.log('[Automator] Navigating to profile...');

  await waitForCondition(() => {
    const st = location.pathname.toLowerCase();
    return st.includes(cleanHandle.toLowerCase()) || document.querySelector('header')?.textContent?.toLowerCase().includes(cleanHandle.toLowerCase());
  }, { timeout: 7000 });

  // Human saw the profile load (or URL changed) and starts "looking around" fairly soon.
  // Not a huge random sleep here — the real variable time is in the consumption phase below.
  await delay(450, 850);

  } // end search entry (skipped when pre-navigated onto the profile)
  traceStep('profile_reached');

  // Phase 5: 프로필 소비 (상태 재확인 포함)
  state = await assessCurrentInstagramState();
  if (state.phase !== 'on_profile') {
    console.log('[Automator] Not clearly on profile after navigation — small recovery scroll + wait');
    window.scrollBy(0, 150);
    await delay(500, 900);
  }

  console.log('[Automator] Reading profile (natural dwell)...');
  await dwellOnProfile();

  // Track C — capture a 1-line dynamic context from the profile WHILE we're still on it
  // (the DM thread won't have the profile DOM), to fill any {{context}} token in the text.
  let dynamicCtx = null;
  if (featureOn('dynamicContext') && /\{\{\s*context\s*\}\}/.test(text)) dynamicCtx = extractProfileContext();

  // Human finished scanning the profile and now looks for the message button (short transition).
  await delay(180, 420);

  // Phase 5b: 메시지 버튼
  let msgBtn = null;
  for (let i = 0; i < 6; i++) {
    msgBtn = findMessageButton();
    if (msgBtn) break;
    await delay(400, 850);
    if (i % 2 === 0) state = await assessCurrentInstagramState();
  }

  if (!msgBtn) {
    // Fallback: 이미 DM이 열려있을 수 있음
    if (findMessageInput()) {
      console.log('[Automator] Message button not found but composer exists — skipping to send');
    } else {
      const diag = diagnoseWhyStuck('message_button', cleanHandle, await assessCurrentInstagramState());
      console.error('[Automator] 메시지 버튼 진단:', diag);
      throw new Error(`프로필에서 "메시지 보내기" 버튼을 찾을 수 없습니다. 진단: ${diag.suspectedReasons.join(' / ')}`);
    }
  } else if (isFollowControl(msgBtn)) {
    // Safety net: never click a Follow/Following button. Treat as "no message button".
    throw new Error('메시지 보내기 버튼을 찾을 수 없습니다 (팔로우 버튼만 노출 — 메시지 제한 계정).');
  } else {
    await ensureVisibleAndConfirm(msgBtn, 'message button on profile');
    await simulateHumanClick(msgBtn);
  }

  console.log('[Automator] Opened DM chat window.');
  traceStep('message_opened');

  const composerReady = await waitForCondition(() => !!findMessageInput(), { timeout: 8000 });
  if (!composerReady) {
    throw new Error('DM 작성창이 준비되지 않았습니다.');
  }
  traceStep('composer_ready');

  // Human arrived in the chat thread. Short pause to orient, then starts composing.
  await delay(320, 580);

  const finalText = applyContext(text, dynamicCtx);
  assertNoUnresolvedTemplateVars(finalText);
  await handleAutoSend(finalText);
  traceStep('sent');
  return { finalText };
}

async function handleAutoSend(text) {
  console.log('[Automator] Starting auto-send (typing + send) | textLen=' + [...text].length);

  let state = await assessCurrentInstagramState();

  // 1. Composer ready 확인 + fallback
  const inputReady = await waitForCondition(() => !!findMessageInput(), { timeout: 10000 });
  let inputEl = findMessageInput();

  if (!inputReady || !inputEl) {
    state = await ensureInGoodStateForPhase('dm_composer_ready');
    inputEl = findMessageInput();
    if (!inputEl) {
      const diag = diagnoseWhyStuck('dm_composer', null, await assessCurrentInstagramState());
      console.error('[Automator] DM composer 진단:', diag);
      throw new Error(`메시지 입력창을 찾을 수 없습니다. 진단: ${diag.suspectedReasons.join(' / ')}`);
    }
  }

  await ensureVisibleAndConfirm(inputEl, 'DM message input');
  inputEl.focus();
  await delay(80, 180);

  // 2. 메시지 입력 (상태 재확인 포함)
  console.log('[Automator] Composing message in DM (human-like input + review)...');
  await delay(70, 150);

  // Track H — always compose the message char-by-char via trusted CDP typing. The old
  // clipboard "paste path" (Cmd/Ctrl+V + ClipboardEvent + a single execCommand insertText
  // of the whole body) is gone: one bulk insert with no per-key events creates an
  // unnatural input trace. We vary the post-compose review time for naturalness
  // instead of varying the input method.
  const typedMessage = await simulateHumanTyping(inputEl, text, {
    minCharDelay: 40,
    maxCharDelay: 160,
    hesitationProb: 0.09,
    correctionProb: 0.03,
    allowTypos: true,
    allowWordRevision: true,
  });
  if (!typedMessage) {
    try { await clearEditable(inputEl, inputEl.getAttribute('contenteditable') === 'true' || inputEl.isContentEditable); } catch {}
    throw new Error('typed_text_mismatch: 메시지 입력 검증 실패 — 전송하지 않음');
  }

  // Human re-reads what they just wrote before hitting send — longer for longer text,
  // occasionally a beat more ("one more look").
  const reviewBase = 700 + Math.min(2600, text.length * 16);
  await delay(reviewBase, reviewBase + gaussianRandom(500, 1700));
  if (Math.random() < 0.18) await delay(500, 1400);

  // 3. 보내기 전 최종 상태 판단
  state = await assessCurrentInstagramState();
  throwIfRestrictedState(state, 'before_send');

  const sendBtn = findSendButton();
  if (!sendBtn) {
    console.warn('[Automator] Send button not found — trying trusted Enter fallback');
    // Prefer a trusted CDP Enter (isTrusted=true, matching the rest of the input
    // path); fall back to a synthetic keydown only if CDP is unavailable.
    let entered = false;
    if (_cdpInput) entered = await cdpRequest({ action: 'CDP_KEY', key: 'Enter' });
    if (!entered) {
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    }
    await delay(900, 1800);
    if ((inputEl.textContent || '').trim().length > 0) {
      throw new Error('보내기 버튼을 찾을 수 없으며 Enter 키 전송에 실패했습니다.');
    }
    return;
  }

  // 11-10 — hesitate before committing to send (cursor settling on the button).
  if (featureOn('sendHesitation')) await delay(500, 1500);
  await ensureVisibleAndConfirm(sendBtn, 'send button');
  await simulateHumanClick(sendBtn);

  // Message visually appears on the right fairly quickly after clicking send.
  // Short wait for the bubble to render + check for immediate block.
  await delay(800, 1500);

  const postSendBlockReason = detectBlockDialogReason();
  if (postSendBlockReason) {
    throw new Error(`ACTION_BLOCKED: 인스타그램에서 발송을 제한했습니다 — ${postSendBlockReason}`);
  }

  // Post-send review (인간은 보낸 메시지를 한 번 더 확인) — this is the deliberate part.
  console.log('[Automator] Post-send: human review of just-sent message...');
  await delay(550, 1200);
  await simulateHumanScroll(70);
  await delay(300, 650);

  console.log('[Automator] Auto-send completed.');
}

// ── Email collection ───────────────────────────────────────────────────────────
// Reach a profile via the same human-like search flow, expand the bio ("더보기"/
// "more") so any truncated email becomes visible, then regex it out of the bio text.
// Returns { handle, email|null }. The side panel buckets has-email vs no-email
// (no-email targets fall through to the DM queue).

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
const EMAIL_RE_G = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

// Signals that an email in a bio is a CONTACT / outreach address (ko + en).
const CONTACT_KEYWORDS = [
  '문의', '협업', '협찬', '광고', '제휴', '비즈니스', '연락', '메일', '이메일', '컨택', '출연', '섭외', '광고문의', '협찬문의', '광고/협업',
  'contact', 'business', 'collab', 'sponsor', 'inquir', 'partnership', 'advert', 'booking', 'email', 'e-mail', 'work with', 'for business', 'cooperation', 'enquir',
];
// Addresses that are never a person's outreach contact.
const NON_CONTACT = ['noreply', 'no-reply', 'donotreply', 'example.com', '@instagram.com', '@meta.com', 'support@', 'help@'];

const lc = (s) => (s || '').toLowerCase();

// Deobfuscate "name (at) brand (dot) com" / "name[at]brand[dot]com" patterns.
// IMPORTANT: 'at'/'dot'/'점' are ordinary words, so we only treat them as separators when
// BRACKETED — matching them bare corrupts prose ("water at home dot" → "w@er@home.") and
// can fabricate a false email. The Korean symbol-words '골뱅이'/'앳' are unambiguous, so
// those are also accepted spaced. (Trade-off: fully-spaced "name at host dot com" is no
// longer auto-resolved — favouring zero false positives in an auto-send tool.)
function deobfuscate(text) {
  return (text || '')
    .replace(/\s*[\[(]\s*(at|골뱅이|앳)\s*[\])]\s*/gi, '@')
    .replace(/\s+(골뱅이|앳)\s+/g, '@')
    .replace(/\s*[\[(]\s*(dot|점)\s*[\])]\s*/gi, '.');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Reject addresses that are never an influencer's personal outreach contact.
// Anchored to local-part / domain so 'noreplyworks@brand.com' or 'noreply.example.com.kr'
// don't false-trip a bare substring match.
function isNonContact(email) {
  const [local, domain = ''] = lc(email).split('@');
  if (/^(no-?reply|donotreply)([._\-+]|$)/.test(local)) return true;
  if (local === 'support' || local === 'help' || local === 'noreply') return true;
  if (domain === 'example.com' || domain.endsWith('.example.com')) return true;
  if (domain.endsWith('instagram.com') || domain.endsWith('meta.com') || domain === 'facebook.com') return true;
  return false;
}

// The profile bio container — the section holding the username heading, never a
// post/article (so we don't read emails out of post captions or suggested accounts).
function getBioScope() {
  const heading = document.querySelector('header section h2, header section h1, main h2, main h1, section h2, h2');
  if (heading && !heading.closest('article, [role="article"]')) {
    const section = heading.closest('section');
    if (section && !section.closest('article, [role="article"]')) return section;
    // No <section> (e.g. the sandbox clone): bounded walk up to the profile-header block.
    let el = heading;
    for (let i = 0; i < 4 && el.parentElement && el.parentElement.tagName !== 'MAIN' && el.parentElement.tagName !== 'BODY'; i++) {
      el = el.parentElement;
    }
    if (!el.closest('article, [role="article"]')) return el;
  }
  const header = document.querySelector('header');
  if (header && (header.textContent || '').trim()) return header;
  return document.querySelector('main') || document.body;
}

/**
 * extractContactEmail — algorithm-based confirmation that a bio email is the
 * influencer's CONTACT address, instead of blindly taking the first match.
 * Returns { email, confidence, reason } or null (→ no contact email → DM bucket).
 *
 * Scoring (a bio email is a contact by default = 1):
 *   + contact keyword within ±40 chars of the email ... +3
 *   + contact intent elsewhere in the bio ............. +1
 *   + local-part/domain matches the handle ............ +2
 *   + it is the only email in the bio ................. +1
 *   NON_CONTACT addresses (noreply/support/@instagram.com/…) are rejected outright.
 * Policy: collect ANY real (non-system) bio email — a bio email is taken as the person's
 * contact. The score only sets the confidence label, it never gates collection:
 *   score >= 4 → high, >= 2 → medium, else → low.
 */
function extractContactEmail(text, handle) {
  if (!text) return null;
  const sources = [text, deobfuscate(text)];
  const seen = new Set();
  const candidates = [];
  for (const src of sources) {
    let m;
    EMAIL_RE_G.lastIndex = 0;
    while ((m = EMAIL_RE_G.exec(src))) {
      const key = m[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ email: m[0], index: m.index, src });
    }
  }
  if (!candidates.length) return null;

  const handleTokens = lc(handle).replace(/^@/, '').split(/[._]/).filter((t) => t.length >= 3);
  const bioHasContactIntent = CONTACT_KEYWORDS.some((k) => lc(text).includes(k));

  let best = null;
  for (const c of candidates) {
    const e = c.email.toLowerCase();
    if (isNonContact(e)) continue;
    let score = 1;
    const reasons = [];
    const ctx = lc(c.src.slice(Math.max(0, c.index - 40), c.index + e.length + 40));
    if (CONTACT_KEYWORDS.some((k) => ctx.includes(k))) { score += 3; reasons.push('주변 컨택 키워드'); }
    else if (bioHasContactIntent) { score += 1; reasons.push('바이오 컨택 의도'); }
    // Match only the local-part (not the domain), and require ≥4-char tokens or a
    // delimited boundary — so 'kim' doesn't tag 'skimreader@x.com' or a brand domain.
    const local = e.split('@')[0];
    const tok = handleTokens.find((t) =>
      t.length >= 4 ? local.includes(t) : new RegExp(`(^|[._\\-])${escapeRe(t)}([._\\-]|$)`).test(local)
    );
    if (tok) { score += 2; reasons.push(`아이디 일치(${tok})`); }
    if (candidates.length === 1) { score += 1; reasons.push('단일 이메일'); }
    if (!best || score > best.score) best = { email: c.email, score, reasons };
  }
  // Collect any real email (best is already the highest-scoring NON_CONTACT-filtered
  // candidate). No score gate — a bio email is the person's contact; score → confidence only.
  if (!best) return null;
  return {
    email: best.email,
    confidence: best.score >= 4 ? 'high' : best.score >= 2 ? 'medium' : 'low',
    reason: best.reasons.join(', ') || '바이오 이메일',
  };
}

// The bio "더 보기"/"more" expander — scoped to the bio section, skipping any
// post-caption "더보기" inside an <article>. Real IG renders it as "더 보기" (WITH a
// space); the sandbox clone used "더보기" (no space), so we normalize internal whitespace
// and accept both — matching only the no-space form would miss the real-IG expander and
// leave a truncated bio (and any email below the fold) unread.
function findBioExpander() {
  const scope = getBioScope();
  const els = scope.querySelectorAll('button, span[role="button"], div[role="button"], span, a');
  const TOGGLES = ['더보기', 'more', '…more', '…더보기', '계속읽기'];
  for (const el of els) {
    if (el.closest('article, [role="article"]')) continue;
    const t = (el.textContent || '').trim().toLowerCase().replace(/\s+/g, '');
    if (TOGGLES.includes(t)) return el;
  }
  return null;
}

function getProfileText() {
  const scope = getBioScope();
  return scope ? scope.textContent : document.body.textContent;
}

// Track C — a 1-line dynamic context keyword from the profile, to fill a {{context}}
// token in the message (e.g. "최근 {{context}} 포스트 잘 봤어요"). Best-effort + conservative:
// a clean bio hashtag is the most reliable signal; if absent, use a small curated set
// of public bio category words. Returns null when nothing clean is found (caller then
// drops the {{context}} line so we never send a broken sentence).
const CONTEXT_STOPWORDS = new Set([
  '문의', '협업', '협찬', '광고', '제휴', '비즈니스', '연락', '메일', '이메일', '컨택',
  'contact', 'business', 'collab', 'sponsor', 'sponsored', 'ad', 'ads', 'email', 'work',
  'daily', '일상', '소통', '맞팔', '선팔', '팔로우', 'follow', 'dm',
]);
const CONTEXT_KEYWORDS = [
  ['뷰티', ['뷰티', 'beauty', 'makeup', '메이크업', '스킨케어', 'skincare', '화장품', '코스메틱', 'cosmetic']],
  ['패션', ['패션', 'fashion', 'style', '스타일', 'ootd', '데일리룩', '코디']],
  ['맛집', ['맛집', '먹스타', 'food', 'foodie', 'restaurant', '카페', '디저트', '요리', '레시피']],
  ['여행', ['여행', 'travel', 'trip', 'hotel', '호캉스', '캠핑', '나들이']],
  ['운동', ['운동', 'fitness', '헬스', '필라테스', '요가', '러닝', '다이어트']],
  ['육아', ['육아', '키즈', '아이', 'baby', 'mom', '맘스타', 'parenting']],
  ['반려동물', ['반려동물', '강아지', '고양이', '댕댕이', '냥스타', 'pet', 'dog', 'cat']],
  ['인테리어', ['인테리어', '집꾸미기', '홈데코', '리빙', 'interior', 'home decor']],
  ['사진', ['사진', 'photo', 'photography', '스냅', '영상', 'vlog', '릴스', 'reels']],
];
function cleanContextToken(raw) {
  const token = (raw || '').replace(/^#+/, '').replace(/[^\w가-힣]/g, '').trim();
  if (token.length < 2 || token.length > 20) return null;
  if (/^\d+$/.test(token)) return null;
  if (CONTEXT_STOPWORDS.has(lc(token))) return null;
  if (EMAIL_RE.test(token) || /^https?/i.test(token)) return null;
  return token;
}
function extractProfileContext() {
  const text = (getBioScope().textContent || '').trim();
  const tags = [...text.matchAll(/#([0-9A-Za-z가-힣_]{2,20})/g)]
    .map((m) => cleanContextToken(m[1]))
    .filter(Boolean);
  if (tags.length) return tags[0];

  const haystack = lc(text.replace(EMAIL_RE_G, ' '));
  for (const [label, words] of CONTEXT_KEYWORDS) {
    if (words.some((w) => haystack.includes(lc(w)))) return label;
  }
  return null;
}

// Fill or gracefully remove the {{context}} token. With a value → substitute. Without →
// drop whole lines that contained the token (so the message reads naturally), falling
// back to just stripping the token if that would empty the message.
function applyContext(text, ctx) {
  if (!/\{\{\s*context\s*\}\}/.test(text)) return text;
  if (ctx) return text.replace(/\{\{\s*context\s*\}\}/g, ctx);
  const stripped = text
    .split('\n')
    .filter((line) => !/\{\{\s*context\s*\}\}/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped || text.replace(/\{\{\s*context\s*\}\}/g, '').trim();
}

function assertNoUnresolvedTemplateVars(text) {
  const vars = [...String(text || '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  const uniq = [...new Set(vars)];
  if (uniq.length) {
    throw new Error(`template_unresolved: 미해결 템플릿 변수(${uniq.join(', ')})가 남아 있어 전송하지 않음`);
  }
}

// Track D — profile context for skip/priority decisions. Only the reliably-readable
// signals on IG web: followers count + private flag. Last-post recency and category are
// NOT reliably available on the web grid, so we don't fabricate them. Anything we can't
// read stays null/false, and the side panel only ever SKIPS on a positive detection.
function parseCount(s) {
  if (!s) return null;
  const str = String(s).trim().replace(/,/g, '');
  const m = str.match(/([\d.]+)\s*([KMB만천억]?)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, '만': 1e4, '천': 1e3, '억': 1e8 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * mult);
}
function extractFollowersCount() {
  // The followers stat is a link (real IG: a[href*="/followers"]) or, in some Korean UIs,
  // a button labelled "팔로워 N". Find the element whose label is specifically followers
  // (not 팔로우/following) and pull the count from it — the number may come BEFORE the label
  // ("1,234 followers") OR AFTER it ("팔로워 5"), so we just take the first number token.
  let raw = '';
  const isFollowers = (el) => /팔로워|followers/i.test(((el.getAttribute && el.getAttribute('aria-label')) || '') + ' ' + (el.textContent || ''));
  const stat = [...document.querySelectorAll('a[href*="/followers"], a[href*="follow"], button, [role="link"], [role="button"]')].find(isFollowers);
  if (stat) {
    raw = (stat.getAttribute('title') || stat.querySelector('[title]')?.getAttribute('title') || '');
    if (!raw) {
      const m = (stat.getAttribute('aria-label') || stat.textContent || '').match(/([\d.,]+\s*[KMB만천억]?)/);
      if (m) raw = m[1];
    }
  }
  if (!raw) {
    // Last resort: a number adjacent to the followers label on EITHER side.
    const m = (getBioScope().textContent || '').match(/(?:followers|팔로워)\s*([\d.,]+\s*[KMB만천억]?)|([\d.,]+\s*[KMB만천억]?)\s*(?:followers|팔로워)/i);
    if (m) raw = m[1] || m[2];
  }
  return parseCount(raw);
}
function detectPrivateAccount() {
  const t = (document.querySelector('main')?.textContent || '').toLowerCase();
  return t.includes('비공개 계정') || t.includes('this account is private') || t.includes('account is private');
}
function extractProfileMeta() {
  return { followersCount: extractFollowersCount(), isPrivate: detectPrivateAccount() };
}

// Track G — business/creator profiles expose a contact email button, usually a
// <a href="mailto:..."> in the header action row. Reading the address straight from the
// button is cleaner and more reliable than expanding the bio and regexing it out.
function findContactEmailFromButtons() {
  const scope = getBioScope().closest('main') || document.querySelector('main') || document;
  for (const a of scope.querySelectorAll('a[href^="mailto:"]')) {
    const addr = decodeURIComponent((a.getAttribute('href') || '').slice(7).split('?')[0]).trim();
    if (addr && EMAIL_RE.test(addr)) return addr;
  }
  for (const el of scope.querySelectorAll('a, button, [role="button"]')) {
    const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
    if (/이메일|email/.test(label)) {
      const m = (el.textContent || '').match(EMAIL_RE);
      if (m) return m[0];
    }
  }
  return null;
}

// Track A — the home/feed nav item, so the 'feed' route can start from the feed.
function findHomeNav() {
  const nav = document.querySelector('nav, [role="navigation"]') || document.body;
  for (const el of nav.querySelectorAll('a, [role="link"]')) {
    const al = (el.getAttribute('aria-label') || '').toLowerCase();
    const href = el.getAttribute('href') || '';
    if (href === '/' || al === '홈' || al === 'home') return el;
  }
  return null;
}

// 'feed' entry route: browse the home feed briefly before searching, so the search
// doesn't always start from the same place. No-op for other routes or when off.
async function maybeFeedDetour(entry) {
  if (entry !== 'feed' || !featureOn('entryDiversify')) return;
  const home = findHomeNav();
  if (!home) return;
  try {
    await simulateHumanClick(home);
    await delay(700, 1500);
    await simulateHumanScroll(200 + Math.floor(Math.random() * 500));
    await humanDwell(rndInt(800, 2000));
    if (Math.random() < 0.5) { await simulateHumanScroll(-150); await delay(400, 900); }
  } catch { /* best-effort — fall through to the normal search */ }
}

// Track B — close an open post overlay: Escape (trusted) for the modal, history.back()
// if we actually navigated to the post page.
async function closeOverlayOrBack() {
  if (_cdpInput && await cdpRequest({ action: 'CDP_KEY', key: 'Escape' })) { /* trusted */ }
  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
  await delay(400, 800);
  if (/\/(p|reel)\//.test(location.pathname)) { try { history.back(); } catch {} await delay(500, 1000); }
}

// Open 1–2 recent posts, look, and come back — a very human pre-outreach behaviour.
async function peekRecentPost() {
  try {
    const posts = [...document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')]
      .filter((a) => a.offsetParent && !a.closest('article'));
    if (!posts.length) return;
    const count = Math.random() < 0.4 ? 2 : 1;
    for (let i = 0; i < count && i < posts.length; i++) {
      const post = posts[i];
      await ensureVisibleAndConfirm(post, 'recent post');
      await simulateHumanClick(post);
      await delay(700, 1400);
      await humanDwell(rndInt(2500, 6000)); // looking at the post
      await closeOverlayOrBack();
      await delay(600, 1300);
    }
  } catch { /* best-effort */ }
}

// 11-7 — occasionally open a story (active-user signal). Best-effort: the story ring is a
// clickable canvas around the header avatar; watch 1–3s then close with Escape. No-op when
// there's no ring or nothing opens.
async function maybeViewStory() {
  if (!featureOn('storyView') || Math.random() >= 0.1) return;
  try {
    const header = document.querySelector('header');
    const ring = header && header.querySelector('canvas');
    const clickable = ring && (ring.closest('[role="button"], button, div[tabindex]') || ring.parentElement);
    if (!clickable) return;
    await simulateHumanClick(clickable);
    await delay(1200, 2400);
    if (document.querySelector('[role="dialog"] video, section video, [role="dialog"] img[srcset]')) {
      await humanDwell(rndInt(1000, 3000));
      if (!(_cdpInput && await cdpRequest({ action: 'CDP_KEY', key: 'Escape' }))) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      }
      await delay(500, 1000);
    }
  } catch { /* best-effort */ }
}

// Track B — natural profile dwell: read (slow scroll over several seconds), sometimes
// scroll back up, sometimes open a recent post. Precedes the "더보기"/contact action.
// Gated by profileDwell; falls back to a minimal legacy dwell when off.
async function dwellOnProfile() {
  if (!featureOn('profileDwell')) {
    await simulateHumanScroll(180 + Math.floor(Math.random() * 300));
    await delay(650, 1350);
    return;
  }
  // 11-6 — peek a recent post BEFORE reading the bio (curiosity), distinct from the
  // post-read peek further down. 11-7 — occasionally open a story.
  if (featureOn('prePeekPosts') && Math.random() < 0.3) await peekRecentPost();
  await maybeViewStory();
  const passes = rndInt(2, 4);
  for (let i = 0; i < passes; i++) {
    await simulateHumanScroll(160 + Math.floor(Math.random() * 360));
    await humanDwell(rndInt(900, 2200));
  }
  // VII — reading time proportional to how much there is to read (bio length), so a long
  // bio gets a longer look. Char count is capped so surrounding UI text can't inflate it.
  if (featureOn('proportionalDwell')) {
    const chars = Math.min(300, (getBioScope().textContent || '').trim().length);
    await humanDwell(Math.min(10000, 1500 + chars * rndInt(20, 45) + Math.random() * 1500));
  }
  if (Math.random() < 0.2) {
    await simulateHumanScroll(-(150 + Math.floor(Math.random() * 250)));
    await humanDwell(rndInt(500, 1200));
  }
  if (Math.random() < 0.3) await peekRecentPost();
}

// Shared: drive the left-nav search → type handle → click result → land on the
// target's profile. Throws on failure. Used by email scrape, reply check, etc.
async function navigateToProfileViaSearch(cleanHandle, entry) {
  throwIfRestrictedState(await assessCurrentInstagramState(), 'navigate_start');

  // Already on the target profile? (e.g. URL route pre-navigated here.)
  if (location.pathname.toLowerCase().replace(/\/+$/, '') === `/${cleanHandle.toLowerCase()}`) return;

  await maybeFeedDetour(entry);

  // 1. Open search.
  let searchInput = findSearchInput();
  if (!searchInput) {
    let btn = null;
    for (let i = 0; i < 12; i++) { btn = findSearchButton(); if (btn) break; await delay(400, 900); }
    if (!btn) { window.scrollBy(0, -200); await delay(300, 600); btn = findSearchButton(); }
    if (!btn) throw new Error('왼쪽 검색 아이콘을 찾을 수 없습니다.');
    await simulateHumanClick(btn);
    await delay(300, 600);
  }
  await waitForCondition(() => findSearchInput(), { timeout: 8000 });
  searchInput = findSearchInput();
  if (!searchInput) {
    const st = await assessCurrentInstagramState();
    throwIfRestrictedState(st, 'search_panel_open');
    const retryBtn = findSearchButton();
    if (retryBtn) {
      await simulateHumanClick(retryBtn);
      await delay(800, 1400);
      searchInput = findSearchInput();
    }
  }
  if (!searchInput) throw new Error('검색 입력창이 열리지 않았습니다.');

  // 2. Type the handle.
  const typedSearch = await simulateHumanTyping(searchInput, cleanHandle, {
    minCharDelay: 55,
    maxCharDelay: 145,
    hesitationProb: 0.06,
    correctionProb: 0,
    allowTypos: false,
    allowWordRevision: false,
  });
  if (!typedSearch) throw new Error('검색어 입력 검증 실패');
  await waitForCondition(() => document.body.textContent.toLowerCase().includes(cleanHandle.toLowerCase()), { timeout: 7000 });

  // 3. Click the matching result.
  let resultLink = null;
  for (let i = 0; i < 8; i++) {
    await delay(280, 520);
    resultLink = findProfileResultLink(cleanHandle);
    if (resultLink) break;
  }
  if (!resultLink) {
    const st = await assessCurrentInstagramState();
    throwIfRestrictedState(st, 'search_results');
    const diag = diagnoseWhyStuck('search_results', cleanHandle, st);
    throw new Error(`검색 결과에서 @${cleanHandle}를 찾을 수 없습니다. 진단: ${diag.suspectedReasons.join(' / ')}`);
  }
  await ensureVisibleAndConfirm(resultLink, 'search result for ' + cleanHandle);
  await simulateHumanClick(resultLink);
  await waitForCondition(() => {
    const p = location.pathname.toLowerCase();
    return p.includes(cleanHandle.toLowerCase()) || document.querySelector('header')?.textContent?.toLowerCase().includes(cleanHandle.toLowerCase());
  }, { timeout: 7000 });
  await delay(500, 1000);
}

// Follow the profile ONLY when a "팔로우"/"Follow" button is present (never 팔로잉/Following
// = already following). Used by the unified flow when no message button is visible.
async function followIfPossible() {
  const btn = [...document.querySelectorAll('button, div[role="button"], a')].find((el) => {
    const t = (el.textContent || '').trim();
    const a = ((el.getAttribute && el.getAttribute('aria-label')) || '').trim();
    return /^(팔로우|follow)$/i.test(t) || /^(팔로우|follow)$/i.test(a);
  });
  if (!btn) return false;
  console.log('[Automator] No message button — following before DM');
  await ensureVisibleAndConfirm(btn, 'follow button');
  await simulateHumanClick(btn);
  await delay(1500, 3200); // let IG register the follow + re-render the action buttons
  return true;
}

// Unified per-target flow in ONE profile visit:
//   email in bio → collect (done, no DM); no email → DM (follow first ONLY if the message
//   button is missing, then retry). Returns { action: 'collected'|'sent'|'skipped', … }.
async function handleProcessTarget(handle, text, entry) {
  const cleanHandle = handle.replace(/^@/, '').trim();
  console.log(`[Automator] Process @${cleanHandle} | path=${location.pathname} | entry=${entry || 'search'}`);
  await navigateToProfileViaSearch(cleanHandle, entry);
  traceStep('profile_reached');
  await dwellOnProfile();
  const meta = featureOn('smartFilter') ? extractProfileMeta() : {};

  // 1. Email — contact button → bio 더보기 → regex → wider scope.
  let found = null;
  if (featureOn('useContactButton')) {
    const btnEmail = findContactEmailFromButtons();
    if (btnEmail && !isNonContact(btnEmail.toLowerCase())) found = { email: btnEmail, confidence: 'high', reason: '연락처 버튼' };
  }
  if (!found) {
    const expander = findBioExpander();
    if (expander) {
      await ensureVisibleAndConfirm(expander, 'bio expander');
      await simulateHumanClick(expander);
      await waitForCondition(() => !findBioExpander() || EMAIL_RE.test(getProfileText()), { timeout: 4000 });
      await humanDwell(rndInt(300, 600));
    }
    found = extractContactEmail(getProfileText(), cleanHandle);
    if (!found && featureOn('emailMultiPath')) {
      found = extractContactEmail(document.querySelector('main')?.textContent || document.body.textContent || '', cleanHandle);
      if (found) found.reason = (found.reason ? found.reason + ', ' : '') + '전체 영역';
    }
  }
  traceStep('email_done', { found: !!found });
  if (found) {
    console.log(`[Automator] @${cleanHandle} → email ${found.email} → collect (no DM)`);
    return { action: 'collected', handle: cleanHandle, email: found.email, confidence: found.confidence, reason: found.reason, ...meta };
  }

  // 2. No email → DM. Follow only if the message button is missing, then retry.
  let msgBtn = findMessageButton();
  if ((!msgBtn || isFollowControl(msgBtn)) && featureOn('autoFollow')) {
    if (await followIfPossible()) {
      await waitForCondition(() => { const b = findMessageButton(); return b && !isFollowControl(b); }, { timeout: 7000 });
      msgBtn = findMessageButton();
    }
  }
  if (!msgBtn || isFollowControl(msgBtn)) {
    console.log(`[Automator] @${cleanHandle} → no message button (DM 불가) → skip`);
    return { action: 'skipped', handle: cleanHandle, reason: 'no_message_button', ...meta };
  }

  await ensureVisibleAndConfirm(msgBtn, 'message button');
  await simulateHumanClick(msgBtn);
  traceStep('message_opened');
  if (!await waitForCondition(() => !!findMessageInput(), { timeout: 8000 })) throw new Error('DM 작성창이 준비되지 않았습니다.');
  traceStep('composer_ready');
  await delay(320, 580);
  let ctx = null;
  if (featureOn('dynamicContext') && /\{\{\s*context\s*\}\}/.test(text)) ctx = extractProfileContext();
  const finalText = applyContext(text, ctx);
  assertNoUnresolvedTemplateVars(finalText);
  await handleAutoSend(finalText);
  traceStep('sent');
  return { action: 'sent', handle: cleanHandle, finalText, ...meta };
}

async function handleScrapeEmail(handle, entry) {
  const cleanHandle = handle.replace(/^@/, '').trim();
  console.log(`[Automator] Scraping email for @${cleanHandle} | path=${location.pathname} | entry=${entry || 'search'}`);
  await navigateToProfileViaSearch(cleanHandle, entry);
  traceStep('profile_reached');

  // 4. Human reads the profile (natural dwell), then expands the bio if it's collapsed.
  await dwellOnProfile();

  // Track D — capture profile context (followers / private) while on the profile, for
  // the side panel's skip + priority decisions. Included in every return path below.
  const meta = featureOn('smartFilter') ? extractProfileMeta() : {};

  // Track G — prefer the business contact email button (often a mailto link) over 더보기.
  if (featureOn('useContactButton')) {
    const btnEmail = findContactEmailFromButtons();
    if (btnEmail && !isNonContact(btnEmail.toLowerCase())) {
      console.log(`[Automator] Contact email via business button: ${btnEmail}`);
      traceStep('email_done', { via: 'contact_button', found: true });
      return { handle: cleanHandle, email: btnEmail, confidence: 'high', reason: '연락처 버튼', ...meta };
    }
  }

  const expander = findBioExpander();
  if (expander) {
    console.log('[Automator] Expanding bio via 더보기/more');
    await ensureVisibleAndConfirm(expander, 'bio expander');
    await simulateHumanClick(expander);
    // Wait until the bio actually expands (the expander disappears or an email surfaces)
    // — a fixed delay is unreliable because the page re-renders the bio asynchronously.
    await waitForCondition(() => !findBioExpander() || EMAIL_RE.test(getProfileText()), { timeout: 4000 });
    await humanDwell(rndInt(300, 600));  // reading the now-expanded bio
  }
  traceStep('bio_read', { expanderFound: !!expander });

  // 5. Confirm a CONTACT email from the now-full bio text (algorithm-based, not first match).
  let found = extractContactEmail(getProfileText(), cleanHandle);

  // Email multi-path — if the bio-scoped pass found nothing, re-scan a wider scope (the
  // whole profile main) with the SAME strict scoring (requires contact intent / handle
  // match), so an unrelated footer address can't qualify. (The m.instagram.com backup
  // and story-highlight contact paths are deferred: cross-origin reload / image content.)
  if (!found && featureOn('emailMultiPath')) {
    found = extractContactEmail(document.querySelector('main')?.textContent || document.body.textContent || '', cleanHandle);
    if (found) found.reason = (found.reason ? found.reason + ', ' : '') + '전체 영역';
  }

  console.log(
    `[Automator] Contact email for @${cleanHandle}: ${found ? `${found.email} (${found.confidence}: ${found.reason})` : '(none — DM bucket)'}`
  );
  traceStep('email_done', { via: 'bio', found: !!found });
  return {
    handle: cleanHandle,
    email: found ? found.email : null,
    confidence: found ? found.confidence : null,
    reason: found ? found.reason : null,
    ...meta,
  };
}

// Navigate to a specific target's DM thread (so we scan the RIGHT chat), then detect a reply.
// Without this, CHECK_REPLY scanned whatever page happened to be open → wrong readings.
async function handleCheckReply(handle) {
  const cleanHandle = (handle || '').replace(/^@/, '').trim();
  if (cleanHandle) {
    const headerTxt = (document.querySelector('header')?.textContent || '').toLowerCase();
    const inThisThread = location.pathname.includes('/direct/') && headerTxt.includes(cleanHandle.toLowerCase());
    if (!inThisThread) {
      await navigateToProfileViaSearch(cleanHandle);
      let msgBtn = null;
      for (let i = 0; i < 6; i++) { msgBtn = findMessageButton(); if (msgBtn) break; await delay(400, 800); }
      if (msgBtn) {
        await ensureVisibleAndConfirm(msgBtn, 'message button (reply check)');
        await simulateHumanClick(msgBtn);
      }
      const composerReady = await waitForCondition(() => !!findMessageInput(), { timeout: 8000 });
      if (!composerReady) throw new Error('DM 스레드를 열지 못해 응답을 확인할 수 없습니다.');
      await delay(400, 800);
    }
  }
  return await detectReplyFromTarget();
}

async function detectReplyFromTarget() {
  console.log('[Automator] Checking for replies...');
  // Wait for the chat history to render
  await delay(1000, 1500);

  const rows = Array.from(document.querySelectorAll('div[role="row"]'));
  if (rows.length === 0) {
    console.warn('[Automator] No message rows found.');
    return false;
  }

  // Traverse from the most recent message upwards
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 10); i--) {
    const row = rows[i];
    const html = row.innerHTML;
    // Skip empty rows
    if (!row.textContent.trim() && !html.includes('<img')) continue;

    const isTheirs = html.includes('justify-content: flex-start') ||
                     html.includes('align-items: flex-start') ||
                     row.querySelector('img[alt*="profile picture"]') ||
                     row.querySelector('img[alt*="프로필"]');
    const isMine = html.includes('justify-content: flex-end') ||
                   html.includes('align-items: flex-end');

    if (isTheirs) {
      console.log('[Automator] Reply detected!');
      return true;
    }
    if (isMine) {
      console.log('[Automator] Last message was ours. No reply yet.');
      return false;
    }
  }
  return false;
}

function detectBlockDialogReason() {
  const hardPhrases = [
    'try again later',
    '나중에 다시 시도',
    'restrict certain activity',
    '활동이 제한',
    '차단되었습니다',
  ];
  const dialogs = document.querySelectorAll('div[role="dialog"], div[data-visualcompletion="ignore"]');
  for (const d of dialogs) {
    const text = d.textContent.toLowerCase();
    const hit = hardPhrases.find((phrase) => text.includes(phrase));
    if (hit) return hit;
  }
  return null;
}

function detectBlockDialog() {
  return !!detectBlockDialogReason();
}

// Track F — SOFT signals: early-warning text that often precedes a hard block. Scoped to
// dialog/alert/toast containers (and short ones) to limit false positives from ordinary
// page copy. Returns a reason phrase or null. The HARD block stays detectBlockDialog →
// ACTION_BLOCKED; this is the proactive "back off before the block" signal.
function detectSoftSignal() {
  const SOFT = [
    'try again later', '나중에 다시 시도', '다시 시도해', 'please wait', '잠시 후 다시',
    'we limit how often', '일부 활동을 제한', '활동이 제한', 'temporarily restricted', '일시적으로 제한',
    'tried too often', 'suspicious', '수상한 활동', '비정상적인 활동', 'action blocked',
    '작업이 차단', 'restrict certain activity', 'couldn’t send', "couldn't send", '전송하지 못', '보낼 수 없',
  ];
  const containers = document.querySelectorAll(
    'div[role="dialog"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]'
  );
  for (const c of containers) {
    const t = (c.textContent || '').toLowerCase();
    if (!t || t.length > 600) continue; // skip whole-page dialogs (false-positive prone)
    const hit = SOFT.find((p) => t.includes(p));
    if (hit) return hit;
  }
  return null;
}

// Track F — "natural mode": browse the home feed for a while during a cooldown break.
// Driven by the side panel after a soft signal.
async function naturalModeBrowse(ms) {
  const until = performance.now() + Math.max(10000, ms || 0);
  const home = findHomeNav();
  if (home) { try { await simulateHumanClick(home); await delay(800, 1600); } catch {} }
  while (performance.now() < until) {
    await simulateHumanScroll(200 + Math.floor(Math.random() * 600));
    await humanDwell(rndInt(1500, 4500));
    if (Math.random() < 0.25) {
      await simulateHumanScroll(-(120 + Math.floor(Math.random() * 240)));
      await humanDwell(rndInt(800, 2000));
    }
  }
}

// Track X — one bit of intentional-noise navigation, so it's not 100% forward motion.
// All best-effort and harmless: the next target re-navigates from wherever we land.
async function intentNoise(kind) {
  try {
    if (kind === 'searchClose') {
      const btn = findSearchButton();
      if (btn) {
        await simulateHumanClick(btn);
        await delay(700, 1600);
        if (!(_cdpInput && await cdpRequest({ action: 'CDP_KEY', key: 'Escape' }))) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        }
        await delay(400, 900);
      }
    } else if (kind === 'back') {
      try { history.back(); } catch {}
      await delay(1200, 2600);
      await humanDwell(rndInt(800, 2000));
    } else if (kind === 'unrelated') {
      const dest = document.querySelector('a[href="/explore/"], a[href*="/explore"]') || findHomeNav();
      if (dest) {
        await simulateHumanClick(dest);
        await delay(900, 1800);
        await simulateHumanScroll(300 + Math.floor(Math.random() * 500));
        await humanDwell(rndInt(1500, 4000));
      }
    }
  } catch { /* noise is best-effort */ }
}

// ── Debug / Diagnostics ────────────────────────────────────────────────────────

function dumpPageState() {
  const url = location.href;
  const pathname = location.pathname;
  const title = document.title;
  const vw = window.innerWidth;

  // Sample left nav / primary navigation candidates (the persistent search trigger lives here on desktop)
  const nav = document.querySelector('nav[role="navigation"], [role="navigation"], aside');
  const navTexts = nav ? Array.from(nav.querySelectorAll('a, [role="link"], [role="button"], div, span'))
    .map(el => (el.textContent || el.getAttribute('aria-label') || '').trim())
    .filter(Boolean)
    .slice(0, 30) : [];

  // Search trigger candidates (what findSearchButton sees)
  const searchSvgs = Array.from(document.querySelectorAll('svg')).filter(s => {
    const l = (s.getAttribute('aria-label') || '').toLowerCase();
    return l.includes('search') || l.includes('검색');
  }).map(s => ({ aria: s.getAttribute('aria-label'), parentTag: s.closest('a,button,div')?.tagName }));

  const searchLinks = Array.from(document.querySelectorAll('a[href*="/explore/"], a[href*="/search/"]')).map(a => a.getAttribute('href'));
  const exactSearchTextEls = Array.from(document.querySelectorAll('a, button, div[role="button"]'))
    .filter(el => ['search','검색'].includes((el.textContent || '').trim().toLowerCase()))
    .map(el => el.outerHTML.substring(0, 200));

  // Search input candidates
  const searchInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), input[role="searchbox"]'))
    .map(inp => ({
      placeholder: inp.getAttribute('placeholder'),
      aria: inp.getAttribute('aria-label'),
      value: inp.value
    })).slice(0, 8);

  // Profile results (rough)
  const profileLinks = Array.from(document.querySelectorAll('a[href^="/"]'))
    .filter(a => /^\/[a-zA-Z0-9._]+\/?$/.test(a.getAttribute('href') || ''))
    .map(a => ({ href: a.getAttribute('href'), text: (a.textContent || '').slice(0, 60) }))
    .slice(0, 10);

  // Message buttons
  const msgEls = Array.from(document.querySelectorAll('a, button, div[role="button"]'))
    .filter(el => /message|메시지|보내기/i.test(el.textContent || ''))
    .map(el => ({ text: (el.textContent || '').trim().slice(0, 40), tag: el.tagName }));

  // DM composer inputs
  const contentEditables = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
    .map(el => ({ role: el.getAttribute('role'), textPreview: (el.textContent || '').slice(0, 80) }))
    .slice(0, 6);

  // Send buttons
  const sendEls = Array.from(document.querySelectorAll('div[role="button"], button'))
    .filter(b => ['send','보내기'].includes((b.textContent || '').trim().toLowerCase()))
    .map(b => b.outerHTML.substring(0, 150));

  const state = {
    url, pathname, title, viewportWidth: vw,
    navSample: navTexts.slice(0, 12),
    search: {
      svgWithAria: searchSvgs,
      exploreLinks: searchLinks,
      exactTextMatches: exactSearchTextEls
    },
    searchInputs,
    profileResults: profileLinks,
    messageButtons: msgEls,
    dmComposer: contentEditables,
    sendButtons: sendEls,
    timestamp: Date.now()
  };

  // Include live assessment (fire and forget so dump stays sync-friendly)
  assessCurrentInstagramState().then(s => {
    try { state.liveAssessment = s; } catch {}
  }).catch(() => {});

  console.log('[Automator] DUMP_PAGE_STATE', state);
  return state;
}
