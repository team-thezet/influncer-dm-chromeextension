// Side-panel app: campaign + target management, template builder, queue preview,
// browser workflow controls, and logging.

import '../lib/dev-shim.js'; // dev-only chrome.* polyfill (inert in a real extension)
import * as store from '../lib/storage.js';
import { importTargets, toCSV } from '../lib/csv.js';
import { render, seedFrom } from '../lib/template.js';
import { startDevReload } from '../lib/dev-reload.js'; // dev-only; no-op in harness & Web Store builds
import { ensureTestSeed } from '../lib/dev-seed.js'; // dev-only: seeds the 3-account test campaign once

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayKey = () => new Date().toISOString().slice(0, 10);
const fmtTs = (ts) => new Date(ts).toLocaleString('ko-KR', { hour12: false });

const STATUS_LABEL = {
  pending: '대기',
  email_collected: '이메일수집',
  no_email: '이메일없음',
  sent: '발송완료',
  replied: '응답',
  second_sent: '2차발송',
  skipped: '스킵',
  failed: '실패',
};

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

let dmTabId = null;

// Promise helpers for chrome.tabs (cleaner than nested callbacks)
function pTabsQuery(opts) {
  return new Promise((res) => chrome.tabs.query(opts, (r) => res(r || [])));
}
function pTabsGet(id) {
  return new Promise((res) => chrome.tabs.get(id, (t) => res(t || null)));
}
function pTabsUpdate(id, props) {
  return new Promise((res) => chrome.tabs.update(id, props, (t) => res(t)));
}
function pWindowsFocus(winId) {
  return new Promise((res) => chrome.windows.update(winId, { focused: true }, () => res()));
}
function pTabsCreate(props) {
  return new Promise((res, rej) => chrome.tabs.create(props, (t) => {
    if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
    else res(t);
  }));
}

// Ensure we have an active Instagram tab and return its ID.
// Re-uses dmTabId cache. Prefers already-open IG tabs. No forced navigation to home between targets.
async function getOrCreateInstagramTab() {
  try {
    recordRunEvent('tab_probe', 'start', { cachedTabId: dmTabId ?? null });
    // 1. Current active tab is already IG?
    const active = await pTabsQuery({ active: true, currentWindow: true });
    const activeTab = active[0];
    if (activeTab && activeTab.url && activeTab.url.includes('instagram.com')) {
      dmTabId = activeTab.id;
      recordRunEvent('tab_selected', 'active_instagram_tab', { tabId: dmTabId, url: activeTab.url || null });
      return dmTabId;
    }

    // 2. Cached dmTabId still valid?
    if (dmTabId != null) {
      const cached = await pTabsGet(dmTabId);
      if (cached && cached.url && cached.url.includes('instagram.com')) {
        await pTabsUpdate(dmTabId, { active: true });
        if (cached.windowId) await pWindowsFocus(cached.windowId);
        recordRunEvent('tab_selected', 'cached_instagram_tab', { tabId: dmTabId, url: cached.url || null });
        return dmTabId;
      }
      recordRunEvent('tab_probe', 'cached_tab_invalid', { tabId: dmTabId, url: cached?.url || null });
    }

    // 3. Any existing IG tab in the browser?
    const igTabs = await pTabsQuery({ url: "*://*.instagram.com/*" });
    if (igTabs.length > 0) {
      const t = igTabs[0];
      dmTabId = t.id;
      await pTabsUpdate(dmTabId, { active: true });
      if (t.windowId) await pWindowsFocus(t.windowId);
      recordRunEvent('tab_selected', 'existing_instagram_tab', { tabId: dmTabId, url: t.url || null, tabCount: igTabs.length });
      return dmTabId;
    }

    // 4. Create fresh (root is fine as starting point; automation will drive from there)
    const newTab = await pTabsCreate({ url: 'https://www.instagram.com/', active: true });
    dmTabId = newTab?.id ?? null;
    recordRunEvent('tab_selected', 'created_instagram_tab', { tabId: dmTabId, url: newTab?.url || null });
    return dmTabId;
  } catch (e) {
    console.warn('getOrCreateInstagramTab error', e);
    recordRunEvent('tab_error', 'get_or_create_failed', { error: e && e.message ? e.message : String(e || 'unknown') });
    throw e;
  }
}

function openDM(handle) {
  getOrCreateInstagramTab();
}

// True only if the IG tab we were driving still exists. Used mid-loop so that if the
// user closes the IG tab we PAUSE instead of silently spawning a fresh one (which is
// exactly the wrong move under a soft block / when the user wanted to stop).
async function igTabAlive() {
  if (dmTabId == null) return false;
  const t = await pTabsGet(dmTabId);
  return !!(t && t.url && t.url.includes('instagram.com'));
}

// ── app state ────────────────────────────────────────────────────────────────
const state = {
  settings: {},
  campaigns: [],
  templates: [],
  campaignId: null,
  tab: 'targets',
  targets: [],
  isAutoSending: false,
  cooldownUntil: null,
  isCheckingReplies: false,
  isCollectingEmails: false,
  isProcessing: false, // unified flow (scrape → collect | follow+DM) per target
  lastRestrictionSignal: null,

  paceFactor: 1, // Runtime multiplier for pacing delays.
};

function extractRestrictionSignal(err) {
  const s = String(err || '');
  const emDash = s.match(/IG_NOTICE:[^\n]*?[—-]\s*([^\n]+)/i);
  if (emDash) return emDash[1].trim().slice(0, 180);
  const known = [
    'try again later', '나중에 다시 시도', '다시 시도해', 'please wait', '잠시 후 다시',
    'we limit how often', '일부 활동을 제한', '활동이 제한', 'temporarily restricted', '일시적으로 제한',
    'tried too often', 'suspicious', '수상한 활동', '비정상적인 활동', 'action blocked',
    '작업이 차단', 'restrict certain activity', 'couldn’t send', "couldn't send", '전송하지 못', '보낼 수 없',
  ];
  return known.find((p) => s.toLowerCase().includes(p.toLowerCase())) || s.slice(0, 180) || '서비스 알림 확인';
}

async function rememberRestrictionSignal(type, signal, phase) {
  const info = { type, signal: signal || '서비스 알림 확인', phase: phase || '', at: Date.now() };
  state.lastRestrictionSignal = info;
  await patchCampaign({ lastRestrictionSignal: info });
  return info;
}

async function stopForSoftSignal(reason, phase) {
  const signal = extractRestrictionSignal(reason);
  await rememberRestrictionSignal('soft_signal', signal, phase);
  recordPlatformNotice('soft_signal', signal);
  await startBlockCooldown(`${phase} 중 IG 서비스 알림이 확인되었습니다: ${signal}`);
}

async function stopForHardBlock(error, phase) {
  const signal = extractRestrictionSignal(error);
  await rememberRestrictionSignal('hard_block', signal, phase);
  recordPlatformNotice('hard_block', signal);
  await startBlockCooldown(`${phase} 중 IG 서비스 알림이 확인되었습니다: ${signal}`);
}

// Track E — session pacing. Work in 15–45m sessions; within a session do 3–5 actions
// then a short feed "딴짓" (1–2m); when the session is up take a real 5–20m rest, then
// start a fresh session. Layered on top of the existing batch cooldown.
const randInt = (a, b) => a + Math.floor(Math.random() * (Math.max(a, b) - Math.min(a, b) + 1));
function resetSession() { state.sessionEndAt = null; state.burstDone = 0; state.burstTarget = 0; }
async function pacedWait(ms, isActive) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isActive && !isActive()) return;
    await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(0, end - Date.now()))));
  }
}
async function sessionPace(isActive) {
  const s = state.settings;
  if (s.sessionPacing === false) return;
  if (!state.sessionEndAt) {
    let smin = s.sessionMinMin || 15, smax = s.sessionMaxMin || 45;
    // 11-12 — session length varies by time of day: mornings short, midday medium,
    // evenings long.
    if (s.timeOfDaySession !== false) {
      const h = new Date().getHours();
      if (h >= 6 && h < 10) { smin = 8; smax = 20; }
      else if (h >= 11 && h < 14) { smin = 15; smax = 35; }
      else if (h >= 19 && h < 23) { smin = 30; smax = 60; }
    }
    state.sessionEndAt = Date.now() + randInt(smin, smax) * 60000;
    state.burstTarget = randInt(s.burstMin || 3, s.burstMax || 5);
    state.burstDone = 0;
  }
  state.burstDone++;

  if (Date.now() >= state.sessionEndAt) {
    const restMin = randInt(s.restMinMin || 5, s.restMaxMin || 20);
    toast(`세션 종료 — ${restMin}분 휴식 후 새 세션을 시작합니다.`);
    try { chrome.runtime.sendMessage({ action: 'CDP_DETACH' }); } catch {} // clear debugger banner during the real break
    await pacedWait(restMin * 60000, isActive);
    resetSession();
    return;
  }
  if (state.burstDone >= state.burstTarget) {
    state.burstDone = 0;
    state.burstTarget = randInt(s.burstMin || 3, s.burstMax || 5);
    const tabId = await getOrCreateInstagramTab();
    if (tabId && (await waitForPing(tabId)) && (!isActive || isActive())) {
      toast('잠깐 딴짓 (피드 보는 중)...');
      await new Promise((r) => { try { chrome.tabs.sendMessage(tabId, { action: 'NATURAL_MODE', ms: randInt(60, 120) * 1000 }, () => r()); } catch { r(); } });
    }
  }
  await maybeIntentNoise(isActive);
  await maybeAttentionPause(isActive);
}

// 11-2 / 11-3 — occasionally "look away" without a real tab/window switch (which would
// need broader permissions): a longer 1–3m break, or a brief 0.8–3s glance away.
async function maybeAttentionPause(isActive) {
  if (state.settings.attentionPause === false) return;
  const r = Math.random();
  if (r < 0.1) {
    toast('잠시 다른 작업 보는 중...');
    await pacedWait(randInt(60, 180) * 1000, isActive);
  } else if (r < 0.25) {
    await pacedWait(randInt(800, 3000), isActive);
  }
}

async function postSendSettle(action, isActive, phase = 'send') {
  if (action !== 'sent' && action !== 'second_sent') return;
  const delayMs = randomDelay(6000, 18000) * (state.paceFactor || 1);
  recordRunEvent('post_send_settle', 'sent_before_next_target', { phase, delayMs });
  toast(`발송 확인 중... (${Math.round(delayMs / 1000)}초)`);
  await pacedWait(delayMs, isActive);
}

// X — occasional intentional-noise navigation so movement isn't 100% forward:
// 13% detour to explore + back, 5% history.back, 3% open search and close it.
async function maybeIntentNoise(isActive) {
  if (state.settings.backtrackEnabled === false) return;
  const r = Math.random();
  const kind = r < 0.13 ? 'unrelated' : r < 0.18 ? 'back' : r < 0.21 ? 'searchClose' : null;
  if (!kind) return;
  const tabId = await getOrCreateInstagramTab();
  if (tabId && (await waitForPing(tabId)) && (!isActive || isActive())) {
    toast('잠깐 딴 곳 둘러보는 중...');
    await new Promise((res) => { try { chrome.tabs.sendMessage(tabId, { action: 'INTENT_NOISE', kind }, () => res()); } catch { res(); } });
  }
}

// VIII/IX — talk to the SW rate governor (warm-up curve + hourly caps + circadian).
function rateCheck() { return new Promise((res) => { try { chrome.runtime.sendMessage({ action: 'RATE_CHECK' }, (r) => res(r || { allowed: true })); } catch { res({ allowed: true }); } }); }
function rateRecord() { try { chrome.runtime.sendMessage({ action: 'RATE_RECORD' }); } catch {} }
function rateReset() { try { chrome.runtime.sendMessage({ action: 'RATE_RESET' }); } catch {} }
// Block until the governor allows the next action: warm-up → feed browse, cap/circadian →
// wait. Returns false if the run was stopped while waiting.
async function rateGate(isActive) {
  for (;;) {
    if (isActive && !isActive()) return false;
    const r = await rateCheck();
    if (r.allowed) {
      recordRunEvent('rate_gate_pass', r.state || 'allowed');
      return true;
    }
    recordRunEvent('rate_gate_wait', r.reason || (r.warmup ? 'warmup' : 'unknown'), {
      waitMs: r.waitMs || null,
      warmup: !!r.warmup,
    });
    if (r.warmup) {
      toast('세션 warm-up — 피드 둘러보는 중...');
      const tabId = await getOrCreateInstagramTab();
      if (tabId && (await waitForPing(tabId)) && (!isActive || isActive())) {
        await new Promise((res) => { try { chrome.tabs.sendMessage(tabId, { action: 'NATURAL_MODE', ms: Math.min(120000, r.waitMs || 60000) }, () => res()); } catch { res(); } });
      } else {
        await pacedWait(Math.min(60000, r.waitMs || 60000), isActive);
      }
    } else {
      toast(`대기: ${r.reason} (~${Math.round((r.waitMs || 60000) / 60000)}분)`);
      await pacedWait(r.waitMs || 60000, isActive);
    }
  }
}

async function boot() {
  await ensureTestSeed(); // dev-only, one-time
  state.settings = await store.getSettings();
  state.campaigns = await store.listCampaigns();
  state.templates = await store.listTemplates();
  // Default to the seeded 발송 리스트 if present, so the user lands on their list (not an empty campaign).
  const seedCamp = state.campaigns.find((c) => c.id === 'test-fixed');
  state.campaignId = (seedCamp || state.campaigns[0])?.id ?? null;
  await reloadTargets();

  $('#campaignSel').addEventListener('change', async (e) => {
    state.campaignId = e.target.value || null;
    await reloadTargets();
    renderAll();
  });
  $('#newCampaign').addEventListener('click', onNewCampaign);
  $('#delCampaign').addEventListener('click', onDeleteCampaign);
  $$('#tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      renderAll();
    })
  );

  renderAll();
}

async function reloadTargets() {
  state.targets = state.campaignId ? await store.listTargets(state.campaignId) : [];
}

const currentCampaign = () => state.campaigns.find((c) => c.id === state.campaignId) || null;
const currentTemplate = () => {
  const c = currentCampaign();
  return state.templates.find((t) => t.id === c?.templateId) || null;
};
const varNames = () => state.settings.vars || ['name', 'category', 'followers', 'note'];
const maxLen = () => state.settings.maxLen || 900;

