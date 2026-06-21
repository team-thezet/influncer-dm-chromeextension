// Dev-only FIXED test campaign. Creates one campaign with a sender + the fixed
// recipient list so the extension has data to click through immediately for testing.
//
// Runs ONCE per seed version (guarded by settings.testSeedVersion) and ONLY in an
// unpacked build — never in the web harness or a Web Store build. Bump SEED_VERSION to
// re-seed (upsertTargets is idempotent, so existing handles aren't duplicated).
//
// NOTE (verified on real IG 2026-06): the sender handle as IG renders it is "0big__oioi"
// (double underscore). DM-able targets first — thezet.io / zetty.me show "메시지 보내기";
// finer.ai / blu.blue.bleu / sweeeeeetsweet were message-restricted / own-profile in
// testing, so they exercise the no-message-button path (and the skip-don't-halt safety net).

import * as store from './storage.js';

const SEED_VERSION = 6;
const CAMPAIGN_ID = 'test-fixed';
const SENDER = '0big__oioi';
const RECIPIENTS = ['thezet.io', 'zetty.me', 'finer.ai', 'blu.blue.bleu', 'sweeeeeetsweet'];

function isUnpacked() {
  try {
    const mf = globalThis.chrome?.runtime?.getManifest?.();
    return !!mf && !('update_url' in mf);
  } catch {
    return false;
  }
}

export async function ensureTestSeed() {
  if (!isUnpacked()) return;
  const settings = await store.getSettings();
  if (settings.testSeedVersion === SEED_VERSION) return;

  // Clean up the older test campaign so the dropdown isn't cluttered.
  try { await store.deleteCampaign('test-3acct'); } catch {}

  const tpl = {
    id: 'test-tpl',
    name: '테스트 협찬 제안',
    body:
      '{안녕하세요|반갑습니다|안녕하세요,} @{{handle}}님 😊\n' +
      '{최근 {{context}} 관련 포스트 잘 봤어요|{{context}} 쪽 콘텐츠가 좋아 보여 연락드려요|{{context}} 관련 게시물 분위기가 인상적이었어요}.\n' +
      '{저희 브랜드 협찬을 제안드리고 싶어 연락드립니다|브랜드 협찬 건으로 조심스럽게 제안드리고 싶습니다|협찬 협업 제안드리고 싶어 메시지드립니다}.\n' +
      '{제품 무상 제공 + 소정의 원고료로 함께하고 싶어요|제품 제공과 소정의 원고료 조건으로 진행을 생각하고 있습니다|제품 제공 및 원고료 조건으로 편하게 검토 부탁드립니다}.\n' +
      '{관심 있으시면 아래 카카오 채널로 편하게 문의 주세요|가능하시면 아래 카카오 채널로 편하게 말씀 주세요|관심 있으시면 아래 채널로 편하게 남겨주세요} :)\n' +
      '👉 https://pf.kakao.com/_zxexample',
  };
  await store.saveTemplate(tpl);

  await store.saveCampaign({
    id: CAMPAIGN_ID,
    name: '발송 리스트',
    senderHandle: SENDER,
    cap: 250,
    templateId: tpl.id,
    status: 'active',
    createdAt: Date.now(),
  });

  await store.upsertTargets(
    CAMPAIGN_ID,
    RECIPIENTS.map((handle) => ({ handle, vars: {} }))
  );

  await store.saveSettings({ testSeedVersion: SEED_VERSION });
  console.info(`[dev-seed] seeded v${SEED_VERSION}: @${SENDER} → ${RECIPIENTS.join(', ')}`);
}
