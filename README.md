# 협찬 아웃리치 자동화 오거나이저 (Chrome 확장, MV3)

마이크로 인플루언서 협찬 아웃리치 작업을 캠페인 단위로 관리하고,
Instagram 웹 페이지에서 실행되는 content script와 연동해 발송 큐를 처리하는 Chrome 확장입니다.

## 주요 기능

- CSV/붙여넣기로 핸들 임포트, 중복 제거, 개인화 변수 관리
- `{{변수}}` 치환 + `{a|b|c}` 변형 문구 렌더링 + 길이 가드
- 대상별 최종 문구 일괄 미리보기
- 사이드패널에서 단건/대기열 발송 실행
- Instagram content script를 통한 검색, 프로필 진입, DM 입력/전송 시도
- 발송 완료 대상의 응답 확인 및 2차 템플릿 발송 흐름
- 진행률, 응답률, 발송 로그, CSV 내보내기
- 실행 전 차단/탭 준비/content script ping/명령 실패를 JSON 트레이스로 기록
- 데이터는 로컬 `chrome.storage.local`에 저장

운영 전에는 Instagram/Meta 정책, 수신자 동의 범위, 계정 리스크를 별도로 확인해야 합니다.

## 설치 (개발자 모드 / 언팩)

1. Chrome 주소창에 `chrome://extensions` 입력
2. 우상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드** → 이 폴더(`influncer-dm-chromeextension`) 선택
4. 툴바 아이콘 클릭 → 사이드 패널 열기
5. 확장 **세부정보 → 확장 옵션**에서 변수/기본값/배치 설정 확인

## 개발: 빠른 반복 (웹 하니스)

실제 익스텐션을 매번 리로드하지 않고 UI와 로컬 상태 로직을 빠르게 고치려면,
로컬 서버로 사이드패널을 일반 브라우저 탭에서 엽니다.
`src/lib/dev-shim.js`가 `chrome.*` 일부를 localStorage 기반으로 흉내 냅니다.

```bash
node dev/dev-server.mjs
```

- 사이드패널: http://127.0.0.1:8137/src/sidepanel/sidepanel.html
- 옵션: http://127.0.0.1:8137/src/options/options.html

웹 하니스는 UI/스토리지 개발용입니다. Instagram content script, tab messaging,
실제 host permission 동작은 언팩 익스텐션으로 로드해서 확인해야 합니다.

### 핫리로드 (언팩 익스텐션)

`dev/dev-server.mjs`가 떠 있으면 `src/lib/dev-reload.js`가 `/__version__`을 폴링합니다.

- `src/**` UI·로직 수정 → 사이드패널 페이지 자동 새로고침
- `manifest.json` / `service-worker.js` 수정 → 익스텐션 전체 자동 리로드

웹스토어 빌드(`update_url` 존재)와 웹 하니스에서는 핫리로드가 꺼집니다.

## 사용 흐름

1. **대상** — 핸들 붙여넣기 또는 CSV 임포트, 발신 계정/상한 설정
2. **템플릿** — 협찬 메시지 작성, 변수 삽입, 샘플 미리보기
3. **검토** — 전체 대상의 최종 문구 점검
4. **발송** — 단건 자동 발송 또는 대기열 배치 발송 실행
5. **로그** — 발송/응답 추이 확인, CSV 내보내기

## 문제 분석 트레이스

발송 탭의 **트레이스 내보내기** 버튼은 content script가 반환한 DOM trace뿐 아니라,
사이드패널에서 실제 명령을 보내기 전의 실행 이벤트도 함께 JSON으로 저장합니다.

주요 `run_event` 유형:

- `preflight_blocked`: 웹 하니스 실행, 이미 처리 중, 쿨다운, 템플릿 없음, IG 탭 없음,
  content script ping timeout처럼 시작 전에 막힌 원인
- `tab_probe` / `tab_selected`: 활성 IG 탭, 캐시된 탭, 기존 IG 탭, 새 탭 생성 중 어느 경로를
  사용했는지
- `ping_start` / `ping_retry` / `ping_success` / `ping_timeout`: content script 주입 상태와
  마지막 `chrome.runtime.lastError`
