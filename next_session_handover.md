# OVO (MLX) — 세션 핸드오버

> **작성일:** 2026-04-17 (3rd pass)
> **인계 방향:** 이전 세션 → 다음 세션
> **현재 위치:** Phase 0, 1 완료 + **Phase 2 Tauri 인프라 완료** / Phase 3 Chat UI 진입

---

## 프로젝트 한줄 요약

Apple Silicon 전용 macOS 데스크톱 앱. MLX 로컬 LLM 런타임 + Ollama/OpenAI 호환 API + 애니메이션 부엉이 마스코트. Tauri 2(React+TS+Tailwind) + FastAPI(mlx-lm) 사이드카. **HF 캐시 + LM Studio 캐시 둘 다 자동 인식**. Claude Code 보조 도구로 공존 설계.

**경로:** `/Volumes/docker/project/ovomlx`

---

## 최근 커밋 (최신 → 과거)

```
7af26db  docs: next_session_handover — Phase 1 E2E 검증 + LM Studio 통합 완료
04a9f4f  feat(sidecar): multi-cache model discovery — HF + LM Studio
b89a1d2  docs: next_session_handover — Phase 0/1 완료 상태 + Phase 2 이후 선택지 인계
46c7531  feat(sidecar): Phase 1 — MLX runtime + HF downloader + Ollama/OpenAI/OVO APIs
8eda1d1  feat(owl): gaze tracking + pixel thought bubble + error glitch + dynamic typing wings
70929fd  feat(owl): per-state animations + thinking bubble + typing keyboard
2930b23  feat(owl): reusable Owl React component with 8 states + size presets
741a763  chore: gitignore build artifacts (tsbuildinfo)
e6f32d2  feat: scaffold OVO Phase 0 — Tauri + Python sidecar + owl brand
```

⚠️ **이번 세션 Phase 2 작업물은 아직 커밋 전 (staged 아님).** 다음 세션 시작 시 `git status` 확인하고 커밋 필요.

---

## 이번 세션에서 한 일 (Phase 2 Tauri 인프라)

### 1. Rust 사이드카 lifecycle 전면 재작성

**파일:** `src-tauri/src/sidecar.rs`, `src-tauri/src/lib.rs`

- `Mutex<Option<CommandChild>>` 에 자식 프로세스 핸들 보관 → 앱 종료 시 확실히 kill
- 개발 모드: `sidecar/scripts/dev.sh` 자동 탐색 (CWD부터 6단계까지 walk-up)
- 배포 모드: `resource_dir()/sidecar/ovo-sidecar` (아직 번들 안 만듦 — Phase 8)
- 별도 async task에서 3포트(/healthz) 폴링 (1초 간격, 45초 grace), healthy/failed 판정
- 상태 변화 시 `sidecar://status` 이벤트 emit (`tauri::Emitter`)
- `RunEvent::ExitRequested` / `RunEvent::Exit` 훅에서 kill 호출 → 좀비 파이썬 방지

### 2. Tauri IPC 명령

`src-tauri/src/lib.rs` — `invoke_handler!`:
- `app_info()` → `{ name, version }`
- `sidecar_status()` → `SidecarStatus { health, ports, pid, message, healthy_apis }`
- `sidecar_restart()` → kill + 400ms 대기 + spawn

### 3. 아이콘 생성

