// chrome.storage.local wrapper + CRUD for the local data model.
// Scale target is a few hundred targets + logs per campaign, comfortably within
// storage.local limits. No remote sync, no third-party sharing.

const K = {
  campaigns: 'campaigns',
  targets: 'targets',
  templates: 'templates',
  logs: 'logs',
  settings: 'settings',
  traces: 'traces',
};

async function getKey(key, def) {
  const o = await chrome.storage.local.get(key);
  return key in o ? o[key] : def;
}
async function setKey(key, val) {
  await chrome.storage.local.set({ [key]: val });
}

// Serialize all read-modify-write mutations so concurrent callers (e.g. the bulk
// loop flipping a target status while the user imports a CSV or deletes a target)
// don't clobber each other's full-array writes. Reads stay lock-free.
let _writeChain = Promise.resolve();
function withLock(fn) {
  const run = _writeChain.then(fn, fn);
  _writeChain = run.then(() => {}, () => {});
  return run;
}

export const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

// ── Campaigns ──────────────────────────────────────────────────────────────
export async function listCampaigns() {
  return getKey(K.campaigns, []);
}
export async function saveCampaign(c) {
  return withLock(async () => {
    const all = await getKey(K.campaigns, []);
    const i = all.findIndex((x) => x.id === c.id);
    if (i >= 0) all[i] = c;
    else all.push(c);
    await setKey(K.campaigns, all);
    return c;
  });
}
export async function deleteCampaign(id) {
  return withLock(async () => {
    await setKey(K.campaigns, (await getKey(K.campaigns, [])).filter((c) => c.id !== id));
    await setKey(K.targets, (await getKey(K.targets, [])).filter((t) => t.campaignId !== id));
    await setKey(K.logs, (await getKey(K.logs, [])).filter((l) => l.campaignId !== id));
  });
}

// ── Targets ────────────────────────────────────────────────────────────────
export async function listTargets(campaignId) {
  return (await getKey(K.targets, [])).filter((t) => t.campaignId === campaignId);
}

// Adds new targets, skipping handles already present in the campaign.
// Returns { added, dup }.
export async function upsertTargets(campaignId, incoming) {
  return withLock(async () => {
    const all = await getKey(K.targets, []);
    const have = new Set(
      all.filter((t) => t.campaignId === campaignId).map((t) => t.handle.toLowerCase())
    );
    let added = 0;
    let dup = 0;
    for (const t of incoming) {
      const key = t.handle.toLowerCase();
      if (have.has(key)) {
        dup++;
        continue;
      }
      have.add(key);
      all.push({
        id: uid(),
        campaignId,
        handle: t.handle,
        vars: t.vars || {},
        status: 'pending',
        updatedAt: Date.now(),
      });
      added++;
    }
    await setKey(K.targets, all);
    return { added, dup };
  });
}

export async function updateTarget(id, patch) {
  return withLock(async () => {
    const all = await getKey(K.targets, []);
    const i = all.findIndex((t) => t.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch, updatedAt: Date.now() };
    await setKey(K.targets, all);
    return all[i];
  });
}

export async function deleteTarget(id) {
  return withLock(async () =>
    setKey(K.targets, (await getKey(K.targets, [])).filter((t) => t.id !== id))
  );
}

export async function clearTargets(campaignId) {
  return withLock(async () =>
    setKey(K.targets, (await getKey(K.targets, [])).filter((t) => t.campaignId !== campaignId))
  );
}

// ── Templates ──────────────────────────────────────────────────────────────
export async function listTemplates() {
  return getKey(K.templates, []);
}
export async function saveTemplate(t) {
  return withLock(async () => {
    const all = await getKey(K.templates, []);
    const i = all.findIndex((x) => x.id === t.id);
    if (i >= 0) all[i] = t;
    else all.push(t);
    await setKey(K.templates, all);
    return t;
  });
}
export async function deleteTemplate(id) {
  return withLock(async () =>
    setKey(K.templates, (await getKey(K.templates, [])).filter((t) => t.id !== id))
  );
}

// ── Logs ───────────────────────────────────────────────────────────────────
const MAX_LOGS = 5000; // cap so addLog's full-array rewrite doesn't grow unbounded (O(n²))
export async function addLog(entry) {
  return withLock(async () => {
    const all = await getKey(K.logs, []);
    all.push(entry);
    if (all.length > MAX_LOGS) all.splice(0, all.length - MAX_LOGS);
    await setKey(K.logs, all);
    return entry;
  });
}
export async function listLogs(campaignId) {
  const all = await getKey(K.logs, []);
  return campaignId ? all.filter((l) => l.campaignId === campaignId) : all;
}