- `rate_gate_pass` / `rate_gate_wait`: 세션 페이싱, warm-up, 시간당 캡 때문에 기다리는 상태
- `content_command_sent` / `content_command_failed`: `PROCESS_TARGET`, `SCRAPE_EMAIL`,
  `SEARCH_AND_SEND` 명령 전송 여부와 실패 응답
- `search_failure_pattern`: 검색창 열기, 검색 결과 매칭, 프로필 진입 실패가 연속되는 패턴
- `preflight_blocked: message_repetition`: 최근 발송 로그와 같은 구조의 메시지가 반복되어
  실제 IG 실행 전에 중지된 상태
- `target_result` / `run_stop` / `critical_failure`: 대상별 결과, 루프 중지 이유, 예외 중단

`run_stop: repeated_search_failures`는 제한 신호가 명시적으로 잡히지 않았더라도 같은 검색/프로필
진입 실패가 반복되어 런을 멈춘 상태입니다. `preflight_blocked: message_template_issue`는
`{{name}}` 같은 필수 템플릿 변수가 남아 실제 DM 전송 전에 차단된 상태입니다.

특히 `http://127.0.0.1:8137` 웹 하니스는 UI/스토리지 개발용이라 Instagram 탭을 자동 조작할
수 없습니다. 이 상태에서 시작하면 `preflight_blocked: web_harness_mode`로 기록됩니다.

## 구조

```text
manifest.json                  MV3 매니페스트
dev/dev-server.mjs             웹 하니스 정적 서버
src/
  background/service-worker.js 사이드패널 오픈 + 기본 설정 시드
  content/
    instagram-automator.js     Instagram 페이지 content script
  lib/
    storage.js                 chrome.storage.local CRUD
    csv.js                     CSV 파서/직렬화 + 핸들 임포터
    template.js                {{변수}} 치환 + 변형 렌더링
    dev-shim.js                웹 하니스용 chrome.* shim
    dev-reload.js              언팩 개발용 핫리로드
    dev-seed.js                언팩 개발용 테스트 데이터 시드
  sidepanel/                   메인 UI
  options/                     설정 페이지
```

현재 매니페스트는 `storage`, `tabs`, `sidePanel`, `clipboardWrite`, `scripting`,
`debugger` 권한과 `*://*.instagram.com/*`, `*://ig.me/*`, Supabase 프로젝트 host
permission을 사용합니다. `debugger`는 신뢰 입력(trusted input, `isTrusted=true`)을
위해 사용되며, 자동화 중 IG 탭 상단에 "확장이 디버깅 중" 배너가 표시됩니다(정상 —
멈추거나 30초 유휴 시 자동 해제).

## 클라우드 동기화 / 대시보드 (Supabase)

로컬 `chrome.storage.local`을 단방향(확장 → DB)으로 Supabase `outreach_*` 테이블에
미러링하면, 웹 대시보드(`dashboard/index.html`)에서 캠페인/대상/이메일/로그를 보고
간단한 CRM(관리상태·메모)을 편집할 수 있습니다.

### 연결 설정 (키 분리)

연결 정보는 코드 로직이 아니라 전용 설정 파일에 있습니다. 프로젝트를 바꾸거나 키를
교체할 때 **아래 두 파일만** 수정하세요(둘은 같은 값을 유지):

- `src/lib/config.js` — 확장(서비스 워커 `sync.js`)용 ES 모듈
- `dashboard/config.js` — 대시보드 페이지용 classic 스크립트(MV3 CSP 때문에 모듈
  import 불가)

Supabase anon 키 발급: Supabase 프로젝트 → **Project Settings → API → Project API
keys → `anon` `public`** 값을 복사해 위 두 파일의 키를 교체합니다.

Public repo에는 실제 Supabase URL/anon key를 커밋하지 않습니다. 로컬에서 연결할 때:

1. `src/lib/config.js`의 `https://your-project-ref.supabase.co`, `YOUR_SUPABASE_ANON_KEY`를 교체
2. `dashboard/config.js`에도 같은 값 반영
3. `manifest.json`의 Supabase host permission을 실제 프로젝트 host로 교체

