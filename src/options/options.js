import '../lib/dev-shim.js'; // dev-only chrome.* polyfill (inert in a real extension)
import { getSettings, saveSettings, SETTINGS_DEFAULTS } from '../lib/storage.js';

const $ = (id) => document.getElementById(id);
const TOGGLES = ['motionLearn', 'autoFollow', 'entryDiversify', 'profileDwell', 'dynamicContext', 'useContactButton', 'emailMultiPath', 'messageQualityGuard', 'smartFilter', 'skipPrivate', 'softSignalGuard', 'sessionPacing',
  'motionMouse', 'typoCorrection', 'punctuationPause', 'motionScroll', 'proportionalDwell', 'backtrackEnabled', 'warmupEnabled', 'circadianEnabled',
  'typingMouseJitter', 'attentionPause', 'wordRevision', 'emojiPause', 'prePeekPosts', 'storyView', 'readingMicroScroll', 'wrongHover', 'sendHesitation', 'timeOfDaySession'];
const NUMS = ['skipInactiveDays', 'minFollowers', 'sessionMinMin', 'sessionMaxMin', 'restMinMin', 'restMaxMin', 'burstMin', 'burstMax',
  'capColdPerHour', 'capWarmPerHour', 'capActivePerHour'];

async function load() {
  const s = await getSettings(); // already merged with SETTINGS_DEFAULTS
  $('vars').value = (s.vars || SETTINGS_DEFAULTS.vars).join(', ');
  $('defaultCap').value = s.defaultCap;
  $('maxLen').value = s.maxLen;
  $('dailyTarget').value = s.dailyTarget;
  $('batchSize').value = s.batchSize;
  $('batchCooldownMin').value = s.batchCooldownMin;
  $('jitterMin').value = s.jitterMin;
  $('jitterMax').value = s.jitterMax;
  for (const id of TOGGLES) $(id).checked = s[id] !== false;
  for (const id of NUMS) $(id).value = s[id];
}

$('save').addEventListener('click', async () => {
  const vars = $('vars')
    .value.split(',')
    .map((v) => v.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
    .filter(Boolean);
  const numAtLeast = (id, def, min) => Math.max(min, parseInt($(id).value, 10) || def);
  const patch = {
    vars: [...new Set(vars)],
    defaultCap: Math.max(1, parseInt($('defaultCap').value, 10) || 250),
    maxLen: Math.max(1, parseInt($('maxLen').value, 10) || 900),
    dailyTarget: Math.max(1, parseInt($('dailyTarget').value, 10) || 40),
    batchSize: Math.max(1, parseInt($('batchSize').value, 10) || 10),
    batchCooldownMin: Math.max(1, parseInt($('batchCooldownMin').value, 10) || 15),
    jitterMin: Math.max(2, parseInt($('jitterMin').value, 10) || 5),
    jitterMax: Math.max(5, parseInt($('jitterMax').value, 10) || 15),
    skipInactiveDays: Math.max(0, parseInt($('skipInactiveDays').value, 10) || 0),
    minFollowers: Math.max(0, parseInt($('minFollowers').value, 10) || 0),
    sessionMinMin: numAtLeast('sessionMinMin', 15, 1),
    sessionMaxMin: numAtLeast('sessionMaxMin', 45, 1),
    restMinMin: numAtLeast('restMinMin', 5, 1),
    restMaxMin: numAtLeast('restMaxMin', 20, 1),
    burstMin: numAtLeast('burstMin', 3, 1),
    burstMax: numAtLeast('burstMax', 5, 1),
  };
  for (const id of TOGGLES) patch[id] = $(id).checked;
  await saveSettings(patch);
  const saved = $('saved');
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
});

// Dashboard controls moved here from the side panel.
$('openDashboard')?.addEventListener('click', () => {
  try { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') }); } catch (e) { console.warn(e); }
});
$('syncNow')?.addEventListener('click', () => {
  try { chrome.runtime.sendMessage({ action: 'SYNC_NOW' }, () => {}); } catch (e) { console.warn(e); }
});

load();