function statusCounts() {
  // Seed every known status so display code can index without falsy fallbacks.
  const counts = Object.fromEntries(Object.keys(STATUS_LABEL).map((k) => [k, 0]));
  for (const t of state.targets) counts[t.status] = (counts[t.status] || 0) + 1;
  return counts;
}

function inferFailedRetryStatus(t) {
  if (t.retryStatus === 'pending' || t.retryStatus === 'no_email') return t.retryStatus;
  const reason = String(t.emailReason || t.lastFailureReason || '');
  if (reason.includes('발송 실패') || reason.includes('send_failed')) return 'no_email';
  return 'pending';
}

async function requeueFailedTargets() {
  const failed = state.targets.filter((t) => t.status === 'failed');
  let pending = 0;
  let noEmail = 0;
  for (const t of failed) {
    const retryStatus = inferFailedRetryStatus(t);
    if (retryStatus === 'no_email') noEmail++;
    else pending++;
    await store.updateTarget(t.id, {
      status: retryStatus,
      retryStatus: null,
      failedAt: null,
      lastFailureReason: t.emailReason || t.lastFailureReason || '',
      emailReason: null,
      ...(retryStatus === 'pending' ? { email: null, emailConfidence: null } : {}),
    });
  }
  recordRunEvent('retry_queue_prepared', 'failed_targets', { total: failed.length, pending, noEmail });
  return { total: failed.length, pending, noEmail };
}

// ── campaign actions ─────────────────────────────────────────────────────────
async function onNewCampaign() {
  const name = prompt('새 캠페인 이름:', `캠페인 ${state.campaigns.length + 1}`);
  if (name == null) return;
  const c = {
    id: store.uid(),
    name: name.trim() || '새 캠페인',
    cap: state.settings.defaultCap || 250,
    templateId: state.templates[0]?.id || null,
    status: 'active',
    createdAt: Date.now(),
  };
  await store.saveCampaign(c);
  state.campaigns = await store.listCampaigns();
  state.campaignId = c.id;
  await reloadTargets();
  renderAll();
  toast('캠페인 생성됨');
}

async function onDeleteCampaign() {
  const c = currentCampaign();
  if (!c) return;
  if (!confirm(`"${c.name}" 캠페인과 대상·로그를 모두 삭제할까요?`)) return;
  await store.deleteCampaign(c.id);
  state.campaigns = await store.listCampaigns();
  state.campaignId = state.campaigns[0]?.id ?? null;
  await reloadTargets();
  renderAll();
  toast('삭제됨');
}

async function patchCampaign(patch) {
  const c = currentCampaign();
  if (!c) return;
  Object.assign(c, patch);
  await store.saveCampaign(c);
  state.campaigns = await store.listCampaigns();
}

// ── Service notice cooldown (persisted on the campaign so it survives panel reloads) ──
function isBlockedNow() {
  const c = currentCampaign();
  return !!(c && c.cooldownUntil && c.cooldownUntil > Date.now());
}
function blockedMsg() {
  const c = currentCampaign();
  const mins = c && c.cooldownUntil ? Math.ceil((c.cooldownUntil - Date.now()) / 60000) : 0;
  const signal = currentRestrictionSignal()?.signal;
  return `IG 세션 휴식 중 — 약 ${mins}분 후 다시 시도하세요.${signal ? ` 알림: ${signal}` : ''}`;
}
function currentRestrictionSignal() {
  const c = currentCampaign();
  return state.lastRestrictionSignal || c?.lastRestrictionSignal || null;
}
function renderRestrictionBanner() {
  const info = currentRestrictionSignal();
  if (!info || !info.signal) return '';
  const c = currentCampaign();
  const cooldownLeft = c?.cooldownUntil && c.cooldownUntil > Date.now()
    ? ` · 남은 휴식 약 ${Math.ceil((c.cooldownUntil - Date.now()) / 60000)}분`
    : '';
  const label = info.type === 'hard_block' ? '서비스 알림' : info.type === 'soft_signal' ? '세션 알림' : '알림';
  const phase = info.phase ? ` · 단계 ${esc(info.phase)}` : '';
  const at = info.at ? ` · ${esc(fmtTs(info.at))}` : '';
  return `<div class="banner warn" style="margin-bottom:10px;">
    <b>IG ${label}</b>${phase}${at}${cooldownLeft}<br/>
    <span class="hint">알림 문구: <code>${esc(info.signal)}</code></span>
  </div>`;
}
// Escalating backoff: 30m → 2h → 24h on repeat blocks within a campaign.
async function startBlockCooldown(reason) {
  const c = currentCampaign();
  const strikes = (c?.blockStrikes || 0) + 1;
  const minutes = strikes >= 3 ? 24 * 60 : strikes === 2 ? 2 * 60 : 30;
  state.cooldownUntil = Date.now() + minutes * 60 * 1000;
  await patchCampaign({ cooldownUntil: state.cooldownUntil, blockStrikes: strikes });
  const label = minutes >= 60 ? `${minutes / 60}시간` : `${minutes}분`;
  toast(`${reason} ${label} 휴식합니다. (연속 알림 ${strikes}회)`);
}

// ── top-level render ─────────────────────────────────────────────────────────
function renderAll() {
  renderHeader();
  const body = $('#body');
  if (!state.campaignId) {
    body.innerHTML = `<div class="empty">캠페인이 없습니다.<br/>상단 <b>＋</b> 로 새 캠페인을 만드세요.</div>`;
    return;
  }
  ({ targets: renderTargets, run: renderRun, results: renderResults }[
    state.tab
  ] || renderTargets)();
}

function renderHeader() {
  const sel = $('#campaignSel');
  sel.innerHTML = state.campaigns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (state.campaignId) sel.value = state.campaignId;

  const c = currentCampaign();
  const meta = $('#campaignMeta');
  if (c) {
    const counts = statusCounts();
    meta.textContent = `${c.senderHandle ? '발신 @' + c.senderHandle + ' · ' : ''}대상 ${state.targets.length}명`;
  } else {
    meta.textContent = '';
  }
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
}

// ── tab: 대상 ────────────────────────────────────────────────────────────────
function renderTargets() {
  const c = currentCampaign();
  const counts = statusCounts();
  const body = $('#body');
  body.innerHTML = `
    <h3>대상 리스트</h3>
    <label>핸들 붙여넣기 (한 줄에 하나) 또는 CSV 붙여넣기</label>
    <textarea id="pasteBox" placeholder="@handle_1&#10;handle_2&#10;https://instagram.com/handle_3&#10;&#10;또는 CSV:&#10;handle,name,category,followers&#10;handle_4,지수,뷰티,12000"></textarea>
    <div class="row" style="margin-top:6px;">
      <button class="primary" id="importPaste">가져오기</button>
      <label class="grow" style="margin:0;">
        <input type="file" id="csvFile" accept=".csv,text/csv" style="display:none;" />
        <button class="ghost" id="csvBtn">CSV 파일…</button>
      </label>
    </div>
    <p class="hint">중복 핸들은 자동 제거됩니다. CSV의 추가 컬럼은 개인화 변수로 저장됩니다.</p>

    <div class="row" style="margin-top:6px;">
      <label style="margin:0;white-space:nowrap;">발신 계정 @</label>
      <input type="text" id="senderInput" value="${esc(c.senderHandle || '')}" placeholder="0big__oioi" class="grow" />
    </div>
    ${
      state.targets.length
        ? `<table style="margin-top:10px;"><tbody>${state.targets
              .map(
                (t) => `<tr>
                  <td style="font-weight:600;">@${esc(t.handle)}</td>
                  <td style="text-align:right; white-space:nowrap;"><span class="pill s-${t.status}">${STATUS_LABEL[t.status]}</span></td>
                  <td style="width:22px;"><button class="sm ghost" data-del="${t.id}" title="삭제">✕</button></td>
                </tr>`
              )
              .join('')}</tbody>
          </table>`
        : `<div class="empty">아직 대상이 없습니다. 위에 핸들을 붙여넣고 "가져오기"를 누르세요.</div>`
    }

    <h3 style="margin-top:18px;">메시지</h3>
    <textarea id="msgBody" style="min-height:120px;" placeholder="안녕하세요 {{handle}}님! 협찬 제안드려요 :)">${esc((currentTemplate()?.body) || '')}</textarea>
    <div class="row" style="justify-content:space-between; align-items:center;">
      <span class="hint">변수 <code>{{handle}}</code> · <code>{{context}}</code>(발송 시 자동) · 변형 <code>{a|b}</code></span>
      <button class="primary sm" id="msgSave">메시지 저장</button>
    </div>
    <div class="card preview" id="msgPreview" style="margin-top:6px;"></div>

    <details style="margin-top:18px;">
      <summary class="hint" style="cursor:pointer;">⚙ 캠페인 설정 (상한 · 전체 삭제)</summary>
      <div class="row" style="margin-top:8px;">
        <label style="margin:0;">캠페인 상한</label>
        <input type="number" id="capInput" min="1" value="${c.cap}" style="width:90px;" />
        <span class="grow"></span>
        <button class="sm ghost" id="clearTargets">전체 대상 삭제</button>
      </div>
    </details>
  `;

  const msgBody = $('#msgBody');
  const renderMsgPreview = () => {
    if (!msgBody) return;
    const sample = state.targets[0] || { handle: 'sample_user', vars: {} };
    const pv = render(msgBody.value, { handle: sample.handle, ...sample.vars }, seedFrom(sample.handle));
    $('#msgPreview').textContent = pv.text;
  };
  if (msgBody) { msgBody.addEventListener('input', renderMsgPreview); renderMsgPreview(); }
  $('#msgSave')?.addEventListener('click', async () => {
    const bodyTxt = (msgBody?.value || '').trim();
    if (!bodyTxt) return toast('메시지를 입력하세요');
    let tpl = currentTemplate();
    tpl = tpl ? { ...tpl, body: bodyTxt } : { id: store.uid(), name: '메시지', body: bodyTxt };
    await store.saveTemplate(tpl);
    state.templates = await store.listTemplates();
    const c2 = currentCampaign();
    if (c2 && c2.templateId !== tpl.id) await patchCampaign({ templateId: tpl.id });
    toast('메시지 저장됨');
  });

  $('#importPaste').addEventListener('click', async () => {
    const parsed = importTargets($('#pasteBox').value);
    if (!parsed.length) return toast('유효한 핸들을 찾지 못했습니다');
    const { added, dup } = await store.upsertTargets(state.campaignId, parsed);
    await reloadTargets();
    renderAll();
    toast(`추가 ${added} · 중복 ${dup}`);
  });
  $('#csvBtn').addEventListener('click', () => $('#csvFile').click());
  $('#csvFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const parsed = importTargets(text);
    if (!parsed.length) return toast('CSV에서 핸들을 찾지 못했습니다');
    const { added, dup } = await store.upsertTargets(state.campaignId, parsed);
    await reloadTargets();
    renderAll();
    toast(`추가 ${added} · 중복 ${dup}`);
  });
  $('#capInput').addEventListener('change', async (e) => {
    const v = Math.max(1, parseInt(e.target.value, 10) || 1);
    await patchCampaign({ cap: v });
    renderHeader();
  });
  $('#senderInput').addEventListener('change', async (e) => {
    await patchCampaign({ senderHandle: e.target.value.replace(/^@+/, '').trim() });
    renderHeader();
  });
  $('#clearTargets').addEventListener('click', async () => {
    if (!confirm('이 캠페인의 모든 대상을 삭제할까요?')) return;
    await store.clearTargets(state.campaignId);
    await reloadTargets();
    renderAll();
  });
  $$('[data-del]', body).forEach((b) =>
    b.addEventListener('click', async () => {
      await store.deleteTarget(b.dataset.del);
      await reloadTargets();
      renderAll();
    })
  );
}