### 보안: RLS 켜기 (중요)

anon 키는 클라이언트에 그대로 노출되는 **공개 키**입니다(확장/정적 페이지에서는 숨길
수 없음). 실제 접근 제어는 `outreach_*` 테이블의 **Row Level Security(RLS)** 로
합니다. 현재는 RLS가 꺼져 있어 키를 가진 누구나 해당 테이블에 CRUD가 가능합니다.

마이그레이션을 적용해 RLS를 켜고 정책을 명시하세요(자동 실행 안 됨):

```bash
# Supabase CLI
supabase db push
# 또는 Supabase 대시보드 SQL 편집기에 아래 파일 내용을 붙여넣어 실행
```

- `supabase/migrations/0001_enable_rls.sql` — `outreach_*`에 RLS ON + anon 읽기/쓰기
  정책(명시화). 진짜 격리가 필요하면 인증 사용자로 전환 후 정책을 `auth.uid()`로
  좁히세요.
- `supabase/migrations/0002_crm_columns.sql` — 대시보드 CRM용 `crm_status`, `note`
  컬럼 추가(이 컬럼들은 확장 동기화가 덮어쓰지 않아 편집이 보존됨).

RLS를 켜되 anon 정책을 만들지 않으면 동기화/대시보드가 동작하지 않습니다. 0001은 그
anon 정책까지 함께 만듭니다.

## 자연화 (사람처럼 행동)

반복·불완전·스팸성 동작을 줄이고 운영 품질을 높이기 위한 기능들입니다. **모두 기본
켜짐**이며 **확장 옵션 → 자연화** 섹션에서 개별로 끌 수 있습니다(끄면 기존 기본 동작).

- **A. 진입 경로 다양화** (`entryDiversify`): 프로필 진입을 검색 55% / URL 직접 30% /
  피드 경유 15% 로 무작위 분배. URL 경로는 사이드패널이 메시지 전송 전에 탭을 프로필
  URL로 이동시키고(채널 유지), content는 이미 프로필이면 검색 단계를 건너뜁니다.
  *모바일(m.instagram.com) 경로는 보류* — CDP UA/디바이스 에뮬레이션 필요.
- **B. 프로필 체류 자연화** (`profileDwell`): 천천히 여러 번 읽기, 20% 위로 다시 스크롤,
  30% 최근 포스트 1~2개 열어보고 복귀(Escape/뒤로) 후 액션.
- **C. 1줄 동적 컨텍스트** (`dynamicContext`): 템플릿의 `{{context}}`를 발송 시 프로필에서
  추출(바이오 해시태그 우선, 없으면 뷰티/패션/맛집/여행 등 공개 바이오 카테고리 단어
  best-effort)해 채우고, 없으면 그 줄을 자연스럽게 제거. 협찬/문의/contact 같은 일반 태그는
  컨텍스트로 쓰지 않습니다. 메시지 변형은 기존 `{a|b|c}` 스핀 문법(대상별 다른 변형)으로 작성.
  *전용 변형 묶음 UI + 엄격한 LRU는 후속 과제로 보류.*
- **D. 프로필 컨텍스트 기반 스킵/우선순위** (`smartFilter`, `skipPrivate`, `minFollowers`):
  수집 시 팔로워 수·비공개 여부를 함께 읽어 비공개/저팔로워는 자동 스킵(긍정 감지일
  때만 — 못 읽으면 절대 스킵 안 함), DM 큐는 팔로워 많은 순 우선. *최근 포스트 시점·
  카테고리는 IG 웹에서 신뢰성 있게 못 읽어 의도적으로 제외.*
- **E. 세션 페이싱** (`sessionPacing`): 15~45분 세션, 세션 내 3~5건마다 1~2분 피드 "딴짓",
  세션 종료 시 5~20분 실제 휴식(디버거 분리) 후 새 세션. 기존 배치 쿨다운 위에 얹힘.
- **F. 소프트 경고 쿨다운** (`softSignalGuard`): 하드 차단 *전* 경고 문구(다이얼로그/알림
  한정)를 감지하면 즉시 런을 멈추고 쿨다운 상태로 전환합니다.