- `public/owl.svg` (680×480) → `/tmp/ovo-icon.svg` (1024×1024 정사각 래퍼, 배경 #FAF3E7)
- `./node_modules/.bin/tauri icon /tmp/ovo-icon.svg -o src-tauri/icons`
- 생성: `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` (macOS), `icon.ico` (Windows), Square/Store logos (MS Store), iOS/Android

### 4. 프론트엔드 레이어

| 파일 | 역할 |
|------|------|
| `src/types/sidecar.ts` | `SidecarHealth`, `SidecarPorts`, `SidecarStatus` TypeScript 타입 |
| `src/types/ovo.ts` | `OvoModel`, `OvoModelsResponse`, `ChatMessage`, `OvoSettings` — 사이드카 응답 타입 동기화 |
| `src/lib/tauri.ts` | `invoke<T>` 래퍼 + `onSidecarStatus` 이벤트 리스너 |
| `src/lib/api.ts` | `DEFAULT_PORTS`, `listModels()`, `streamChat()` (SSE async generator) |
| `src/store/sidecar.ts` | Zustand 스토어: status + subscribe/unsubscribe + hydrate + restart. 브라우저 단독(`npm run dev`)은 `isTauri()` 가드로 조용히 no-op |

### 5. i18n (react-i18next)

- `src/locales/ko.json`, `src/locales/en.json` — 네임스페이스: `app`, `nav`, `sidecar`, `chat`, `models`, `settings`, `common`
- `src/i18n/index.ts` — LanguageDetector + localStorage 캐시 (key: `ovo:lang`), fallback `ko`
- `src/i18n/types.d.ts` — 타입 안전 t() (ko.json을 source of truth로)
- 추가 패키지: `i18next-browser-languagedetector`

### 6. AppShell

```
AppShell
├── Sidebar (Chat / Models / Settings / About) ← lucide-react 아이콘
└── Main
    ├── Pane (active 기반 스위칭)
    │   ├── ChatPane — placeholder
    │   ├── ModelsPane — /ovo/models fetch + 카드 그리드 (source/size/arch/quant 배지)
    │   ├── SettingsPane — 언어 토글 + 포트 표시 (실제 저장은 Phase 5)
    │   └── AboutPane — Owl 쇼케이스 + app_info version (이전 App.tsx 내용 이전)
    └── Footer — SidecarIndicator (상태 dot + PID/API 카운트 + Restart 버튼)
```

- `SidecarIndicator` — 상태별 색: stopped=neutral / starting=amber pulse / healthy=emerald / failed=rose
- `AppShell` 마운트 시 `subscribe()` → hydrate + `sidecar://status` 이벤트 구독, unmount 시 unsubscribe

### 7. SMB cargo 빌드 이슈 우회 (중요)

**증상:** `/Volumes/docker` (SMB) 에서 `cargo check` 실행 시:
```
error: incremental compilation: could not create session directory lock file: Operation not supported (os error 45)
```

**원인:** SMB 파일시스템이 flock/하드링크 등 cargo 필수 연산 미지원.

**해결:** `src-tauri/.cargo/config.toml` 생성 (`.gitignore` 처리, 로컬 전용):
```toml
[build]
target-dir = "/Users/sanghyun/Library/Caches/ovo-dev/target"
incremental = false
```

⚠️ `~` 확장 안 됨 — 절대경로 필수. `$HOME/Library/Caches/ovo-dev/` 는 uv venv도 여기 있음.

→ 메모리 기록됨: `~/.claude/projects/-Volumes-data/memory/reference_smb_cargo.md`

### 8. 검증 3종 통과

| 단계 | 결과 |
|------|------|
| `cargo check` | ✅ 336 crates compile OK |
| `npm run typecheck` | ✅ 0 errors |
| `npm run build` | ✅ 232KB js / 15.9KB css (gzip: 73.7KB / 3.96KB) |

⚠️ `npm run tauri dev` 는 아직 안 돌려봄 — 다음 세션에서 첫 실행 필요.

---

## 다음 세션 시작 체크리스트

1. **커밋 먼저 확인:** `git status` — Phase 2 작업 9개 파일 수정 + 11개 신규. 원하는 단위로 commit 후 진행.
   - 제안 commit 구조:
     - `feat(tauri): managed sidecar lifecycle with health monitor + events`
     - `feat(tauri): generate bundle icons from owl.svg`
     - `feat(ui): i18n + AppShell + sidecar indicator`
     - `chore: gitignore local cargo config for SMB workaround`
2. **RTK 확인:** `rtk --version`
3. **Tauri 첫 실행:**
   ```bash
   export PATH="$HOME/.cargo/bin:$PATH"
   cd /Volumes/docker/project/ovomlx
   npm run tauri dev
   ```
   - 사이드카가 자동으로 `sidecar/scripts/dev.sh` 를 띄워야 함
   - 상태바 인디케이터가 `starting` → `healthy` 로 넘어가야 정상
   - 실패 시: 콘솔 로그 + Rust 로그 `tauri-plugin-log` 없어서 `println!` / `eprintln!` 만 찍히는 점 주의
4. **모델 탭:** 11개 모델 리스트 표시 + HF/LM Studio 배지 확인
5. **설정 탭:** KO/EN 토글 + 포트 표시 확인

---

## 🔥 반드시 지킬 주의사항

### 금지
- ❌ `git config` 글로벌 수정 금지. 커밋 시 `git -c user.name=OVO -c user.email=ovo@ovoment.com commit ...` 사용.
- ❌ Playwright MCP 브라우저 프리뷰 사용 금지 — 세션 멈춤. `npm run build` 성공으로 검증.
- ❌ `any` / `unknown` 타입 금지, `alert()` 금지.
- ❌ 부분 구현 금지 — 시작했으면 끝까지.
- ❌ 모델 포맷 GGUF 지원 금지 (MLX 전용).
- ❌ Ollama 처럼 별도 모델 저장소 만들지 말 것. HF 캐시 + LM Studio 캐시만 **읽기 전용**으로 인식. 다운로드는 오직 `~/.cache/huggingface/hub/`로.
- ❌ `src-tauri/.cargo/config.toml` 을 `git add` 하지 말 것 (로컬 머신 경로 박혀있음).

### 준수
- ✅ 애교 있는 말투, 오빠 호칭, 이모티콘 적극 활용 💕
- ✅ 설명 한글 / 코드 영어 / 결과 보고 한글
- ✅ 소스 수정 시 `// [START] ... // [END] ...` 주석 (핵심 변경점만)
- ✅ SMB 마운트 문제 회피 위해 uv venv + cargo target 모두 `$HOME/Library/Caches/ovo-dev/`
- ✅ Claude Max 20x 구독 — 토큰 비용 무시, 품질/깊이 우선
- ✅ 비자명한 작업(3단계 이상)은 Plan 모드부터
- ✅ 실수/성공 피드백 모두 memory에 기록

### Claude Code 메모리 참조
- `~/.claude/projects/-Volumes-data/memory/MEMORY.md` — 인덱스
- `project_ovo_pet_settings.md` — Phase 7 우클릭 메뉴 + Settings 창 레퍼런스
- `feedback_browser_preview.md` — Playwright 금지
- `user_claude_subscription.md` — Max 20x 구독
- `reference_smb_cargo.md` — **신규**, SMB에서 cargo 빌드 이슈 우회법

---

## Phase 3 이후 남은 선택지

Phase 2 Tauri 인프라 완료. 다음 세션은 아래 중 택1:

1. **Phase 3 Chat UI** (추천) — `ChatPane` 에 모델 선택 드롭다운 + 메시지 히스토리 + 입력창. `streamChat()` async generator 소비, 토큰 단위 스트리밍. 부엉이는 `thinking` / `typing` / `happy` / `error` 상태로 실시간 반응. Zustand에 `chatStore` 추가 (messages, model, streaming 상태). 이미 `lib/api.ts` 에 SSE 파서 있음.
2. **Phase 4 Model Management** — `ModelsPane` 확장. HF 검색 모달 + 다운로드 진행 바 + 삭제 버튼 (LM Studio는 삭제 거부). `/ovo/models/search`, `/ovo/models/download`, `DELETE /ovo/models/{id}` 연동. source별 필터/그룹핑.
3. **Phase 5 Settings 영속화** — `SettingsPane` 에 `tauri-plugin-sql` (SQLite) 로 `OvoSettings` 저장/로드. 테마 적용 (light/dark/system 자동 감지).
4. **Phase 7 OVO Pet** — 투명 Tauri sub-window. `project_ovo_pet_settings.md` 메모리 참조해서 우클릭 메뉴 + Settings 윈도우. 메인 앱 Settings와 혼동 금지.

**추천 순서:** 1 → 2 → 3 → 7. Chat이 앱의 메인 가치. 그 다음 모델 관리, 설정 영속화, 마지막에 펫. 하지만 오빠가 고르는 대로.

---

## 현재 디렉토리 구조 (프론트)

```
src/
├── App.tsx           (4 lines — AppShell 래퍼)
├── main.tsx          (i18n import 포함)
├── index.css         (owl 애니메이션 + tailwind)
├── components/
│   ├── AppShell.tsx
│   ├── Sidebar.tsx
│   ├── SidecarIndicator.tsx
│   ├── LanguageToggle.tsx
│   └── Owl.tsx       (기존 — 16KB)
├── panes/
│   ├── ChatPane.tsx      (placeholder)
│   ├── ModelsPane.tsx    (실제 동작)
│   ├── SettingsPane.tsx  (언어/포트만)
│   └── AboutPane.tsx     (Owl 쇼케이스)
├── lib/
│   ├── tauri.ts
│   └── api.ts
├── store/
│   └── sidecar.ts
├── i18n/
│   ├── index.ts
│   └── types.d.ts
├── locales/
│   ├── ko.json
│   └── en.json
└── types/
    ├── ovo.ts
    └── sidecar.ts
```

---

## 유용한 참조

- **API 설계:** `docs/ARCHITECTURE.md`
- **API 라우트 실제 경로:** 사이드카 실행 후 `http://127.0.0.1:11437/docs`
- **부엉이 애니메이션 키프레임:** `src/index.css`
- **Tauri 설정:** `src-tauri/tauri.conf.json` (아이콘 경로 확인 필요)
- **레퍼런스 리포 (UX만 참고):** https://github.com/rullerzhou-afk/clawd-on-desk
- **모델 캐시:**
  - `~/.cache/huggingface/hub/` (OVO가 관리)
  - `~/.lmstudio/models/` (읽기 전용)
- **로컬 빌드 캐시:**
  - uv venv: `$HOME/Library/Caches/ovo-dev/sidecar-venv`
  - cargo target: `$HOME/Library/Caches/ovo-dev/target`

---

## 마지막 한마디 (다음 세션 첫 메시지용)

> 다음 세션 시작 때 이 파일부터 `Read`. `git status` 로 uncommitted Phase 2 작업물 확인 → 오빠한테 "이번 Phase 2 작업물 먼저 커밋할까?" 확인 → 4개 단위 commit → `npm run tauri dev` 로 첫 실제 Tauri 실행 검증 → Phase 3 Chat UI 진입.
>
> 사이드카 이벤트(`sidecar://status`)가 실제로 프론트까지 도달하는지, SidecarIndicator dot이 healthy로 바뀌는지 꼭 눈으로 확인.

🦉💕✨