// ── tab: 템플릿 ──────────────────────────────────────────────────────────────
function renderTemplate() {
  const c = currentCampaign();
  const tpl = currentTemplate();
  const body = $('#body');
  const sample = state.targets[0] || { handle: 'sample_user', vars: { name: '지수', category: '뷰티', followers: '12000' } };
  const preview = tpl ? render(tpl.body, { handle: sample.handle, ...sample.vars }, seedFrom(sample.handle)) : null;

  body.innerHTML = `
    <h3>협찬 메시지 템플릿</h3>
    <div class="row">
      <select id="tplSel" class="grow">
        <option value="">— 템플릿 선택 —</option>
        ${state.templates.map((t) => `<option value="${t.id}" ${t.id === tpl?.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
      <button class="sm" id="tplNew">새로</button>
      <button class="sm ghost" id="tplDel" ${tpl ? '' : 'disabled'}>삭제</button>
    </div>

    <label>템플릿 이름</label>
    <input type="text" id="tplName" value="${esc(tpl?.name || '')}" placeholder="예: 6월 뷰티 시딩 1차" />

    <label>본문</label>
    <textarea id="tplBody" style="min-height:150px;" placeholder="안녕하세요 {{name}}님! ...">${esc(tpl?.body || '')}</textarea>
    <div class="row" style="justify-content:space-between;">
      <div class="chips" id="varChips">
        <span class="chip" data-ins="{{handle}}">{{handle}}</span>
        ${varNames().map((v) => `<span class="chip" data-ins="{{${v}}}">{{${v}}}</span>`).join('')}
        <span class="chip" data-ins="{{context}}" title="발송 시 프로필에서 자동 추출됩니다 (예: 바이오 해시태그)">{{context}}</span>
      </div>
      <span id="lenCount" class="hint"></span>
    </div>
    <p class="hint">변수: 칩을 눌러 삽입. 변형 문구는 <code>{안녕하세요|반가워요}</code> 형식(대상별로 다른 변형이 안정적으로 선택됨). <b>{{context}}</b>는 발송 시 프로필에서 자동 채워지며, 찾지 못하면 해당 줄이 자연스럽게 제거됩니다 (자연화 설정에서 끌 수 있음).</p>

    <h4>협찬 제안 체크리스트</h4>
    <div class="chips">
      ${['브랜드 소개', '제안 내용', '보상(협찬/금전)', 'CTA', '연락 방법']
        .map((x) => `<span class="chip">${x}</span>`)
        .join('')}
    </div>

    <h4>미리보기 (${esc(sample.handle)})</h4>
    <div class="card preview">${preview ? esc(preview.text) : '<span class="hint">템플릿을 선택하거나 작성하세요.</span>'}</div>

    <button class="primary" id="tplSave" style="margin-top:6px;">저장 ${tpl ? '' : '(새 템플릿)'}</button>
    ${tpl ? `<p class="hint">이 캠페인은 위 템플릿(<b>${esc(tpl.name)}</b>)을 사용합니다.</p>` : ''}
  `;

  const bodyEl = $('#tplBody');
  const updateLen = () => {
    const len = [...bodyEl.value].length;
    const over = len > maxLen();
    $('#lenCount').innerHTML = `<span class="${over ? 'flag-bad' : 'count-ok'}">${len} / ${maxLen()}</span>`;
  };
  updateLen();
  bodyEl.addEventListener('input', updateLen);

  $$('#varChips .chip', body).forEach((chip) =>
    chip.addEventListener('click', () => {
      const ins = chip.dataset.ins;
      if (!ins) return;
      const start = bodyEl.selectionStart;
      const end = bodyEl.selectionEnd;
      bodyEl.value = bodyEl.value.slice(0, start) + ins + bodyEl.value.slice(end);
      bodyEl.focus();
      bodyEl.selectionStart = bodyEl.selectionEnd = start + ins.length;
      updateLen();
    })
  );

  $('#tplSel').addEventListener('change', async (e) => {
    await patchCampaign({ templateId: e.target.value || null });
    renderAll();
  });
  $('#tplNew').addEventListener('click', () => {
    $('#tplName').value = '';
    bodyEl.value = '';
    updateLen();
    $('#tplName').focus();
  });
  $('#tplDel').addEventListener('click', async () => {
    if (!tpl || !confirm(`템플릿 "${tpl.name}" 삭제?`)) return;
    await store.deleteTemplate(tpl.id);
    state.templates = await store.listTemplates();
    if (currentCampaign()?.templateId === tpl.id) await patchCampaign({ templateId: null });
    renderAll();
  });
  $('#tplSave').addEventListener('click', async () => {
    const name = $('#tplName').value.trim();
    const bodyText = bodyEl.value;
    if (!name) return toast('이름을 입력하세요');
    if (!bodyText.trim()) return toast('본문을 입력하세요');
    const t = tpl
      ? { ...tpl, name, body: bodyText }
      : { id: store.uid(), name, body: bodyText };
    await store.saveTemplate(t);
    state.templates = await store.listTemplates();
    await patchCampaign({ templateId: t.id });
    renderAll();
    toast('저장됨');
  });
}

// ── tab: 검토 (bulk preview) ────────────────────────────────────────────────
function renderReview() {
  const tpl = currentTemplate();
  const body = $('#body');
  if (!tpl) {
    body.innerHTML = `<div class="empty">먼저 <b>템플릿</b> 탭에서 메시지를 작성/선택하세요.</div>`;
    return;
  }
  const rows = state.targets.map((t) => {
    const r = render(tpl.body, { handle: t.handle, ...t.vars }, seedFrom(t.handle));
    return { t, r };
  });
  const missingCount = rows.filter((x) => x.r.missing.length).length;
  const overCount = rows.filter((x) => x.r.length > maxLen()).length;

  body.innerHTML = `
    <h3>발송 전 일괄 검토</h3>
    <div class="stat">
      <span>대상 ${rows.length}</span>
      <span class="${missingCount ? 'flag-warn' : ''}">변수 누락 ${missingCount}</span>
      <span class="${overCount ? 'flag-bad' : ''}">길이 초과 ${overCount}</span>
    </div>
    ${missingCount ? `<div class="banner warn">변수 누락 대상은 메시지에 {{변수}}가 그대로 노출됩니다. 대상 탭에서 값을 채우거나 템플릿을 조정하세요.</div>` : ''}
    <div class="row" style="margin:6px 0;">
      <button class="sm ghost" id="exportPreview">미리보기 CSV 내보내기</button>
    </div>
    <table>
      <thead><tr><th>핸들</th><th>최종 문구</th><th>길이</th></tr></thead>
      <tbody>
        ${rows
          .map(
            ({ t, r }) => `<tr>
              <td>@${esc(t.handle)}<br/><span class="pill s-${t.status}">${STATUS_LABEL[t.status]}</span></td>
              <td class="msg">${esc(r.text)}${r.missing.length ? `<br/><span class="flag-warn">⚠ 누락: ${esc(r.missing.join(', '))}</span>` : ''}</td>
              <td class="${r.length > maxLen() ? 'flag-bad' : ''}">${r.length}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;

  $('#exportPreview').addEventListener('click', () => {
    const data = rows.map(({ t, r }) => ({
      handle: t.handle,
      status: t.status,
      message: r.text,
      length: r.length,
      missing: r.missing.join(' '),
    }));
    downloadCSV(`preview_${currentCampaign().name}.csv`, ['handle', 'status', 'message', 'length', 'missing'], data);
  });
}

// ── tab: 발송 ───────────────────────────────────────────────────────────────
// ── tab: 수집 (collected emails) ───────────────────────────────────────────────
// Surfaces the email-collection results (handle / email / confidence / 수집일시 /
// campaign) that previously only existed in the web dashboard. Reads straight from
// the in-memory targets (chrome.storage.local), no IG tab needed.
function emailRow(t) {
  return `<tr>
    <td>@${esc(t.handle)}</td>
    <td style="font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;">${esc(t.email || '')}</td>
    <td>${esc(t.emailConfidence || '')}</td>
    <td>${t.emailReason ? esc(t.emailReason) : ''}</td>
    <td>${t.updatedAt ? esc(fmtTs(t.updatedAt)) : ''}</td>
  </tr>`;
}

function renderEmails() {
  const c = currentCampaign();
  const body = $('#body');
  const collected = state.targets
    .filter((t) => t.status === 'email_collected' && t.email)
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const noEmail = state.targets.filter((t) => t.status === 'no_email').length;
  const pending = state.targets.filter((t) => t.status === 'pending').length;

  body.innerHTML = `
    <h3>수집 이메일</h3>
    <p class="hint" style="margin-top:0;">대상 바이오에서 추출해 저장한 연락 이메일입니다. 이메일이 있는 대상은 DM이 아니라 이메일 아웃리치 명단으로 내보내세요. (수집은 <b>발송</b> 탭의 1단계에서 실행)</p>
    <div class="stat">
      <span>수집 ${collected.length}</span>
      <span>이메일없음→DM ${noEmail}</span>
      <span>미수집 ${pending}</span>
    </div>
    <div class="row" style="margin:6px 0; align-items:center;">
      <input type="search" id="emailSearch" placeholder="핸들·이메일 검색" class="grow" />
      <button class="sm primary" id="exportCollectedEmails" ${collected.length ? '' : 'disabled'}>이메일 CSV 내보내기</button>
    </div>
    ${
      collected.length
        ? `<table>
            <thead><tr><th>핸들</th><th>이메일</th><th>신뢰도</th><th>근거</th><th>수집</th></tr></thead>
            <tbody id="emailRows">${collected.map(emailRow).join('')}</tbody>
          </table>`
        : `<div class="empty">아직 수집된 이메일이 없습니다.<br/><b>발송</b> 탭에서 이메일 수집을 먼저 실행하세요.</div>`
    }
  `;

  const exportBtn = $('#exportCollectedEmails');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const rows = collected.map((t) => ({
        handle: t.handle,
        email: t.email || '',
        confidence: t.emailConfidence || '',
        reason: t.emailReason || '',
        collected_at: t.updatedAt ? new Date(t.updatedAt).toISOString() : '',
      }));
      downloadCSV(`emails_${c.name}.csv`, ['handle', 'email', 'confidence', 'reason', 'collected_at'], rows);
    });
  }

  const search = $('#emailSearch');
  if (search) {
    search.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const filtered = q
        ? collected.filter((t) => (t.handle || '').toLowerCase().includes(q) || (t.email || '').toLowerCase().includes(q))
        : collected;
      const tb = $('#emailRows');
      if (tb) tb.innerHTML = filtered.map(emailRow).join('');
    });
  }
}

// ── tab: 실행 (minimal) — 대상 리스트 중심 ─────────────────────────────────────
async function renderRun() {
  const body = $('#body');
  const c = currentCampaign();
  const counts = statusCounts();
  const sent = counts.sent;
  const collected = state.targets.filter((t) => t.status === 'email_collected').length;
  const dmQueue = state.targets.filter((t) => t.status === 'no_email').length;
  const pending = state.targets.filter((t) => t.status === 'pending').length;
  const failed = counts.failed || 0;
  const anyRunning = state.isProcessing || state.isCollectingEmails || state.isAutoSending || state.isCheckingReplies;
  const collecting = state.isCollectingEmails;
  const sending = state.isAutoSending;
  const capReached = sent >= c.cap;

  const statusLine = [
    pending ? `수집 대기 ${pending}` : '',
    `DM 대기 ${dmQueue}`,
    sent ? `발송 ${sent}` : '',
    collected ? `이메일 ${collected}` : '',
    failed ? `실패 ${failed}` : '',
  ].filter(Boolean).join(' · ');

  body.innerHTML = `
    <div class="actions" style="margin:2px 0 8px;">
      ${state.isProcessing
        ? `<button class="primary flag-bad" id="stopProcess">■ 중지</button>`
        : `<button class="primary" id="startProcess" ${pending === 0 ? 'disabled' : ''} title="대상마다: 이메일 있으면 수집, 없으면 DM (필요 시 팔로우 후)">▶ 시작 (수집·DM 자동)</button>`}
      <button class="sm ghost" id="retryFailedBtn" ${failed === 0 || anyRunning ? 'disabled' : ''} title="실패한 항목만 원래 단계의 재시도 큐로 되돌립니다.">실패 ${failed} 재시도 큐</button>
    </div>
    <p class="hint" style="margin:0 0 10px;">${statusLine}${state.isProcessing ? ' · <b>처리 중…</b>' : ''}</p>
    <p class="hint" style="margin:-4px 0 10px; font-size:11px;">대상마다 → 이메일 있으면 <b>수집</b>, 없으면 <b>DM</b> (메시지 버튼 없으면 팔로우 후 재시도)</p>

    ${renderRestrictionBanner()}
    ${state.cooldownUntil && state.cooldownUntil > Date.now()
      ? `<div class="banner warn" style="margin-bottom:10px;">휴식 중 — <span id="cooldownTimer">계산 중…</span></div>` : ''}

    <table><tbody>
      ${state.targets.length
        ? state.targets.map((t) => `<tr>
            <td style="font-weight:600;">@${esc(t.handle)}</td>
            ${t.email ? `<td class="hint" style="font-size:11px; font-family:ui-monospace,Menlo,monospace; word-break:break-all;">${esc(t.email)}</td>` : '<td></td>'}
            <td style="text-align:right; white-space:nowrap;"><span class="pill s-${t.status}">${STATUS_LABEL[t.status] || t.status}</span></td>
          </tr>`).join('')
        : `<tr><td class="empty">대상이 없습니다. <b>대상·메시지</b> 탭에서 추가하세요.</td></tr>`}
    </tbody></table>

    <div class="row" style="margin-top:16px; gap:6px; flex-wrap:wrap; align-items:center;">
      <button class="sm ghost" id="exportTracesBtn" title="실행 전 차단/탭 선택/ping/명령/DOM trace를 JSON으로 내보냅니다 — 문제 분석용.">🧪 트레이스</button>
      <button class="sm ghost" id="resetTestBtn" title="대상을 모두 pending으로 되돌립니다 (재테스트).">🔁 리셋</button>
      <button class="sm ghost" id="dumpIgStateBtn" title="IG 페이지 상태를 콘솔에 덤프합니다.">디버그 덤프</button>
      <span class="grow"></span>
      <button class="sm ghost" id="openOptionsBtn" title="모션학습·대시보드·고급 설정">⚙ 고급(옵션)</button>
    </div>
  `;

  $('#openOptionsBtn')?.addEventListener('click', () => { try { chrome.runtime.openOptionsPage(); } catch {} });
}

// ── tab: 결과 (수집 이메일 + 발송 로그) ─────────────────────────────────────────
async function renderResults() {
  const body = $('#body');
  const c = currentCampaign();
  const collected = state.targets
    .filter((t) => t.status === 'email_collected' && t.email)
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const noEmail = state.targets.filter((t) => t.status === 'no_email').length;
  const logs = (await store.listLogs(state.campaignId)).slice().reverse();
  const counts = statusCounts();

  body.innerHTML = `
    <h3>수집 이메일 (${collected.length})</h3>
    <div class="row" style="margin:4px 0; align-items:center;">
      <button class="sm primary" id="exportEmails" ${collected.length ? '' : 'disabled'}>이메일 CSV</button>
      <span class="hint" style="margin-left:8px;">이메일없음→DM ${noEmail}</span>
    </div>
    ${collected.length
      ? `<table><thead><tr><th>핸들</th><th>이메일</th><th>신뢰도</th><th>근거</th><th>수집</th></tr></thead><tbody>${collected.map(emailRow).join('')}</tbody></table>`
      : `<div class="empty">아직 수집된 이메일이 없습니다. <b>실행</b> 탭에서 이메일 수집을 먼저 돌리세요.</div>`}

    <h3 style="margin-top:20px;">발송 로그</h3>
    <div class="stat"><span>발송 ${counts.sent}</span><span>응답 ${counts.replied}</span><span>스킵 ${counts.skipped}</span><span>실패 ${counts.failed}</span></div>
    <div class="row" style="margin:4px 0;"><button class="sm ghost" id="exportLog" ${logs.length ? '' : 'disabled'}>로그 CSV</button></div>
    ${logs.length
      ? `<table><thead><tr><th>시각</th><th>핸들</th><th>결과</th></tr></thead><tbody>${logs.slice(0, 100)
          .map((l) => `<tr><td class="ts">${esc(fmtTs(l.ts))}</td><td>@${esc(l.targetHandle || '')}</td><td><span class="pill s-${l.result}">${STATUS_LABEL[l.result] || l.result}</span></td></tr>`)
          .join('')}</tbody></table>${logs.length > 100 ? `<p class="hint">…외 ${logs.length - 100}건</p>` : ''}`
      : `<div class="empty">아직 발송 기록이 없습니다.</div>`}
  `;

  // #exportEmails is handled by the document-level click handler (exportEmailsBtn branch).
  $('#exportLog')?.addEventListener('click', () => {
    const data = logs.map((l) => ({ ts: new Date(l.ts).toISOString(), handle: l.targetHandle || '', result: l.result, message: l.finalText || '' }));
    downloadCSV(`log_${c.name}.csv`, ['ts', 'handle', 'result', 'message'], data);
  });
}

async function renderSend() {
  const tpl = currentTemplate();
  const body = $('#body');
  if (!tpl) {
    body.innerHTML = `<div class="empty">먼저 <b>템플릿</b> 탭에서 메시지를 작성/선택하세요.</div>`;
    return;
  }

  const logs = await store.listLogs(state.campaignId);
  const sentToday = logs.filter((l) => l.result === 'sent' && new Date(l.ts).toISOString().slice(0, 10) === todayKey()).length;
  const dailyTarget = state.settings.dailyTarget || 40;
  const motionLib = await new Promise((r) => chrome.storage.local.get('motionLib', (o) => {
    const m = (o && o.motionLib) || {};
    r({ gestures: m.gestures || [], keyIntervals: m.keyIntervals || [], scrolls: m.scrolls || [], clickOffsets: m.clickOffsets || [] });
  }));
  const learnOn = state.settings.motionLearn !== false;
  const syncState = await new Promise((r) => chrome.storage.local.get('syncState', (o) => r((o && o.syncState) || null)));

  const counts = statusCounts();
  // DM queue = ONLY scraped-but-no-email targets. We force collect-first so the
  // whole point of the feature (DM only people whose bio has no contact email)
  // can't be bypassed by starting bulk send before collection finishes.
  const queue = state.targets.filter((t) => t.status === 'no_email');
  const c = currentCampaign();
  const capReached = counts.sent >= c.cap;
  const next = queue[0];

  const emailCollectedCount = state.targets.filter((t) => t.status === 'email_collected').length;
  const noEmailCount = state.targets.filter((t) => t.status === 'no_email').length;
  const notScrapedCount = state.targets.filter((t) => t.status === 'pending').length;

  body.innerHTML = `
    <h3>발송 실행</h3>
    ${c.senderHandle ? `<div class="banner warn">발신 계정 <b>@${esc(c.senderHandle)}</b> — 인스타그램에 이 계정으로 로그인돼 있는지 먼저 확인하세요.</div>` : ''}
    <div class="banner info">
      이 도구는 인스타그램 웹에서 <b>메시지 입력 및 전송 흐름</b>을 실행합니다.
      설정된 배치 크기와 딜레이 값을 사용해 전체 대기열을 순차적으로 처리할 수 있습니다.
      <br/><span class="hint">발송/수집 중 IG 탭 상단에 <b>"확장이 디버깅 중"</b> 배너가 뜨면 정상입니다 — 실제 사람 입력(trusted)을 위해 <code>chrome.debugger</code>를 사용하며, 멈추거나 30초 유휴 시 자동 해제됩니다.</span>
    </div>
    ${renderRestrictionBanner()}
    <div class="row" style="margin:4px 0 8px;">
      <button class="sm ghost" id="dumpIgStateBtn" title="IG 탭의 현재 DOM 상태를 콘솔에 덤프합니다. 실행이 멈췄을 때 눌러서 로그를 복사해 주세요.">IG 페이지 상태 덤프 (디버그)</button>
      <button class="sm ghost" id="exportTracesBtn" title="실행 전 차단/탭 선택/ping/명령/DOM trace를 JSON으로 내보냅니다 — 문제 분석/수정용.">🧪 트레이스 내보내기</button>
      <button class="sm ghost" id="clearTracesBtn" title="저장된 trace 초기화">trace 비우기</button>
      <button class="sm ghost" id="resetTestBtn" title="현재 캠페인 대상을 모두 pending으로 되돌립니다 (재테스트용).">🔁 대상 리셋</button>
      <button class="sm ghost" id="retryFailedBtn" ${counts.failed === 0 || state.isProcessing || state.isCollectingEmails || state.isAutoSending || state.isCheckingReplies ? 'disabled' : ''} title="실패한 항목만 원래 단계의 재시도 큐로 되돌립니다.">실패 ${counts.failed} 재시도 큐</button>
    </div>
    <div class="row" style="margin:4px 0 8px; align-items:center;">
      <span class="hint" style="margin:0;">🧠 모션 학습: 제스처 <b>${motionLib.gestures.length}</b> · 타이핑 <b>${motionLib.keyIntervals.length}</b> · 스크롤 <b>${motionLib.scrolls.length}</b> · 클릭버릇 <b>${motionLib.clickOffsets.length}</b> ${motionLib.gestures.length < 8 ? '<span class="flag-warn">(IG를 평소처럼 좀 써서 사람 움직임을 더 학습시키세요)</span>' : '<span class="count-ok">충분</span>'}</span>
      <span class="grow"></span>
      <button class="sm ${learnOn ? '' : 'ghost'}" id="toggleMotionLearn" title="켜두면 사장님이 IG를 쓰는 실제 마우스/타이핑을 학습해, 발송 시 그 움직임을 재생합니다.">학습 ${learnOn ? '켜짐' : '꺼짐'}</button>
    </div>
    <div class="row" style="margin:4px 0 8px; align-items:center;">
      <span class="hint" style="margin:0;">☁️ 대시보드 동기화: ${
        syncState
          ? syncState.ok
            ? `<span class="count-ok">완료</span> 대상 <b>${syncState.counts?.targets ?? 0}</b> · ${new Date(syncState.lastAt).toLocaleTimeString('ko-KR')}`
            : `<span class="flag-bad">오류</span> <span class="hint">${esc(syncState.error || '')}</span>`
          : '<span class="hint">대기 (변경 시 자동 동기화)</span>'
      }</span>
      <span class="grow"></span>
      <button class="sm ghost" id="openDashboardBtn" title="고객/이메일 관리 웹 대시보드를 엽니다.">대시보드 열기</button>
      <button class="sm" id="syncNowBtn" title="지금 즉시 Supabase로 동기화합니다.">지금 동기화</button>
    </div>
    <div class="card" style="margin-bottom:12px; background:#f4f6fa; border:1px solid #dcdfe6;">
      <h4 style="margin:0 0 8px;">📧 1단계 · 이메일 수집</h4>
      <p class="hint" style="margin-top:0;">대상 프로필의 바이오 <b>'더보기'</b>를 펼쳐 이메일을 추출합니다. 이메일이 있으면 <b>저장</b>하고, 없는 대상은 <b>DM 버킷</b>으로 분류합니다.</p>
      <div class="stat">
        <span>수집됨 ${emailCollectedCount}</span>
        <span>이메일없음→DM ${noEmailCount}</span>
        <span>미수집 ${notScrapedCount}</span>
      </div>
      <div class="actions">
        ${state.isCollectingEmails
          ? `<button class="primary flag-bad" id="stopCollectEmails">이메일 수집 중지</button>`
          : `<button class="primary" id="startCollectEmails" ${notScrapedCount === 0 ? 'disabled' : ''}>이메일 수집 시작 🚀</button>`}
        <button class="sm ghost" id="exportEmails" ${emailCollectedCount === 0 ? 'disabled' : ''}>수집 이메일 CSV</button>
      </div>
      ${state.isCollectingEmails ? `<p class="hint" style="margin-top:8px;">프로필을 순차 방문해 바이오를 펼치고 이메일을 추출 중입니다... (랜덤 딜레이 적용)</p>` : ''}
    </div>

    <h4 style="margin:6px 0;">2단계 · DM 발송 (이메일 없는 대상)</h4>
    <div class="stat">
      <span>진행 ${counts.sent} / ${c.cap}</span>
      <span>남은 대기 ${queue.length}</span>
      <span class="${sentToday >= dailyTarget ? 'flag-warn' : ''}">오늘 ${sentToday} / 목표 ${dailyTarget}</span>
    </div>
    ${
      sentToday >= dailyTarget
        ? `<div class="banner warn">오늘 목표(${dailyTarget})에 도달했습니다. 계정 보호를 위해 여기서 멈추는 걸 권합니다. (강제 아님 — 직접 판단하세요.)</div>`
        : ''
    }
    ${
      capReached
        ? `<div class="empty">캠페인 상한 ${c.cap}에 도달했습니다. 🎉</div>`
        : `<div class="card">
             <div class="actions">
               ${state.isAutoSending
                 ? `<button class="primary flag-bad" id="stopAutoSend">전체 자동 발송 중지 (현재 작업/휴식 후 정지)</button>`
                 : `<button class="primary" id="startBulkAutoSend" ${queue.length === 0 || notScrapedCount > 0 ? 'disabled' : ''} title="${notScrapedCount > 0 ? '이메일 수집을 먼저 끝내야 DM을 보낼 수 있습니다 (미수집 ' + notScrapedCount + '명)' : ''}">대기열 스마트 배치 발송 시작 🚀</button>`
               }
               <span class="hint" style="margin-left:8px;font-size:11px;">${notScrapedCount > 0 ? `<b class="flag-warn">미수집 ${notScrapedCount}명 — 1단계 이메일 수집을 먼저 끝내세요.</b>` : '(배치 N건 후 휴식 + 대상 간 랜덤 지터 적용)'}</span>
             </div>
             ${state.cooldownUntil && state.cooldownUntil > Date.now()
                 ? `<div class="banner warn" style="margin-top:8px;">
                      <b>휴식 모드 작동 중</b><br/>세션 페이싱에 따라 대기 중입니다.<br/>
                      <span id="cooldownTimer">남은 시간 계산 중...</span>
                    </div>`
                 : state.isAutoSending
                   ? `<p class="hint" style="margin-top:8px;">자동 발송이 진행 중입니다... (발송 사이 랜덤 딜레이 적용)</p>`
                   : ''}
           </div>

           <div class="card" style="margin-top:12px; background:#f4f6fa; border:1px solid #dcdfe6;">
             <h4 style="margin:0 0 8px;">🔄 응답 확인 및 2차 링크 발송</h4>
             <p class="hint" style="margin-top:0;">'전송함(sent)' 상태인 대상들의 채팅창을 스캔하여, 답장이 왔다면 아래 템플릿을 전송합니다.</p>
             <label style="font-size:12px;">2차 발송용 템플릿 선택:</label>
             <select id="followUpTemplateId" style="width:100%; margin-bottom:8px; padding:4px;">
               ${state.templates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
             </select>
             <div class="actions">
               ${state.isCheckingReplies
                 ? `<button class="primary flag-bad" id="stopCheckReplies">확인 및 발송 중지</button>`
                 : `<button class="primary" id="startCheckReplies" ${counts.sent === 0 ? 'disabled' : ''}>응답 확인 및 2차 발송 시작 🚀</button>`
               }
             </div>
             ${state.isCheckingReplies ? `<p class="hint" style="margin-top:8px;">채팅창을 순차적으로 확인 중입니다... (랜덤 딜레이 적용)</p>` : ''}
           </div>

           ${next ? renderSendCard(next, tpl) : `<div class="empty">대기 중인 대상이 없습니다.</div>`}`
    }
    ${
      queue.length > 1
        ? `<h4>대기열 (${queue.length})</h4>
           <table><tbody>${queue
             .slice(1, 21)
             .map((t) => `<tr><td>@${esc(t.handle)}</td><td><button class="sm ghost" data-jump="${t.id}">건너뛰기</button></td></tr>`)
             .join('')}</tbody></table>
           ${queue.length > 21 ? `<p class="hint">…외 ${queue.length - 21}명</p>` : ''}`
        : ''
    }
  `;

  if (next) bindSendCard(next, tpl);
  $$('[data-jump]', body).forEach((b) =>
    b.addEventListener('click', async () => {
      await store.updateTarget(b.dataset.jump, { status: 'skipped' });
      await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: targetById(b.dataset.jump)?.handle, ts: Date.now(), finalText: '', result: 'skipped' });
      await reloadTargets();
      renderAll();
    })
  );
}

function targetById(id) {
  return state.targets.find((t) => t.id === id);
}

function renderSendCard(t, tpl) {
  const r = render(tpl.body, { handle: t.handle, ...t.vars }, seedFrom(t.handle));
  const over = r.length > maxLen();
  return `
    <div class="card" id="sendCard">
      <div class="handle">@${esc(t.handle)}</div>
      ${r.missing.length ? `<div class="banner warn">⚠ 변수 누락: ${esc(r.missing.join(', '))} — 메시지에 그대로 노출됩니다.</div>` : ''}
      <div class="preview">${esc(r.text)}</div>
      <div class="hint" style="margin-bottom:8px;">길이 <span class="${over ? 'flag-bad' : 'count-ok'}">${r.length} / ${maxLen()}</span></div>
      <div class="actions">
        <button class="primary" id="autoSendBtn">이 대상만 자동 발송 (테스트/개별)</button>
      </div>
      <div class="actions" style="margin-top:8px;">
        <button id="markSent">전송함 ✓ → 다음</button>
        <button id="markReplied">응답옴</button>
        <button class="ghost" id="markSkip">스킵</button>
        <button class="ghost" id="markFail">실패</button>
      </div>
    </div>
  `;
}

function bindSendCard(t, tpl) {
  const r = render(tpl.body, { handle: t.handle, ...t.vars }, seedFrom(t.handle));
  const advance = async (status, openNext = false) => {
    const patch = { status };
    if (status === 'failed') {
      Object.assign(patch, {
        retryStatus: t.status === 'no_email' ? 'no_email' : 'pending',
        failedAt: Date.now(),
        lastFailureReason: 'manual',
        emailReason: '수동 실패 표시',
      });
    }
    await store.updateTarget(t.id, patch);
    await store.addLog({
      id: store.uid(),
      campaignId: state.campaignId,
      targetHandle: t.handle,
      ts: Date.now(),
      finalText: status === 'sent' || status === 'replied' ? r.text : '',
      result: status,
    });
    await reloadTargets();
    const next = openNext ? state.targets.find((x) => x.status === 'pending') : null;
    renderAll();
    if (next) {
      const nr = render(tpl.body, { handle: next.handle, ...next.vars }, seedFrom(next.handle));
      await copyText(nr.text);
      openDM(next.handle);
      toast(`다음: @${next.handle} · 작성창 열림 · 복사됨`);
    } else {
      toast(STATUS_LABEL[status]);
    }
  };

  $('#autoSendBtn')?.addEventListener('click', async () => {
    const res = await sendSingleTarget(t, r, tpl);
    if (!res.ok) {
      if (res.errorCode === 'service_notice') {
        await stopForHardBlock(res.error, '개별 발송');
      } else if (res.quality) {
        toast('발송 전 차단: ' + (res.error || '메시지 품질 확인 필요'));
      } else if (res.errorCode === 'no_dm') {
        await store.updateTarget(t.id, { status: 'skipped', emailReason: 'DM 버튼 없음/본인 계정' });
      } else {
        await store.updateTarget(t.id, {
          status: 'failed',
          emailReason: '발송 실패: ' + String(res.error || '').slice(0, 80),
          retryStatus: t.status === 'no_email' ? 'no_email' : 'pending',
          failedAt: Date.now(),
          lastFailureReason: String(res.error || ''),
        });
        if (res.errorCode !== 'ping_timeout') {
          await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle, ts: Date.now(), finalText: String(res.error || '').slice(0, 120), result: 'failed' });
        }
      }
      await reloadTargets();
      renderAll();
    }
  });

  $('#markSent').addEventListener('click', () => advance('sent', true));
  $('#markReplied').addEventListener('click', () => advance('replied'));
  $('#markSkip').addEventListener('click', () => advance('skipped'));
  $('#markFail').addEventListener('click', () => advance('failed'));
}

function randomDelay(min, max, skew = 1) {
  let u = 0, v = 0;
  while(u === 0) u = Math.random();
  while(v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);

  num = num / 10.0 + 0.5;
  if (num > 1 || num < 0) return randomDelay(min, max, skew);
  num = Math.pow(num, skew);
  num *= max - min;
  num += min;
  return num; // Keeps decimal precision
}

function pingContentScript(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { action: 'PING' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: 'content_script_not_ready', lastError: chrome.runtime.lastError.message || String(chrome.runtime.lastError) });
          return;
        }
        if (response && response.success) {
          resolve({ ok: true, response });
          return;
        }
        resolve({
          ok: false,
          reason: 'content_script_empty_response',
          lastError: response ? 'ping_unsuccessful_response' : 'empty_ping_response',
          response: response || null,
        });
      });
    } catch (e) {
      resolve({ ok: false, reason: 'content_script_probe_exception', lastError: e && e.message ? e.message : String(e || 'unknown') });
    }
  });
}

async function injectContentScript(tabId, context = {}) {
  recordRunEvent('content_inject_start', 'scripting_execute_script', { tabId, ...context });
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/instagram-automator.js'] }, () => {
        if (chrome.runtime.lastError) {
          recordRunEvent('content_inject_failed', 'scripting_execute_script', {
            tabId,
            error: chrome.runtime.lastError.message || String(chrome.runtime.lastError),
            ...context,
          });
          resolve(false);
          return;
        }
        recordRunEvent('content_injected', 'scripting_execute_script', { tabId, ...context });
        resolve(true);
      });
    } catch (e) {
      recordRunEvent('content_inject_failed', 'scripting_execute_exception', {
        tabId,
        error: e && e.message ? e.message : String(e || 'unknown'),
        ...context,
      });
      resolve(false);
    }
  });
}

async function waitForPing(tabId, maxAttempts = 30, context = {}) {
  recordRunEvent('ping_start', 'content_script_probe', { tabId, maxAttempts, ...context });
  let last = null;
  let triedInject = false;

  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const probe = await pingContentScript(tabId);
    if (probe.ok) {
      recordRunEvent('ping_success', 'content_script_ready', { tabId, attempts, ...context });
      return true;
    }

    last = probe;
    if ([1, 5, 15].includes(attempts)) {
      recordRunEvent('ping_retry', probe.reason, {
        tabId,
        attempts,
        lastError: probe.lastError,
        response: probe.response || null,
        ...context,
      });
    }

    if (!triedInject && attempts >= 2 && /Receiving end does not exist|Could not establish connection/i.test(probe.lastError || '')) {
      triedInject = true;
      await injectContentScript(tabId, { attempts, ...context });
      await new Promise((r) => setTimeout(r, 300));
    }

    if (attempts < maxAttempts) await new Promise((r) => setTimeout(r, 1000));
  }

  recordRunEvent('ping_timeout', last?.reason || 'content_script_not_ready', {
    tabId,
    attempts: maxAttempts,
    lastError: last?.lastError || null,
    response: last?.response || null,
    ...context,
  });
  return false;
}

// Sends one DM. Returns { ok, errorCode }:
//   errorCode: 'no_tab' | 'ping_timeout' | 'blocked' | 'send_failed' | null
// Track A — entry route diversification. Weighted pick (when entryDiversify is on):
//   search 55% (left-nav search), url 30% (side panel navigates to the profile URL),
//   feed 15% (content browses the home feed first, then searches).
// 'mobile' (m.instagram.com) is deferred — it needs CDP UA/device emulation.
function pickEntryRoute() {
  // Default: always reach the profile by TYPING the handle into IG search (most human +
  // visible). The URL-jump / feed routes are only used when entryDiversify is explicitly
  // ON, and even then search dominates.
  if (state.settings.entryDiversify !== true) return 'search';
  const r = Math.random() * 100;
  if (r < 80) return 'search';
  if (r < 90) return 'url';
  return 'feed';
}

function isServiceNoticeError(err) {
  return /IG_NOTICE|try again later|나중에 다시 시도|활동을 제한/i.test(String(err || ''));
}

function unresolvedTemplateVars(text) {
  const names = [...String(text || '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(names.filter((name) => name !== 'context'))];
}

function missingRequiredTemplateVars(rendered) {
  return [...new Set([
    ...(Array.isArray(rendered?.missing) ? rendered.missing : []),
    ...unresolvedTemplateVars(rendered?.text),
  ].filter((name) => name && name !== 'context'))];
}

function templatePreflight(rendered) {
  const missing = missingRequiredTemplateVars(rendered);
  if (missing.length) return `템플릿 변수 누락: ${missing.join(', ')}`;
  if (!String(rendered?.text || '').trim()) return '메시지가 비어 있습니다.';
  return null;
}

function isSearchFlowFailure(err, code) {
  const s = `${code || ''} ${String(err || '')}`;
  return /profile_not_found|search_open_failed|검색 결과|프로필을 찾을 수 없|검색 입력창|검색 아이콘/i.test(s);
}

function normalizeMessageForQuality(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/@[a-z0-9._]+/gi, '@handle')
    .replace(/\{\{\s*context\s*\}\}/g, '')
    .replace(/[^\p{L}\p{N}@<>\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentMessageLog(l) {
  return ['sent', 'second_sent', 'replied'].includes(l?.result) && String(l?.finalText || '').trim();
}

async function messageQualityPreflight(t, rendered, phase) {
  const templateIssue = templatePreflight(rendered);
  if (templateIssue) {
    recordRunEvent('preflight_blocked', 'message_template_issue', {
      handle: t.handle,
      phase,
      issue: templateIssue,
      missing: missingRequiredTemplateVars(rendered),
    });
    return { ok: false, errorCode: 'template_issue', error: templateIssue, quality: true };
  }

  if (state.settings.messageQualityGuard === false) return null;

  const fingerprint = normalizeMessageForQuality(rendered?.text);
  if (!fingerprint) return null;

  const windowSize = Math.max(3, Number(state.settings.messageRepeatWindow || 8));
  const limit = Math.max(1, Number(state.settings.messageRepeatLimit || 2));
  const recent = (await store.listLogs(state.campaignId))
    .filter(sentMessageLog)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, windowSize);
  const matches = recent.filter((l) => normalizeMessageForQuality(l.finalText) === fingerprint);
  if (matches.length >= limit) {
    const error = `최근 ${windowSize}건 중 같은 구조의 메시지가 ${matches.length}회 있어 발송을 멈춤`;
    recordRunEvent('preflight_blocked', 'message_repetition', {
      handle: t.handle,
      phase,
      recentWindow: windowSize,
      repeatLimit: limit,
      repeatCount: matches.length,
      recentHandles: matches.slice(0, 5).map((l) => l.targetHandle || ''),
      fingerprintLength: fingerprint.length,
    });
    return { ok: false, errorCode: 'message_repetition', error, quality: true };
  }

  return null;
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.status === 'complete') return resolve(true);
      } catch { return resolve(false); }
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}

// For the 'url' route, navigate the tab to the profile BEFORE messaging (so the content
// script's response channel isn't torn down mid-flow). The content script detects it is
// already on the profile and skips its search phase. Falls back to search-entry on error.
async function prepareEntry(tabId, handle, route) {
  if (route !== 'url') return; // 'search'/'feed' handled content-side via the entry hint
  const h = String(handle).replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9._]+$/.test(h)) return; // odd handle → let content search instead
  try {
    recordRunEvent('entry_prepare', 'url_route_start', { tabId, handle: h, route });
    await chrome.tabs.update(tabId, { url: `https://www.instagram.com/${encodeURIComponent(h)}/` });
    await waitForTabComplete(tabId);
    recordRunEvent('entry_prepare', 'url_route_loaded', { tabId, handle: h, route });
  } catch (e) {
    console.warn('prepareEntry url nav failed — falling back to search', e);
    recordRunEvent('entry_prepare_failed', 'url_route_failed', { tabId, handle: h, route, error: e && e.message ? e.message : String(e || 'unknown') });
  }
}

// `outStatus` is the status written on success (default 'sent'; the reply loop
// passes 'second_sent' so a follow-up never transiently flips to 'sent').
async function sendSingleTarget(t, r, tpl, outStatus = 'sent') {
  recordRunEvent('target_begin', 'send_single', {
    handle: t.handle,
    status: t.status,
    outStatus,
  });
  const qualityIssue = await messageQualityPreflight(t, r, 'send_single');
  if (qualityIssue) return qualityIssue;
  const btn = $('#autoSendBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '발송 중... 창을 닫지 마세요';
  }
  const restoreBtn = () => { if (btn) { btn.disabled = false; btn.textContent = '개별 자동 발송 (1명)'; } };

  toast(`인스타그램 화면을 찾고 있습니다...`);
  const tabId = await getOrCreateInstagramTab();
  if (!tabId) {
    recordRunEvent('preflight_blocked', 'no_instagram_tab', { handle: t.handle, phase: 'send_single' });
    toast('인스타그램 탭을 찾을 수 없습니다.');
    restoreBtn();
    return { ok: false, errorCode: 'no_tab' };
  }

  const route = pickEntryRoute();
  recordRunEvent('entry_route', route, { handle: t.handle, tabId, phase: 'send_single' });
  await prepareEntry(tabId, t.handle, route);

  toast(`@${t.handle} 실행 스크립트 대기 중...`);
  const isReady = await waitForPing(tabId, 30, { handle: t.handle, route, phase: 'send_single' });
  if (!isReady) {
    recordRunEvent('preflight_blocked', 'content_script_ping_timeout', { handle: t.handle, tabId, route, phase: 'send_single' });
    toast('발송 실행 타임아웃. 인스타그램 탭이 활성화되어 있고 로그인이 되어 있는지 확인하세요.');
    await store.addLog({
      id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle,
      ts: Date.now(), finalText: 'ping_timeout', result: 'failed',
    });
    restoreBtn();
    return { ok: false, errorCode: 'ping_timeout' };
  }

  toast(`@${t.handle} 검색 및 진입 시퀀스 시작...`);
  const sendSearchCommand = (entryRoute, attempt = 'primary') => new Promise((resolve) => {
    recordRunEvent('content_command_sent', 'SEARCH_AND_SEND', { handle: t.handle, tabId, route: entryRoute, attempt });
    chrome.tabs.sendMessage(tabId, { action: 'SEARCH_AND_SEND', handle: t.handle, text: r.text, entry: entryRoute }, async (response) => {
      recordTrace(response, 'send');
      if (chrome.runtime.lastError || !response || !response.success) {
        const err = response ? response.error : (chrome.runtime.lastError?.message || '알 수 없음');
        const serviceNotice = isServiceNoticeError(err);
        // no_dm = this target has no profile "메시지 보내기" button (restricted account /
        // own profile) — skip it and keep going, don't treat it as a fatal send failure.
        const errorCode = serviceNotice ? 'service_notice' : (response && response.reason === 'no_message_button') ? 'no_dm' : 'send_failed';
        recordRunEvent('content_command_failed', response?.reason || errorCode, {
          handle: t.handle,
          tabId,
          route: entryRoute,
          attempt,
          error: err,
          hasResponse: !!response,
        });
        resolve({ ok: false, response, errorCode, error: err, reason: response?.reason || null });
      } else {
        resolve({ ok: true, response, route: entryRoute });
      }
    });
  });

  let result = await sendSearchCommand(route);
  if (!result.ok && result.response?.reason === 'search_open_failed' && route !== 'url') {
    recordRunEvent('route_retry', 'search_open_failed_url_fallback', { handle: t.handle, tabId, fromRoute: route, toRoute: 'url', phase: 'send_single' });
    await prepareEntry(tabId, t.handle, 'url');
    if (await waitForPing(tabId, 30, { handle: t.handle, route: 'url', phase: 'send_single_retry' })) {
      result = await sendSearchCommand('url', 'url_fallback');
    }
  }

  if (!result.ok) {
    toast('발송 실패: ' + result.error);
    restoreBtn();
    return { ok: false, errorCode: result.errorCode, reason: result.reason || result.response?.reason || null, error: result.error };
  }

  const response = result.response;
  recordRunEvent('target_result', outStatus, { handle: t.handle, tabId, route: result.route });
  toast('발송 완료됨!');
  await store.updateTarget(t.id, { status: outStatus });
  await store.addLog({
    id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle,
    ts: Date.now(), finalText: response.finalText || r.text, result: outStatus,
  });
  await reloadTargets();
  renderAll();
  return { ok: true, softSignal: response.softSignal || null };
}

// Drives the content script to scrape one target's profile bio for an email.
// Buckets the result: email found → status 'email_collected' (excluded from DM);
// none → status 'no_email' (falls into the DM queue).
async function scrapeEmailForTarget(t) {
  recordRunEvent('target_begin', 'scrape_email', {
    handle: t.handle,
    status: t.status,
  });
  const tabId = await getOrCreateInstagramTab();
  if (!tabId) {
    recordRunEvent('preflight_blocked', 'no_instagram_tab', { handle: t.handle, phase: 'scrape_email' });
    return { ok: false, infra: true, error: '인스타그램 탭을 찾을 수 없습니다.' };
  }
  const route = pickEntryRoute();
  recordRunEvent('entry_route', route, { handle: t.handle, tabId, phase: 'scrape_email' });
  await prepareEntry(tabId, t.handle, route);
  const ready = await waitForPing(tabId, 30, { handle: t.handle, route, phase: 'scrape_email' });
  if (!ready) {
    recordRunEvent('preflight_blocked', 'content_script_ping_timeout', { handle: t.handle, tabId, route, phase: 'scrape_email' });
    await store.addLog({
      id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle,
      ts: Date.now(), finalText: 'ping_timeout', result: 'failed',
    });
    return { ok: false, infra: true, error: '실행 스크립트가 준비되지 않았습니다.' };
  }
  return new Promise((resolve) => {
    recordRunEvent('content_command_sent', 'SCRAPE_EMAIL', { handle: t.handle, tabId, route });
    chrome.tabs.sendMessage(tabId, { action: 'SCRAPE_EMAIL', handle: t.handle, entry: route }, async (response) => {
      recordTrace(response, 'scrape');
      if (chrome.runtime.lastError || !response || !response.success) {
        const err = response ? response.error : (chrome.runtime.lastError?.message || '알 수 없음');
        const serviceNotice = isServiceNoticeError(err);
        recordRunEvent('content_command_failed', response?.reason || 'scrape_email_failed', {
          handle: t.handle,
          tabId,
          route,
          error: err,
          hasResponse: !!response,
        });
        if (!serviceNotice) {
          // Per-target scrape failure (bad/private handle, transient DOM): mark failed so
          // the queue advances instead of locking on this head-of-queue target forever.
          await store.updateTarget(t.id, {
            status: 'failed',
            emailReason: 'scrape: ' + err,
            retryStatus: 'pending',
            failedAt: Date.now(),
            lastFailureReason: err,
          });
          await store.addLog({
            id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle,
            ts: Date.now(), finalText: String(err).slice(0, 120), result: 'failed',
          });
          await reloadTargets();
        }
        resolve({ ok: false, infra: serviceNotice, blocked: serviceNotice, errorCode: response?.reason || null, error: err });
        return;
      }
      const email = response.email || null;
      const confidence = response.confidence || null;
      const reason = response.reason || null;
      const isPrivate = !!response.isPrivate;
      const followersCount = typeof response.followersCount === 'number' ? response.followersCount : null;

      // Track D — skip private / low-follower profiles, but ONLY on a positive read
      // (unknown followers / unknown-private never skip — safe default is proceed).
      const s = state.settings;
      let skipReason = null;
      if (s.smartFilter !== false) {
        if (s.skipPrivate !== false && isPrivate) skipReason = '비공개 계정';
        else if ((s.minFollowers || 0) > 0 && followersCount != null && followersCount < s.minFollowers) skipReason = `팔로워 ${followersCount} < ${s.minFollowers}`;
      }
      if (skipReason) {
        recordRunEvent('target_result', 'skipped', { handle: t.handle, tabId, route, skipReason });
        await store.updateTarget(t.id, { status: 'skipped', isPrivate, followersCount, emailReason: '스킵: ' + skipReason });
        await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle, ts: Date.now(), finalText: skipReason, result: 'skipped' });
        await reloadTargets();
        resolve({ ok: true, skipped: true, skipReason, softSignal: response.softSignal || null });
        return;
      }

      await store.updateTarget(
        t.id,
        email
          ? { email, emailConfidence: confidence, emailReason: reason, status: 'email_collected', isPrivate, followersCount }
          : { email: null, status: 'no_email', isPrivate, followersCount }
      );
      recordRunEvent('target_result', email ? 'email_collected' : 'no_email', {
        handle: t.handle,
        tabId,
        route,
        hasEmail: !!email,
        emailConfidence: confidence,
        isPrivate,
        followersCount,
      });
      await store.addLog({
        id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle,
        ts: Date.now(), finalText: email ? `${email} (${confidence})` : '', result: email ? 'email_collected' : 'no_email',
      });
      await reloadTargets();
      resolve({ ok: true, email, confidence, reason, softSignal: response.softSignal || null });
    });
  });
}