- **G. 비즈니스 contact 버튼** (`useContactButton`): 프로필의 이메일/연락처 버튼(보통
  `mailto:` 링크)을 "더보기"보다 우선 사용해 고신뢰 이메일을 바로 수집.
- **H. 메시지 품질 가드** (`messageQualityGuard`): 최근 발송 로그를 기준으로 URL·@핸들을
  표준화한 메시지 구조가 반복되면 IG 탭을 열기 전에 중지합니다. 공개 bot/CIB 연구에서 반복
  콘텐츠·행동 시퀀스가 주요 신호로 다뤄지는 점을 반영한 운영 품질 가드입니다.
- **입력 경로 안전장치**: DM 본문·검색 핸들 등 모든 IG 입력을 글자별 CDP 신뢰
  타이핑으로 통일(클립보드 paste 경로 완전 제거). CDP가 막혀 synthetic fallback으로 내려가도
  문장부호 휴지·이모지 앞 멈칫을 유지하고, 오타정정은 ASCII만 적용해 한글 IME 조합을 건드리지
  않습니다.
- **이메일 다중 경로** (`emailMultiPath`): contact 버튼 → 바이오 더보기+정규식 → 전체
  영역 재스캔(동일한 엄격 스코어링). *m.instagram.com 백업·스토리 하이라이트 경로는
  보류(크로스 오리진 리로드 / 이미지 콘텐츠).*

### 라이브 검증 체크리스트 (실제 IG 로드 후 확인 필요)

코드는 작성·문법 검증까지 완료, 실제 IG DOM 동작은 미검증입니다. unpacked 로드 후:

1. **A/URL**: 발송/수집 시 탭이 프로필 URL로 이동 후 검색 없이 진행되는지.
2. **A/feed**: 'feed' 경로에서 홈으로 갔다가 검색으로 돌아오는지(홈 nav 셀렉터 확인).
3. **B**: 포스트 모달이 Escape로 닫히고 프로필로 복귀하는지(모달 vs /p/ 네비).
4. **C**: 해시태그 있는 프로필에서 `{{context}}`가 채워지고, 없으면 그 줄이 빠지는지.
5. **D**: 팔로워 수 파싱(1.2만/12.3K)·비공개 감지가 맞는지, 스킵·우선순위 반영되는지.
6. **F**: 소프트 경고 문구 오탐(정상 UI를 경고로 오인) 없는지.
7. **G**: 비즈니스 계정 `mailto:` 버튼에서 이메일을 바로 잡는지.
8. **입력**: DM 본문이 한 글자씩 입력되는지(붙여넣기 흔적 없음), 한글 정상 입력.

## 스텔스 (고급 사람모방, OSS 기반)

해외 stealth OSS 기법 10종. **확장 옵션 → 스텔스** 섹션에서 개별 토글(기본 켜짐). 출처:
[ghost-cursor](https://github.com/Xetera/ghost-cursor) (MIT, `src/background/humanMouse.js`에
attribution), puppeteer-extra-plugin-human-typing(0x7357, MIT), TheGP/Imposter,
prescience-data, instagrapi 가이드.

- **I·II·III 마우스** (`stealthMouse`): 학습된 실제 제스처 재생이 1순위로 유지되고, 학습
  데이터가 없을 때의 합성 경로를 **베지에 곡선 + Fitts 법칙 타이밍 + overshoot/보정 +
  요소 내 랜덤 좌표 + 클릭 전 hover**로 업그레이드. (SW가 CDP 디스패치를 소유하므로 path
  수학은 `content/`가 아니라 `src/background/humanMouse.js`에 둠.)
- **IV 오타정정** (`typoCorrection`): 인접키 오타→백스페이스→정정. 기본 켜짐이며,
  **ASCII 글자만** 적용합니다. 한글·문장부호·공백엔 적용 안 함 → IME 조합 절대 안 건드림.
  최종 입력 검증 실패 시 전송하지 않습니다.
- **V 문장부호 휴지** (`punctuationPause`): `,` 후 0.15~0.4s, `. ? !` 후 0.4~0.9s, 줄바꿈 후
  0.8~2s, 5% 확률 1.5~4s 생각.
