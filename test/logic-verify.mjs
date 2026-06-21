// Local logic verification — runs the pure parsing/scoring/math against fixtures with no
// browser/IG. Content-script functions are loaded via `vm` with stubbed browser globals.
// Run from the repo root:  node test/logic-verify.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import { render, seedFrom } from '../src/lib/template.js';
import { importTargets } from '../src/lib/csv.js';
import * as hm from '../src/background/humanMouse.js';
import { SETTINGS_DEFAULTS } from '../src/lib/storage.js';

let pass = 0, fail = 0;
const ok = (name, cond, got) => { (cond ? pass++ : fail++); console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `  → got: ${JSON.stringify(got)}`}`); };
const show = (name, val) => console.log(`   · ${name}: ${JSON.stringify(val)}`);

console.log('\n===== PURE MODULES =====');
{
  const r = render('{{name}}님 {반가워요|안녕하세요} {{missing}}', { name: '지수' }, seedFrom('지수'));
  ok('template: name substituted', r.text.includes('지수님'), r.text);
  ok('template: variant chosen', /반가워요|안녕하세요/.test(r.text), r.text);
  ok('template: missing var stays literal', r.text.includes('{{missing}}'), r.text);
}
{
  const t = importTargets('@kim_official\nhttps://instagram.com/nina.beauty/\nhandle,name\njun_food,준');
  ok('csv: parsed >=2 handles', t.length >= 2, t.map(x => x.handle));
}
{
  ok('hm: easeInOutCubic(0)=0', hm.easeInOutCubic(0) === 0);
  ok('hm: easeInOutCubic(1)=1', hm.easeInOutCubic(1) === 1);
  ok('hm: easeInOutCubic(0.5)=0.5', Math.abs(hm.easeInOutCubic(0.5) - 0.5) < 1e-9);
  ok('hm: fitts monotonic', hm.fittsDuration(400, 24) > hm.fittsDuration(40, 24));
  const p = hm.randomPointInRect(100, 100, 80, 40, 0.2);
  ok('hm: randomPointInRect within padded bounds', p.x > 60 && p.x < 140 && p.y > 80 && p.y < 120, p);
  const bp = hm.bezierPath({ x: 0, y: 0 }, { x: 200, y: 100 }, { overshoot: true });
  ok('hm: bezier all finite', bp.points.every(pt => Number.isFinite(pt.x) && Number.isFinite(pt.y)));
  ok('hm: bezier starts near from', Math.hypot(bp.points[0].x, bp.points[0].y) < 40, bp.points[0]);
}
{
  const need = ['entryDiversify', 'motionMouse', 'warmupEnabled', 'circadianEnabled', 'typingMouseJitter', 'wordRevision', 'emojiPause', 'sendHesitation', 'timeOfDaySession', 'warmupColdMin', 'capActivePerHour', 'messageQualityGuard'];
  ok('settings: all expected keys present', need.every(k => k in SETTINGS_DEFAULTS), need.filter(k => !(k in SETTINGS_DEFAULTS)));
}

console.log('\n===== CONTENT-SCRIPT PARSERS (vm) =====');
const src = fs.readFileSync(new URL('../src/content/instagram-automator.js', import.meta.url), 'utf8');
const noop = function () {};
const makeStub = () => new Proxy(noop, { get: (t, k) => (k === 'then' ? undefined : makeStub()), apply: () => makeStub(), construct: () => makeStub() });
const ctx = {
  chrome: makeStub(),
  window: new Proxy({}, { get: (t, k) => (['innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset', 'devicePixelRatio', 'outerWidth', 'outerHeight'].includes(k) ? 1280 : makeStub()) }),
  location: { pathname: '/', href: '' }, navigator: { userAgent: 'Mozilla/5.0', platform: 'MacIntel' },
  performance: { now: () => 0 }, document: makeStub(), MutationObserver: function () { return { observe() {}, disconnect() {} }; },
  setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {}, console,
  KeyboardEvent: function () {}, InputEvent: function () {}, CompositionEvent: function () {}, Event: function () {},
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

for (const [inp, exp] of [['1,234', 1234], ['1.2만', 12000], ['12.3K', 12300], ['1.5M', 1500000], ['999', 999], ['', null], ['abc', null], ['2.4억', 240000000]]) {
  ok(`parseCount(${JSON.stringify(inp)}) = ${exp}`, ctx.parseCount(inp) === exp, ctx.parseCount(inp));
}
ok('isNonContact(noreply@x.com)=true', ctx.isNonContact('noreply@brand.com') === true);
ok('isNonContact(me@gmail.com)=false', ctx.isNonContact('me@gmail.com') === false);
ok('deobf: does NOT corrupt prose', ctx.deobfuscate('creative water at home dot') === 'creative water at home dot', ctx.deobfuscate('creative water at home dot'));
ok('deobf: bracketed (at)/(dot) works', ctx.deobfuscate('contact (at) brandhaus (dot) com') === 'contact@brandhaus.com', ctx.deobfuscate('contact (at) brandhaus (dot) com'));
ok('deobf: spaced 골뱅이 works', ctx.deobfuscate('nina 골뱅이 gmail (점) com') === 'nina@gmail.com', ctx.deobfuscate('nina 골뱅이 gmail (점) com'));
ok('deobf: prose "eat at sushi dot com" makes NO false email', ctx.extractContactEmail('맛집 eat at sushi dot com 추천', 'foodie') === null, ctx.extractContactEmail('맛집 eat at sushi dot com 추천', 'foodie'));
{
  let r;
  r = ctx.extractContactEmail('협찬 문의는 contact@brandhaus.com 으로 주세요', 'brandhaus'); ok('email: contact+keyword', r && r.email === 'contact@brandhaus.com', r);
  r = ctx.extractContactEmail('email nina.kim@gmail.com', 'nina_kim'); ok('email: handle match', r && r.email === 'nina.kim@gmail.com', r);
  ok('email: none → null', ctx.extractContactEmail('그냥 일상 계정 여행 좋아함', 'someone') === null);
  ok('email: NON_CONTACT-only → null', ctx.extractContactEmail('홍보 noreply@brand.com', 'brand') === null);
  // Policy: any non-system bio email is collected; score is confidence only.
  r = ctx.extractContactEmail('친구추가 someone@random.com', 'unrelated'); ok('email: lone no-intent → collected medium', r && r.email === 'someone@random.com' && r.confidence === 'medium', r);
  r = ctx.extractContactEmail('a@foo.com 그리고 b@bar.com 둘다 적어둠', 'x'); ok('email: multi no-context → collected low', r && r.confidence === 'low', r);
  r = ctx.extractContactEmail('noreply@brand.com 그리고 real@gmail.com', 'x'); ok('email: skips system, takes real', r && r.email === 'real@gmail.com', r);
}
{
  ok('applyContext: fills value', ctx.applyContext('최근 {{context}} 포스트 잘 봤어요!\n협업', '여행').includes('여행'));
  ok('applyContext: drops line when empty', !ctx.applyContext('최근 {{context}} 잘 봤어요\n협업', null).includes('{{context}}'));
  ok('template guard: resolved text passes', ctx.assertNoUnresolvedTemplateVars('안녕하세요 지수님') === undefined);
  let threw = false;
  try { ctx.assertNoUnresolvedTemplateVars('안녕하세요 {{name}}님'); } catch (e) { threw = /template_unresolved/.test(e.message); }
  ok('template guard: unresolved var blocks send', threw);
}
{
  const bio = '여행과 음식 ✈️ #여행스타그램 #먹스타';
  ctx.document = { querySelector: (sel) => (sel === 'header' ? { textContent: bio, closest: () => null, querySelector: () => null, querySelectorAll: () => [] } : null), querySelectorAll: () => [] };
  ok('extractProfileContext: hashtag', ctx.extractProfileContext() === '여행스타그램', ctx.extractProfileContext());
}
{
  const setBio = (bio) => {
    ctx.document = { querySelector: (sel) => (sel === 'header' ? { textContent: bio, closest: () => null, querySelector: () => null, querySelectorAll: () => [] } : null), querySelectorAll: () => [] };
  };
  setBio('contact는 DM / skincare routine 기록');
  ok('extractProfileContext: category fallback', ctx.extractProfileContext() === '뷰티', ctx.extractProfileContext());
  setBio('#협찬 #contact 문의 주세요');
  ok('extractProfileContext: ignores generic contact tags', ctx.extractProfileContext() === null, ctx.extractProfileContext());
}
{
  const mainEl = { querySelectorAll: (sel) => (sel.includes('mailto') ? [{ getAttribute: () => 'mailto:hello@brand.com?subject=hi' }] : []) };
  ctx.document = { querySelector: (sel) => (sel === 'header' ? { textContent: 'x', closest: () => mainEl, querySelector: () => null, querySelectorAll: () => [] } : (sel === 'main' ? mainEl : null)), querySelectorAll: () => [] };
  ok('findContactEmailFromButtons: mailto', ctx.findContactEmailFromButtons() === 'hello@brand.com', ctx.findContactEmailFromButtons());
}
{
  // findBioExpander must match real-IG "더 보기" (spaced) AND clone "더보기" (no space).
  const mk = (txt) => {
    const span = { textContent: txt, closest: () => null, getAttribute: () => null };
    const header = { textContent: 'bio', closest: () => null, querySelector: () => null, querySelectorAll: () => [span] };
    ctx.document = { querySelector: (s) => (s === 'header' ? header : null), querySelectorAll: () => [] };
    return ctx.findBioExpander();
  };
  ok('findBioExpander: "더 보기" (real IG, spaced)', mk('더 보기') !== null, 'null');
  ok('findBioExpander: "더보기" (clone, no space)', mk('더보기') !== null, 'null');
  ok('findBioExpander: ignores unrelated text', mk('팔로우') === null, 'matched');
}

console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
if (fail) process.exit(1);