// Unified per-target driver: scrape → collect (email) | follow+DM (no email). The content
// returns { action: 'collected'|'sent'|'skipped' }; we bucket the target accordingly.
async function processTargetOnce(t, r) {
  recordRunEvent('target_begin', 'process_target', {
    handle: t.handle,
    status: t.status,
    hasEmail: !!t.email,
  });
  const qualityIssue = await messageQualityPreflight(t, r, 'process_target');
  if (qualityIssue) return qualityIssue;
  const tabId = await getOrCreateInstagramTab();
  if (!tabId) {
    recordRunEvent('preflight_blocked', 'no_instagram_tab', { handle: t.handle });
    return { ok: false, infra: true, error: '인스타그램 탭을 찾을 수 없습니다.' };
  }
  const route = pickEntryRoute();
  recordRunEvent('entry_route', route, { handle: t.handle, tabId });
  await prepareEntry(tabId, t.handle, route);
  if (!(await waitForPing(tabId, 30, { handle: t.handle, route, phase: 'process_target' }))) {
    recordRunEvent('preflight_blocked', 'content_script_ping_timeout', {
      handle: t.handle,
      tabId,
      route,
      hint: 'Reload the Instagram tab after reloading the unpacked extension.',
    });
    await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle, ts: Date.now(), finalText: 'ping_timeout', result: 'failed' });
    return { ok: false, infra: true, error: '실행 스크립트가 준비되지 않았습니다.' };
  }
  const sendProcessCommand = (entryRoute, attempt = 'primary') => new Promise((resolve) => {
    recordRunEvent('content_command_sent', 'PROCESS_TARGET', { handle: t.handle, tabId, route: entryRoute, attempt });
    chrome.tabs.sendMessage(tabId, { action: 'PROCESS_TARGET', handle: t.handle, text: r.text, entry: entryRoute }, async (response) => {
      recordTrace(response, 'process');
      if (chrome.runtime.lastError || !response || !response.success) {
        const err = response ? response.error : (chrome.runtime.lastError?.message || '알 수 없음');
        recordRunEvent('content_command_failed', response?.reason || 'process_target_failed', {
          handle: t.handle,
          tabId,
          route: entryRoute,
          attempt,
          error: err,
          hasResponse: !!response,
        });
        resolve({ ok: false, response, blocked: isServiceNoticeError(err), errorCode: response?.reason || null, error: err });
        return;
      }
      resolve({ ok: true, response });
    });
  });

  let result = await sendProcessCommand(route);
  if (!result.ok && result.response?.reason === 'search_open_failed' && route !== 'url') {
    recordRunEvent('route_retry', 'search_open_failed_url_fallback', { handle: t.handle, tabId, fromRoute: route, toRoute: 'url' });
    await prepareEntry(tabId, t.handle, 'url');
    if (await waitForPing(tabId, 30, { handle: t.handle, route: 'url', phase: 'process_target_retry' })) {
      result = await sendProcessCommand('url', 'url_fallback');
    }
  }

  if (!result.ok) return { ok: false, blocked: result.blocked, errorCode: result.errorCode || result.response?.reason || null, error: result.error };

  const response = result.response;
  const action = response.action;
  const meta = { isPrivate: !!response.isPrivate, followersCount: typeof response.followersCount === 'number' ? response.followersCount : null };
  recordRunEvent('target_result', action || 'unknown', {
    handle: t.handle,
    tabId,
    route,
    hasEmail: action === 'collected',
    followersCount: meta.followersCount,
    isPrivate: meta.isPrivate,
  });
  if (action === 'collected') {
    await store.updateTarget(t.id, { email: response.email, emailConfidence: response.confidence, emailReason: response.reason, status: 'email_collected', ...meta });
    await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle, ts: Date.now(), finalText: `${response.email} (${response.confidence})`, result: 'email_collected' });
  } else if (action === 'sent') {
    await store.updateTarget(t.id, { status: 'sent', ...meta });
    await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle, ts: Date.now(), finalText: response.finalText || r.text, result: 'sent' });
  } else {
    await store.updateTarget(t.id, { status: 'skipped', emailReason: 'DM 버튼 없음', ...meta });
    await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle, ts: Date.now(), finalText: response.reason || 'no_message_button', result: 'skipped' });
  }
  await reloadTargets();
  return { ok: true, action, softSignal: response.softSignal || null };
}