- **VI 스크롤 이징** (`stealthScroll`): 합성 스크롤을 easeInOutCubic 관성 + ±2px jitter,
  300px당 8~15틱으로.
- **VII 비례 읽기** (`proportionalDwell`): 바이오 길이에 비례한 읽기 시간(상한 10s).
- **VIII warm-up + 캡** (`warmupEnabled`): 세션 첫 8분 피드 워밍업(발송 X), 상태별 시간당
  캡(cold 3 / warm 8 / active 12). 우리 액션만 카운트(사용자 수동 분리). `chrome.alarms`
  1분 틱으로 윈도우 정리(SW setInterval 5분 제약 회피).
- **IX 서카디언** (`circadianEnabled`): 브라우저 로컬시간 기준 새벽 02~07시 ~4%로 억제,
  엣지 시간대 캡 축소.
- **X 백트래킹** (`backtrackEnabled`): 세션 페이싱 안에서 13% explore 우회·5% 뒤로가기·3%
  검색만 열고 닫기.

### 스텔스 추가 라이브 검증

9. **I~III**: 클릭 시 곡선 이동·살짝 지나쳤다 보정·누르기 전 hover 멈칫(특히 모션 학습
   데이터가 적을 때 합성 경로).
10. **IV**: 영문 포함 메시지에서 가끔 오타→정정, **한글은 절대 오타 안 남**.
11. **VIII/IX**: warm-up 8분 후 발송 시작, 시간당 캡 도달 시 대기, 새벽 시간 억제.
    캡/warm-up은 분당 단위라 검증 시 캡을 낮게(예: 2)·warm-up을 1분으로 줄여 확인 권장.
12. **X**: 가끔 explore로 샜다 돌아오거나 뒤로가기 후 재개되는지.

## 추가 행동 패턴 (XI) + 탐지 회피 (XII)

**XI — 12종 추가 행동** (옵션 "추가 행동 패턴", 기본 켜짐):
11-1 타이핑 중 마우스 미세 이동 / 11-2·3 "딴 데 보는" 자연 휴지(실제 탭전환 X) /
11-4 마지막 단어 고쳐쓰기(같은 단어 재타이핑, 오타정정과 별개) / 11-5 이모지 앞 멈칫 /
11-6 bio 전 포스트 보기 / 11-7 가끔 스토리 / 11-8 읽는 중 미세 스크롤 / 11-9 클릭 전
잘못된 hover→보정 / 11-10 보내기 전 망설임 / 11-11 쿠키/스토리지 안 건드림(점검 완료) /
11-12 시간대별 세션 길이. **타이핑 관련(11-1·4·5)은 ASCII/완성문자 기준이라 한글 IME
조합을 절대 건드리지 않음.** 11-4 마지막 단어 고쳐쓰기는 기본 켜짐이며, 완성 한글 음절과
영문/숫자 단어만 대상으로 합니다.

**XII — CDP/확장 탐지 회피**: 실제 Chrome이라 지문(canvas/WebGL/audio/font/WebRTC/lang/
screen 등)은 자연값 그대로. 코드 점검 결과 **모두 클린**(자동화 마커 미설정, toString/
console/performance/navigator 미변조, content script는 ISOLATED world·DOM 미주입,
externally_connectable 미선언으로 페이지가 확장에 접근 불가, IG 쿠키/스토리지 미접촉).
유일한 코드 변경: **12-8 디버거 idle 자동분리 30s→15s** (attach 창 최소화).

### XI/XII 추가 라이브 검증

13. **11-1/9/10**: 타이핑 중 커서 미세 움직임, 클릭 전 잘못된 hover→보정, 보내기 전 멈칫.
14. **11-4**: 메시지 작성 중 가끔 마지막 단어를 지웠다 다시 침 (한글에서도 조합 깨짐 없이).
15. **11-5**: 이모지 직전 멈칫.
16. **11-7**: 스토리 링 있을 때 가끔 열렸다 Esc로 닫힘 (오작동으로 엉뚱한 데 안 가는지).
17. **11-12**: 아침/점심/저녁 세션 길이 차이.
18. **12-8**: 발송 사이 15초 내 디버거 배너 사라짐.