// ── Run traces (feedback loop) ───────────────────────────────────────────────
const MAX_TRACES = 500; // cap so the array rewrite stays bounded
export async function addTrace(entry) {
  return withLock(async () => {
    const all = await getKey(K.traces, []);
    all.push(entry);
    if (all.length > MAX_TRACES) all.splice(0, all.length - MAX_TRACES);
    await setKey(K.traces, all);
    return entry;
  });
}
export async function listTraces() {
  return getKey(K.traces, []);
}
export async function clearTraces() {
  return withLock(async () => setKey(K.traces, []));
}

// ── Settings ───────────────────────────────────────────────────────────────
// Centralized defaults. Stored settings are merged ON TOP of these, so new keys get
// a sane default without re-seeding and an unchecked toggle (stored false) wins.
// The content script can't import this module (classic content script), so it mirrors
// the ON-by-default booleans with a `!== false` check — keep the two in agreement.
export const SETTINGS_DEFAULTS = {
  // personalization + pacing (existing)
  vars: ['name', 'category', 'followers', 'note'],
  defaultCap: 250,
  maxLen: 900,
  dailyTarget: 40,
  batchSize: 10,
  batchCooldownMin: 15,
  jitterMin: 5,
  jitterMax: 15,
  motionLearn: true,
  // Naturalization ("사람처럼") — all default ON, each switch-off-able in options.
  entryDiversify: false,   // A. default OFF → always reach profiles by TYPING search (most human/visible)
  profileDwell: true,      // B. read/scroll/peek a post before acting
  dynamicContext: true,    // C. inject a 1-line context from the profile
  smartFilter: true,       // D. skip private/inactive/low-follower; prioritize queue
  skipPrivate: true,
  skipInactiveDays: 30,    // 0 = don't skip on inactivity
  minFollowers: 0,         // 0 = no minimum
  sessionPacing: true,     // E. work in 15–45m sessions with real breaks
  sessionMinMin: 15,
  sessionMaxMin: 45,
  restMinMin: 5,
  restMaxMin: 20,
  burstMin: 3,
  burstMax: 5,
  softSignalGuard: true,   // F. detect soft warnings → cool off before a hard block
  useContactButton: true,  // G. prefer business contact/email buttons over "더보기"
  emailMultiPath: true,    // email scrape: bio → m.instagram.com → highlights
  messageQualityGuard: true, // H. block broken or repeated message skeletons before opening IG
  messageRepeatWindow: 8,
  messageRepeatLimit: 2,
  autoFollow: true,        // unified flow: follow ONLY when no message button, then retry DM
  // Stealth (고급 사람모방, OSS-derived) — all default ON, each switch-off-able.
  stealthMouse: true,      // I/II/III bezier path + Fitts timing + overshoot + hover
  typoCorrection: true,    // IV corrected typo -> backspace -> correction, guarded by final exact text verification
  typoChance: 0.03,
  punctuationPause: true,  // V micro-pause after , . and newlines
  stealthScroll: true,     // VI eased wheel profile + jitter
  proportionalDwell: true, // VII reading time scales with text length
  warmupEnabled: false,    // VIII OFF by default (was blocking testing for ~8min). Turn ON in
                           //      options for safe live runs (cold→warm→active + hourly caps).
  warmupColdMin: 8,        // first N minutes of a session = feed warm-up, no outreach (when on)
  capColdPerHour: 3,
  capWarmPerHour: 8,
  capActivePerHour: 12,
  circadianEnabled: true,  // IX suppress activity in the dead of night (local time)
  backtrackEnabled: true,  // X occasional intentional-noise navigation
  // XI — extra behaviour patterns, all default ON.
  typingMouseJitter: true, // 11-1 tiny mouse moves between keystrokes
  attentionPause: true,    // 11-2/3 occasional "looking away" pauses (no real tab switch)
  wordRevision: true,      // 11-4 rewrite the last word once per message; final exact-send safety still gates sending
  emojiPause: true,        // 11-5 brief pause before an emoji
  prePeekPosts: true,      // 11-6 peek a post before reading the bio
  storyView: true,         // 11-7 occasionally open a story
  readingMicroScroll: true,// 11-8 micro-scroll while dwelling
  wrongHover: true,        // 11-9 brief wrong-element hover before a click
  sendHesitation: true,    // 11-10 hesitate before pressing send
  timeOfDaySession: true,  // 11-12 session length varies by time of day
};

export async function getSettings() {
  return { ...SETTINGS_DEFAULTS, ...(await getKey(K.settings, {})) };
}
export async function saveSettings(patch) {
  return withLock(async () => {
    const next = { ...(await getKey(K.settings, {})), ...patch };
    await setKey(K.settings, next);
    return next;
  });
}