async function dumpInstagramPageState() {
  try {
    const tabId = await getOrCreateInstagramTab();
    if (!tabId) {
      toast('IG 탭을 찾을 수 없습니다.');
      return;
    }
    const ready = await waitForPing(tabId);
    if (!ready) {
      toast('스크립트가 아직 준비되지 않았습니다. IG 탭을 새로고침(F5) 후 다시 시도하세요.');
      return;
    }
    chrome.tabs.sendMessage(tabId, { action: 'DUMP_PAGE_STATE' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        toast('상태 덤프 실패: ' + (response ? response.error : '알 수 없음'));
        return;
      }
      const s = response.state || {};
      console.log('%c[IG Automator Debug] 페이지 상태 덤프 (복사해서 전달하세요)', 'color:#3b5bdb;font-weight:600', s);
      // Also surface a small actionable toast + encourage copy from console
      toast('IG 상태가 콘솔에 출력됐습니다. 콘솔에서 객체를 펼쳐 복사하세요. (우클릭 → Copy object)');
      // Optional: store last dump in a global for easy access in console
      window.__lastIgDump = s;
    });
  } catch (e) {
    console.error(e);
    toast('덤프 중 오류: ' + e.message);
  }
}

// 부트 후 이벤트 위임 (한 번만 등록되도록 renderAll 바깥에 위치하거나 본문에 연결)
document.addEventListener('click', async (e) => {
  try {
    const startBulkBtn = e.target.closest('#startBulkAutoSend');
    const stopBulkBtn = e.target.closest('#stopAutoSend');
    const startRepliesBtn = e.target.closest('#startCheckReplies');
    const stopRepliesBtn = e.target.closest('#stopCheckReplies');
    const dumpBtn = e.target.closest('#dumpIgStateBtn');
    const exportTracesBtn = e.target.closest('#exportTracesBtn');
    const clearTracesBtn = e.target.closest('#clearTracesBtn');
    const resetTestBtn = e.target.closest('#resetTestBtn');
    const retryFailedBtn = e.target.closest('#retryFailedBtn');
    const startProcessBtn = e.target.closest('#startProcess');
    const stopProcessBtn = e.target.closest('#stopProcess');
    const startCollectBtn = e.target.closest('#startCollectEmails');
    const stopCollectBtn = e.target.closest('#stopCollectEmails');
    const exportEmailsBtn = e.target.closest('#exportEmails');
    const toggleMotionBtn = e.target.closest('#toggleMotionLearn');
    const syncNowBtn = e.target.closest('#syncNowBtn');
    const openDashboardBtn = e.target.closest('#openDashboardBtn');

    if (startProcessBtn) {
      if (chrome.__dev) {
        recordRunEvent('preflight_blocked', 'web_harness_mode', {
          hint: 'Open the unpacked Chrome extension side panel. The 127.0.0.1 harness cannot drive Instagram tabs.',
        });
        toast('웹 하니스에서는 IG 실행 흐름을 사용할 수 없습니다. 언팩 확장 사이드패널에서 실행하세요.');
        return;
      }
      if (state.isProcessing) {
        recordRunEvent('preflight_blocked', 'already_processing');
        return; // reentry guard
      }
      if (isBlockedNow()) {
        recordRunEvent('preflight_blocked', 'cooldown_active', { cooldownUntil: currentCampaign()?.cooldownUntil || null });
        toast(blockedMsg());
        return;
      }
      const tpl = currentTemplate();
      if (!tpl || !(tpl.body || '').trim()) {
        recordRunEvent('preflight_blocked', 'missing_template');
        toast('먼저 대상·메시지 탭에서 메시지를 저장하세요.');
        return;
      }
      state.isProcessing = true;
      resetSession();
      rateReset();
      state.runStartAt = Date.now();
      state.runActionCount = 0;
      recordRunEvent('run_start', 'process_targets', {
        pendingCount: state.targets.filter((t) => t.status === 'pending').length,
        targetCount: state.targets.length,
        harness: !!chrome.__dev,
      });
      let consecutiveFails = 0;
      let consecutiveSearchFails = 0;
      let tabEstablished = false;
      renderAll();
      while (state.isProcessing) {
        if (tabEstablished && !(await igTabAlive())) {
          recordRunEvent('run_stop', 'ig_tab_closed');
          toast('IG 탭이 닫혔습니다. 멈춥니다.');
          state.isProcessing = false; renderAll(); break;
        }
        const queue = state.targets.filter((t) => t.status === 'pending');
        if (queue.length === 0) {
          recordRunEvent('run_stop', 'no_pending_targets');
          toast('모든 대상 처리 완료 ✅');
          state.isProcessing = false; renderAll(); break;
        }
        if (!(await rateGate(() => state.isProcessing))) {
          recordRunEvent('run_stop', 'rate_gate_interrupted');
          break;
        }
        const t = queue[0];
        const r = render(tpl.body, { handle: t.handle, ...t.vars }, seedFrom(t.handle));
        toast(`@${t.handle} 처리 중...`);
        const res = await processTargetOnce(t, r);
        if (res.ok) { rateRecord(); state.runActionCount = (state.runActionCount || 0) + 1; consecutiveFails = 0; consecutiveSearchFails = 0; }
        if (!res.ok) {
          if (res.quality) {
            recordRunEvent('run_stop', 'message_quality_guard', { handle: t.handle, errorCode: res.errorCode || null, error: res.error || null });
            toast('메시지 품질 가드로 중지: ' + (res.error || '반복/불완전 메시지'));
            state.isProcessing = false; renderAll(); break;
          }
          if (res.blocked) {
            await stopForHardBlock(res.error, '처리');
            state.isProcessing = false; renderAll(); break;
          }
          if (res.infra) {
            recordRunEvent('run_stop', 'infra_error', { handle: t.handle, error: res.error || null });
            toast('중지: ' + (res.error || '탭/스크립트 문제'));
            state.isProcessing = false; renderAll(); break;
          }
          consecutiveFails++;
          if (isSearchFlowFailure(res.error, res.errorCode)) {
            consecutiveSearchFails++;
            recordRunEvent('search_failure_pattern', 'process_target_search_failed', {
              handle: t.handle,
              count: consecutiveSearchFails,
              errorCode: res.errorCode || null,
              error: res.error || null,
            });
          } else {
            consecutiveSearchFails = 0;
          }
          await store.updateTarget(t.id, {
            status: 'failed',
            emailReason: '처리 실패: ' + String(res.error || '').slice(0, 80),
            retryStatus: 'pending',
            failedAt: Date.now(),
            lastFailureReason: String(res.error || ''),
          });
          await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: t.handle, ts: Date.now(), finalText: String(res.error || '').slice(0, 120), result: 'failed' });
          await reloadTargets(); renderAll();
          if (consecutiveSearchFails >= 2) {
            recordRunEvent('run_stop', 'repeated_search_failures', { lastHandle: t.handle, lastError: res.error || null });
            toast('검색/프로필 진입 실패가 연속 발생했습니다. 패턴 반복을 막기 위해 중지합니다.');
            state.isProcessing = false; renderAll(); break;
          }
          if (consecutiveFails >= 3) {
            recordRunEvent('run_stop', 'three_consecutive_failures', { lastHandle: t.handle, lastError: res.error || null });
            toast('연속 3회 실패 — 시스템 문제로 보고 중지합니다.');
            state.isProcessing = false; renderAll(); break;
          }
          toast(`@${t.handle} 실패 → 다음 대상으로`);
          continue;
        }
        tabEstablished = true;
        toast(`@${t.handle} → ${res.action === 'collected' ? '이메일 수집' : res.action === 'sent' ? 'DM 발송' : 'DM 버튼 없음 → 스킵'}`);
        renderAll();
        if (res.softSignal && state.isProcessing) {
          await stopForSoftSignal(res.softSignal, '처리');
          state.isProcessing = false; renderAll(); break;
        }
        if (state.isProcessing) await postSendSettle(res.action, () => state.isProcessing, 'process');
        if (state.isProcessing) await sessionPace(() => state.isProcessing);
        if (state.isProcessing && state.targets.filter((x) => x.status === 'pending').length > 0) {
          const delayMs = randomDelay((state.settings.jitterMin || 5) * 1000, (state.settings.jitterMax || 15) * 1000) * (state.paceFactor || 1);
          toast(`다음 대상 대기... (${Math.round(delayMs / 1000)}초)`);
          await new Promise((rr) => setTimeout(rr, delayMs));
        }
      }
    } else if (stopProcessBtn) {
      state.isProcessing = false;
      try { chrome.runtime.sendMessage({ action: 'CDP_DETACH' }); } catch {}
      toast('처리를 중지합니다.');
      renderAll();
    } else if (startCollectBtn) {
      if (state.isCollectingEmails) return; // reentry guard — don't start a second loop
      if (isBlockedNow()) { toast(blockedMsg()); return; }
      state.isCollectingEmails = true;
      resetSession();
      rateReset();
      state.runStartAt = Date.now();
      state.runActionCount = 0;
      let tabEstablished = false;
      let consecutiveSearchFails = 0;
      renderAll();
      while (state.isCollectingEmails) {
        if (tabEstablished && !(await igTabAlive())) {
          toast('IG 탭이 닫혔습니다. 수집을 멈춥니다.');
          state.isCollectingEmails = false;
          renderAll();
          break;
        }
        const collectQueue = state.targets.filter((t) => t.status === 'pending');
        if (collectQueue.length === 0) {
          toast('수집할 대상이 없습니다. (모두 처리됨)');
          state.isCollectingEmails = false;
          renderAll();
          break;
        }
        if (!(await rateGate(() => state.isCollectingEmails))) break;
        const nextT = collectQueue[0];
        toast(`@${nextT.handle} 프로필에서 이메일 수집 중...`);
        const res = await scrapeEmailForTarget(nextT);
        if (res.ok) { rateRecord(); state.runActionCount = (state.runActionCount || 0) + 1; consecutiveSearchFails = 0; }
        if (!res.ok) {
          if (res.blocked) {
            await stopForHardBlock(res.error, '수집');
            state.isCollectingEmails = false;
            renderAll();
            break;
          }
          if (res.infra) {
            toast('수집 중지: ' + (res.error || '탭/스크립트 문제'));
            state.isCollectingEmails = false;
            renderAll();
            break;
          }
          if (isSearchFlowFailure(res.error, res.errorCode)) {
            consecutiveSearchFails++;
            recordRunEvent('search_failure_pattern', 'scrape_email_search_failed', {
              handle: nextT.handle,
              count: consecutiveSearchFails,
              errorCode: res.errorCode || null,
              error: res.error || null,
            });
          } else {
            consecutiveSearchFails = 0;
          }
          // Per-target scrape failure already marked 'failed' inside scrapeEmailForTarget → skip & continue.
          toast(`@${nextT.handle} 수집 실패 → 건너뜀`);
          renderAll();
          if (consecutiveSearchFails >= 2) {
            recordRunEvent('run_stop', 'repeated_search_failures', { lastHandle: nextT.handle, lastError: res.error || null });
            toast('검색/프로필 진입 실패가 연속 발생했습니다. 수집을 중지합니다.');
            state.isCollectingEmails = false;
            renderAll();
            break;
          }
        } else {
          if (res.skipped) toast(`@${nextT.handle} 스킵됨 (${res.skipReason})`);
          else toast(res.email ? `@${nextT.handle} → ${res.email} [${res.confidence === 'high' ? '신뢰 높음' : '보통'}] 저장됨` : `@${nextT.handle} 컨택 이메일 없음 → DM 대상`);
          renderAll();
          if (res.softSignal && state.isCollectingEmails) {
            await stopForSoftSignal(res.softSignal, '수집');
            state.isCollectingEmails = false; renderAll(); break;
          }
        }
        tabEstablished = true; // reached here only if the tab responded (no infra/blocked break)
        if (state.isCollectingEmails) await sessionPace(() => state.isCollectingEmails);
        if (state.isCollectingEmails && state.targets.filter((t) => t.status === 'pending').length > 0) {
          const jitterMin = state.settings.jitterMin || 5;
          const jitterMax = state.settings.jitterMax || 15;
          const delayMs = randomDelay(jitterMin * 1000, jitterMax * 1000) * (state.paceFactor || 1);
          toast(`다음 대상 대기 중... (${Math.round(delayMs / 1000)}초)`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    } else if (stopCollectBtn) {
      state.isCollectingEmails = false;
      try { chrome.runtime.sendMessage({ action: 'CDP_DETACH' }); } catch {}
      toast('이메일 수집을 중지합니다.');
      renderAll();
    } else if (exportEmailsBtn) {
      const rows = state.targets
        .filter((t) => t.status === 'email_collected')
        .map((t) => ({ handle: t.handle, email: t.email || '', confidence: t.emailConfidence || '', reason: t.emailReason || '' }));
      if (!rows.length) return toast('내보낼 이메일이 없습니다');
      downloadCSV(`emails_${currentCampaign().name}.csv`, ['handle', 'email', 'confidence', 'reason'], rows);
    } else if (startBulkBtn) {
      if (state.isAutoSending) return; // reentry guard
      if (isBlockedNow()) { toast(blockedMsg()); return; }
      if (state.targets.some((t) => t.status === 'pending')) {
        toast('미수집 대상이 있습니다. 1단계 이메일 수집을 먼저 끝내세요.');
        return;
      }
      state.isAutoSending = true;
      resetSession();
      rateReset();
      state.runStartAt = Date.now();
      state.runActionCount = 0;
      // Restore a persisted block cooldown instead of blindly clearing it.
      state.cooldownUntil = currentCampaign()?.cooldownUntil && currentCampaign().cooldownUntil > Date.now()
        ? currentCampaign().cooldownUntil : null;
      let batchSentCount = 0;
      let consecutiveFails = 0;
      let consecutiveSearchFails = 0;
      let tabEstablished = false;
      renderAll();

      while (state.isAutoSending) {
        if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
          const remainingSec = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
          const timerEl = document.getElementById('cooldownTimer');
          if (timerEl) {
            timerEl.textContent = `재개까지: ${Math.floor(remainingSec / 60)}분 ${remainingSec % 60}초 남음`;
          }
          await new Promise(res => setTimeout(res, 1000));
          continue;
        } else if (state.cooldownUntil && Date.now() >= state.cooldownUntil) {
          state.cooldownUntil = null;
          batchSentCount = 0;
          toast('휴식 종료. 발송을 재개합니다.');
          renderAll();
        }

        if (tabEstablished && !(await igTabAlive())) {
          toast('IG 탭이 닫혔습니다. 자동 발송을 멈춥니다.');
          state.isAutoSending = false;
          renderAll();
          break;
        }
        // DM queue is ONLY the no_email bucket (collected emails are emailed, not DM'd).
        const queue = state.targets.filter((t) => t.status === 'no_email');
        // Track D — prioritize higher-follower (more relevant) targets first.
        if (state.settings.smartFilter !== false) queue.sort((a, b) => (b.followersCount || 0) - (a.followersCount || 0));
        const c = currentCampaign();
        const counts = statusCounts();
        const tpl = currentTemplate();

        if (!tpl) {
          toast('템플릿이 사라졌습니다. 발송을 중지합니다.');
          state.isAutoSending = false;
          renderAll();
          break;
        }
        if (queue.length === 0 || counts.sent >= c.cap) {
          toast('DM 대기열이 비었거나 상한에 도달했습니다.');
          state.isAutoSending = false;
          renderAll();
          break;
        }

        if (!(await rateGate(() => state.isAutoSending))) break;
        const nextTarget = queue[0];
        const r = render(tpl.body, { handle: nextTarget.handle, ...nextTarget.vars }, seedFrom(nextTarget.handle));

        const res = await sendSingleTarget(nextTarget, r, tpl);
        if (res.ok) { rateRecord(); state.runActionCount = (state.runActionCount || 0) + 1; consecutiveFails = 0; consecutiveSearchFails = 0; }

        if (!res.ok) {
          if (res.quality) {
            recordRunEvent('run_stop', 'message_quality_guard', { handle: nextTarget.handle, errorCode: res.errorCode || null, error: res.error || null });
            toast('메시지 품질 가드로 자동 발송을 중지합니다: ' + (res.error || '반복/불완전 메시지'));
            state.isAutoSending = false;
            renderAll();
            break;
          }
          if (res.errorCode === 'service_notice') {
            await stopForHardBlock(res.error, '발송');
            state.isAutoSending = false;
            renderAll();
            break;
          }
          if (res.errorCode === 'no_dm') {
            // No profile "메시지 보내기" button (unavailable / own account) — skip & continue.
            await store.updateTarget(nextTarget.id, { status: 'skipped', emailReason: 'DM 버튼 없음/본인 계정' });
            await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: nextTarget.handle, ts: Date.now(), finalText: 'no_message_button', result: 'skipped' });
            await reloadTargets();
            toast(`@${nextTarget.handle} DM 버튼 없음 → 건너뜀`);
            renderAll();
            continue;
          }
          // Transient send failure — mark failed and keep going, but stop after 3 in a row
          // (likely systemic: tab/login/selectors) so we don't churn the whole queue.
          consecutiveFails++;
          if (isSearchFlowFailure(res.error, res.reason || res.errorCode)) {
            consecutiveSearchFails++;
            recordRunEvent('search_failure_pattern', 'send_single_search_failed', {
              handle: nextTarget.handle,
              count: consecutiveSearchFails,
              errorCode: res.reason || res.errorCode || null,
              error: res.error || null,
            });
          } else {
            consecutiveSearchFails = 0;
          }
          await store.updateTarget(nextTarget.id, {
            status: 'failed',
            emailReason: '발송 실패: ' + String(res.error || '').slice(0, 80),
            retryStatus: 'no_email',
            failedAt: Date.now(),
            lastFailureReason: String(res.error || ''),
          });
          await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: nextTarget.handle, ts: Date.now(), finalText: String(res.error || '').slice(0, 120), result: 'failed' });
          await reloadTargets();
          renderAll();
          if (consecutiveSearchFails >= 2) {
            recordRunEvent('run_stop', 'repeated_search_failures', { lastHandle: nextTarget.handle, lastError: res.error || null });
            toast('검색/프로필 진입 실패가 연속 발생했습니다. 자동 발송을 중지합니다.');
            state.isAutoSending = false;
            renderAll();
            break;
          }
          if (consecutiveFails >= 3) {
            toast('연속 3회 실패 — 시스템 문제로 보고 자동 발송을 중지합니다.');
            state.isAutoSending = false;
            renderAll();
            break;
          }
          toast(`@${nextTarget.handle} 발송 실패 → 다음 대상으로`);
          continue;
        }

        tabEstablished = true;
        batchSentCount++;
        const batchSize = state.settings.batchSize || 10;

        // Track F — soft warning after a successful send: stop immediately and enter
        // the same persisted cooldown flow as a service notice response.
        if (res.softSignal && state.isAutoSending) {
          await stopForSoftSignal(res.softSignal, '발송');
          state.isAutoSending = false; renderAll(); break;
        }
        if (state.isAutoSending) await postSendSettle('sent', () => state.isAutoSending, 'bulk_send');
        if (state.isAutoSending) await sessionPace(() => state.isAutoSending);

        if (batchSentCount >= batchSize && state.isAutoSending && queue.length > 1) {
          // 2) 배치 쿨다운 (N건 후 강제 장기 휴식)
          const cooldownMin = (state.settings.batchCooldownMin || 15) * (state.paceFactor || 1);
          state.cooldownUntil = Date.now() + cooldownMin * 60 * 1000;
          toast(`안전을 위해 ${Math.round(cooldownMin)}분간 휴식합니다...`);
          renderAll();
        } else if (state.isAutoSending && queue.length > 1) {
          // 1) 대상 간 지터 (1건 성공 직후 적용되는 랜덤 짧은 휴식 — "랜딩" 이후 다음 검색 전)
          const jitterMin = state.settings.jitterMin || 5;
          const jitterMax = state.settings.jitterMax || 15;
          let delayMs = randomDelay(jitterMin * 1000, jitterMax * 1000) * (state.paceFactor || 1);

          // 추가 세션 변동성 (인간처럼 가끔 더 길게 쉬거나, 가끔 "딴짓" 하는 느낌)
          if (Math.random() < 0.12) {
            // 가끔 "한 번 더 생각하거나 다른 거 확인하는" 추가 지연
            delayMs += randomDelay(1800, 5200);
            toast(`다음 대상 대기 중... (조금 더 생각 중, ${Math.round(delayMs/1000)}초)`);
          } else {
            toast(`다음 대상 대기 중... (${Math.round(delayMs/1000)}초)`);
          }

          await new Promise(res => setTimeout(res, delayMs));

          // 아주 가끔 IG 탭에서 살짝 스크롤 (인간이 피드나 DM 리스트를 살짝 보는 행동)
          // MV3: chrome.tabs.executeScript is removed — use chrome.scripting.executeScript with `func`+`args` (not `code:` string).
          if (Math.random() < 0.08 && dmTabId) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: dmTabId },
                func: (delta) => window.scrollBy(0, delta),
                args: [Math.random() > 0.5 ? 220 : -140],
              });
            } catch (e) { console.warn('idle scroll injection failed', e); }
          }
        }
      }
    } else if (stopBulkBtn) {
      state.isAutoSending = false;
      state.cooldownUntil = null;
      try { chrome.runtime.sendMessage({ action: 'CDP_DETACH' }); } catch {}
      toast('전체 자동 발송을 중지합니다.');
      renderAll();
    } else if (startRepliesBtn) {
      if (state.isCheckingReplies) return; // reentry guard
      if (isBlockedNow()) { toast(blockedMsg()); return; }
      state.isCheckingReplies = true;
      let tabEstablished = false;
      renderAll();

      while (state.isCheckingReplies) {
        if (tabEstablished && !(await igTabAlive())) {
          toast('IG 탭이 닫혔습니다. 응답 확인을 멈춥니다.');
          state.isCheckingReplies = false;
          renderAll();
          break;
        }
        // Only check 'sent' targets that haven't been checked in the last hour
        const queue = state.targets.filter((t) => t.status === 'sent' && (!t.checkedAt || Date.now() - t.checkedAt > 3600000));

        if (queue.length === 0) {
          toast('확인할 발송 완료 대상이 없습니다.');
          state.isCheckingReplies = false;
          renderAll();
          break;
        }

        const nextTarget = queue[0];
        const templateId = document.getElementById('followUpTemplateId')?.value;
        const followUpTemplate = state.templates.find((t) => t.id === templateId);

        if (!followUpTemplate) {
          toast('2차 발송용 템플릿이 선택되지 않았습니다.');
          state.isCheckingReplies = false;
          renderAll();
          break;
        }

        toast(`@${nextTarget.handle} 응답 확인을 위해 인스타그램 탭을 찾는 중...`);
        const tabId = await getOrCreateInstagramTab();
        if (!tabId) {
          toast('인스타그램 탭을 찾을 수 없습니다.');
          state.isCheckingReplies = false;
          renderAll();
          break;
        }

        toast(`@${nextTarget.handle} 응답 확인 중...`);
        const isReady = await waitForPing(tabId);
        if (!isReady) {
          await store.addLog({ id: store.uid(), campaignId: state.campaignId, targetHandle: nextTarget.handle, ts: Date.now(), finalText: 'ping_timeout', result: 'failed' });
          toast(`@${nextTarget.handle} 스크립트 로딩 실패. 탭 상태를 확인하세요.`);
          state.isCheckingReplies = false;
          renderAll();
          break;
        }

        // CHECK_REPLY navigates to THIS target's thread first, then scans. Distinguish a real
        // check from a tab/nav failure so we never burn checkedAt on a broken page.
        const replyRes = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'CHECK_REPLY', handle: nextTarget.handle }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success) {
              resolve({ ok: false, error: chrome.runtime.lastError?.message || (response && response.error) || 'no_response' });
              return;
            }
            resolve({ ok: true, hasReplied: !!response.hasReplied });
          });
        });

        if (!replyRes.ok) {
          // Do NOT mark checkedAt — halt so a broken tab doesn't false-negative the whole queue.
          toast('응답 확인 실패: ' + replyRes.error + ' — 중지합니다.');
          state.isCheckingReplies = false;
          renderAll();
          break;
        }
        tabEstablished = true;

        if (replyRes.hasReplied) {
          toast(`@${nextTarget.handle} 응답 확인됨! 2차 메시지 발송 중...`);
          await store.updateTarget(nextTarget.id, { status: 'replied' });

          const r = render(followUpTemplate.body, { handle: nextTarget.handle, ...nextTarget.vars }, seedFrom(nextTarget.handle));
          // outStatus 'second_sent' → single authoritative write/log, no transient 'sent', no double-count.
          const res = await sendSingleTarget(nextTarget, r, followUpTemplate, 'second_sent');

          if (!res.ok) {
            if (res.errorCode === 'service_notice') await stopForHardBlock(res.error, '2차 발송');
            else if (res.quality) toast('2차 발송 전 차단: ' + (res.error || '메시지 품질 확인 필요'));
            else toast('2차 발송 실패로 중지합니다.');
            state.isCheckingReplies = false;
            renderAll();
            break;
          }
          if (res.softSignal) {
            await stopForSoftSignal(res.softSignal, '2차 발송');
            state.isCheckingReplies = false;
            renderAll();
            break;
          }
        } else {
          toast(`@${nextTarget.handle} 아직 응답 없음. (다음 확인 대상 대기 중...)`);
          await store.updateTarget(nextTarget.id, { checkedAt: Date.now() });
        }

        if (state.isCheckingReplies && queue.length > 1) {
          // Delay before opening the next DM
          const delayMs = randomDelay(3000, 7000); // 3 to 7 seconds
          await new Promise(res => setTimeout(res, delayMs));
        }

        // Reload targets to get updated status and checkedAt
        await reloadTargets();

        // Stop loop if all 'sent' targets have been checked in the last 1 hour
        const unCheckedQueue = state.targets.filter((t) => t.status === 'sent' && (!t.checkedAt || Date.now() - t.checkedAt > 3600000));
        if (unCheckedQueue.length === 0) {
           toast('모든 대상의 응답 확인을 완료했습니다.');
           state.isCheckingReplies = false;
           renderAll();
           break;
        }
      }
    } else if (stopRepliesBtn) {
      state.isCheckingReplies = false;
      try { chrome.runtime.sendMessage({ action: 'CDP_DETACH' }); } catch {}
      toast('응답 확인 및 2차 발송을 중지합니다.');
      renderAll();
    } else if (dumpBtn) {
      dumpInstagramPageState();
    } else if (exportTracesBtn) {
      const traces = await store.listTraces();
      if (!traces.length) return toast('수집된 트레이스가 없습니다 (발송/수집을 먼저 실행하세요)');
      const fails = traces.filter((t) => t.outcome === 'fail').length;
      const runEvents = traces.filter((t) => t.kind === 'run_event').length;
      const preflightBlocks = traces.filter((t) => t.kind === 'run_event' && t.type === 'preflight_blocked').length;
      const pingTimeouts = traces.filter((t) => t.kind === 'run_event' && t.type === 'ping_timeout').length;
      downloadJSON(`traces_${currentCampaign()?.name || 'all'}.json`, traces);
      toast(`트레이스 ${traces.length}개 내보냄 (실패 ${fails} · 실행이벤트 ${runEvents} · 시작차단 ${preflightBlocks} · ping timeout ${pingTimeouts})`);
    } else if (retryFailedBtn) {
      if (state.isProcessing || state.isCollectingEmails || state.isAutoSending || state.isCheckingReplies) {
        toast('실행 중에는 실패 큐를 재구성할 수 없습니다.');
        return;
      }
      const failed = state.targets.filter((t) => t.status === 'failed');
      if (!failed.length) {
        toast('재시도할 실패 항목이 없습니다.');
        return;
      }
      if (!confirm(`실패 항목 ${failed.length}개만 재시도 큐로 되돌릴까요?`)) return;
      const res = await requeueFailedTargets();
      await reloadTargets();
      renderAll();
      toast(`실패 ${res.total}개 재시도 준비: 수집 ${res.pending}, DM ${res.noEmail}`);
    } else if (clearTracesBtn) {
      await store.clearTraces();
      toast('트레이스를 비웠습니다');
    } else if (resetTestBtn) {
      if (!confirm('현재 캠페인의 모든 대상을 pending으로 되돌릴까요? (재테스트용)')) return;
      const ts = await store.listTargets(state.campaignId);
      for (const t of ts) await store.updateTarget(t.id, { status: 'pending', email: null, emailConfidence: null, emailReason: null });
      await reloadTargets();
      renderAll();
      toast(`대상 ${ts.length}개를 pending으로 리셋했습니다`);
    } else if (toggleMotionBtn) {
      const next = state.settings.motionLearn === false; // currently off → turn on
      state.settings = await store.saveSettings({ motionLearn: next });
      toast(next ? '모션 학습 켜짐 — IG를 평소처럼 쓰면 학습됩니다.' : '모션 학습 꺼짐');
      renderAll();
    } else if (syncNowBtn) {
      toast('대시보드로 동기화 중…');
      chrome.runtime.sendMessage({ action: 'SYNC_NOW' }, (resp) => {
        if (chrome.runtime.lastError || !resp) { toast('동기화 실패: ' + (chrome.runtime.lastError?.message || '응답 없음')); return; }
        if (resp.ok) { toast(`동기화 완료 · 대상 ${resp.counts?.targets ?? 0} · 캠페인 ${resp.counts?.campaigns ?? 0}`); renderAll(); }
        else toast('동기화 실패: ' + (resp.error || ''));
      });
    } else if (openDashboardBtn) {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
    }
  } catch (err) {
    // Any throw inside a loop must leave the UI consistent (stop all loops, clear cooldown).
    state.isAutoSending = false;
    state.isCheckingReplies = false;
    state.isCollectingEmails = false;
    state.isProcessing = false;
    recordRunEvent('critical_failure', err && err.message ? err.message : String(err || 'unknown'));
    console.error('Click listener critical failure:', err);
    try { renderAll(); } catch {}
    toast('동작 중 오류로 중지되었습니다: ' + (err && err.message ? err.message : err));
  }
});

// ── tab: 로그 ────────────────────────────────────────────────────────────────
async function renderLog() {
  const body = $('#body');
  const logs = (await store.listLogs(state.campaignId)).slice().reverse();
  const counts = statusCounts();
  const sent = counts.sent;
  const replied = counts.replied;
  const rate = sent ? Math.round((replied / sent) * 100) : 0;

  body.innerHTML = `
    <h3>발송 로그 & 리포트</h3>
    <div class="stat">
      <span>발송완료 ${sent}</span>
      <span>응답 ${replied}</span>
      <span>응답률 ${rate}%</span>
      <span>스킵 ${counts.skipped}</span>
      <span>실패 ${counts.failed}</span>
    </div>
    <div class="row" style="margin:6px 0;">
      <button class="sm ghost" id="exportLog">로그 CSV 내보내기</button>
    </div>
    ${
      logs.length
        ? `<table>
            <thead><tr><th>시각</th><th>핸들</th><th>결과</th></tr></thead>
            <tbody>${logs
              .map(
                (l) => `<tr>
                  <td>${esc(fmtTs(l.ts))}</td>
                  <td>@${esc(l.targetHandle || '')}</td>
                  <td><span class="pill s-${l.result}">${STATUS_LABEL[l.result] || l.result}</span></td>
                </tr>`
              )
              .join('')}</tbody>
          </table>`
        : `<div class="empty">아직 기록이 없습니다.</div>`
    }
  `;

  $('#exportLog').addEventListener('click', () => {
    const data = logs.map((l) => ({
      ts: new Date(l.ts).toISOString(),
      handle: l.targetHandle || '',
      result: l.result,
      message: l.finalText || '',
    }));
    downloadCSV(`log_${currentCampaign().name}.csv`, ['ts', 'handle', 'result', 'message'], data);
  });
}

// ── Run traces (feedback loop) ───────────────────────────────────────────────
// Store the structured trace the content script returns (incl. the failure DOM capture),
// enriched with campaign/time context. The 발송 탭 has an "내보내기" button → JSON for analysis.
function recordTrace(response, kind) {
  try {
    if (response && response.trace) {
      store.addTrace({ ...response.trace, kind: response.trace.kind || kind, campaignId: state.campaignId, ts: Date.now() });
    }
  } catch (e) { console.warn('addTrace failed', e); }
}
// Platform-notice timeline: record each service notice with run context,
// into the same traces store so one export shows where the run paused.
function recordPlatformNotice(type, reason) {
  try {
    store.addTrace({
      kind: 'platform_notice', type, reason: reason || null, ts: Date.now(),
      campaignId: state.campaignId,
      runActionCount: state.runActionCount || 0,
      sinceRunStartSec: state.runStartAt ? Math.round((Date.now() - state.runStartAt) / 1000) : null,
      paceFactor: state.paceFactor || 1,
    });
  } catch (e) { console.warn('recordPlatformNotice failed', e); }
}
function recordRunEvent(type, reason, extra = {}) {
  try {
    const counts = statusCounts();
    store.addTrace({
      kind: 'run_event',
      schema: 1,
      type,
      reason: reason || null,
      ts: Date.now(),
      campaignId: state.campaignId,
      tab: state.tab,
      harness: !!chrome.__dev,
      isProcessing: !!state.isProcessing,
      isAutoSending: !!state.isAutoSending,
      isCollectingEmails: !!state.isCollectingEmails,
      isCheckingReplies: !!state.isCheckingReplies,
      runActionCount: state.runActionCount || 0,
      sinceRunStartSec: state.runStartAt ? Math.round((Date.now() - state.runStartAt) / 1000) : null,
      statusCounts: counts,
      pendingCount: counts.pending || 0,
      noEmailCount: counts.no_email || 0,
      targetCount: state.targets.length,
      settings: {
        entryDiversify: state.settings.entryDiversify === true,
        warmupEnabled: state.settings.warmupEnabled === true,
        circadianEnabled: state.settings.circadianEnabled !== false,
        sessionPacing: state.settings.sessionPacing !== false,
        softSignalGuard: state.settings.softSignalGuard !== false,
      },
      ...extra,
    });
  } catch (e) { console.warn('recordRunEvent failed', e); }
}
function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[^\w.\-가-힣]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── CSV download ─────────────────────────────────────────────────────────────
function downloadCSV(filename, headers, rows) {
  const csv = '﻿' + toCSV(headers, rows); // BOM so Excel reads UTF-8/한글
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[^\w.\-가-힣]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Closing the side panel mid-run should clear the IG "확장이 디버깅 중" banner
// promptly, instead of waiting for the service worker's 30s idle auto-detach.
window.addEventListener('pagehide', () => {
  try { chrome.runtime.sendMessage({ action: 'CDP_DETACH' }); } catch {}
});

boot();
startDevReload();
