# OVO Architecture

> 스택 선정 근거와 구조 설계 문서. 2026-04-17 기준.

## 핵심 원칙

1. **Apple Silicon 최적화** — 주 런타임은 MLX (mlx-lm / mlx-vlm / mlx-whisper). 비-MLX 체크포인트는 `transformers` 로 폴백. Intel Mac 미지원.
2. **HuggingFace 네이티브** — Ollama 식 별도 모델 저장소 만들지 않음. `~/.cache/huggingface/hub/` + LM Studio 캐시를 그대로 사용.
3. **로컬 전용** — 네트워크 호출은 모델 다운로드(HF API)와 사용자가 opt-in 한 기능(web_search 등) 에서만. 기본 상태에서 원격 LLM API 호출 없음.
4. **Claude Code 공존** — 선택적 통합. 계정/세션 토큰 등 민감 정보 절대 안 건드림.

## 스택 구성

```
┌─────────────────────────────────────────────────────────┐
│  Tauri 2 (Rust)                                         │
│  ├── Main window: React + TS + Tailwind + shadcn/ui     │
│  └── Pet window:  React + Canvas (sprite animation)     │
├─────────────────────────────────────────────────────────┤
│  Python Sidecar (FastAPI)                               │
│  ├── mlx-lm runtime                                     │
│  ├── HF cache scanner                                   │
│  ├── HF downloader                                      │
│  ├── Ollama-compat API (port 11435)                     │
│  ├── OpenAI-compat API  (port 11436)                    │
│  └── Native OVO API     (port 11437)                    │
├─────────────────────────────────────────────────────────┤
│  Filesystem                                             │
│  ├── ~/.cache/huggingface/hub/   (models)               │
│  ├── ~/Library/Application Support/OVO/                 │
│  │   ├── chats.sqlite                                   │
│  │   ├── settings.json                                  │
│  │   └── audit.log                                      │
│  └── (optional) CLAUDE.md, .claude/  (read-only)        │
└─────────────────────────────────────────────────────────┘
```

## 스택 선정 근거

### Tauri 2 (vs Electron)

| 기준 | Electron | Tauri 2 | 선택 |
|------|----------|---------|:----:|
| 앱 용량 | 150~300MB | 3~15MB | ✅ Tauri |
| RAM | 200~500MB | 50~150MB | ✅ Tauri |
| 시작 속도 | 느림 | 매우 빠름 | ✅ Tauri |
| 백엔드 언어 | Node.js | Rust | ✅ Tauri (파이썬 프로세스 관리 안정적) |
| 투명 창/펫 | 가능하나 무거움 | 네이티브 수준 | ✅ Tauri |
| 생태계 | 크다 | 작지만 성장 중 | 중립 |

LLM 메모리 점유가 큰 앱이므로 셸이 가벼워야 함. Tauri가 정답.

### Python Sidecar (vs Rust 직접 구현)

- **mlx-lm이 Python 생태계 중심** — Rust 바인딩은 존재하지만 후행 릴리스
- HuggingFace 공식 라이브러리 (`huggingface_hub`, `transformers`) 모두 Python
- FastAPI로 HTTP 서버 빠르게 구축
- PyInstaller로 단일 바이너리 패키징 → Tauri 번들에 포함

### FastAPI (vs Flask / Starlette)

- 타입 힌팅 기반 자동 스키마 검증
- SSE 스트리밍 네이티브 지원 (Ollama/OpenAI 호환 필수)
- async-first (동시 요청 안정적)

### React + shadcn/ui

- 생태계 + 컴포넌트 품질
- shadcn/ui는 복사-페이지블 컴포넌트 → 번들 최소화
- Tailwind로 스타일 통일

## 프로세스 라이프사이클

1. 사용자가 OVO 앱 실행
2. Tauri가 Python 사이드카 프로세스 spawn (자식 프로세스)
3. 사이드카가 3개 포트에 서버 기동 (11435/11436/11437)
4. 프론트엔드가 포트 11437(Native) 통해 모델 리스트, 설정 등 조회
5. 챗은 OpenAI-compat(11436) 또는 Native(11437) 중 선택
6. 앱 종료 시 Tauri가 사이드카 프로세스 정리

## API 설계

### Ollama 호환 (port 11435)

```
GET  /api/tags              → 모델 리스트
POST /api/chat              → 채팅 (SSE)
POST /api/generate          → 단일 생성
POST /api/pull              → 모델 다운로드
```

### OpenAI 호환 (port 11436)

```
GET  /v1/models
POST /v1/chat/completions   (stream=true 지원)
POST /v1/completions
POST /v1/embeddings         (추후)
```

### Native OVO (port 11437)

```
GET  /ovo/models            → HF 캐시 스캔 + 상세
GET  /ovo/models/search     → HF hub 검색 (tag:mlx)
POST /ovo/models/download   → 다운로드 시작
GET  /ovo/download/progress → SSE 진행률
DEL  /ovo/models/{name}
GET  /ovo/settings
PUT  /ovo/settings
GET  /ovo/claude/context    → Claude 설정 읽기 (opt-in 시)
GET  /ovo/audit             → 감사 로그
```

## 모델 감지 로직

1. `~/.cache/huggingface/hub/` 스캔
2. 각 스냅샷 폴더에서 `config.json` 읽기
3. 파일 구조에서 MLX 포맷 판별:
   - `*.safetensors` + `tokenizer.json` + `config.json`
   - 별도 `mlx` 태그 없음 → `mlx-community/*` 또는 `*-mlx` 네이밍 규칙 기반 필터
4. 사용 가능 목록에 노출

## Claude 통합 (선택)

### 읽기 대상
- `CWD` 및 상위 디렉토리 (`.` → `..` → `~`)의 `.claude/`
- `CLAUDE.md`, `.claude/settings.json`, `.claude/plugins/**/*`

### 절대 안 읽는 것
- `~/.claude/projects/**` (세션 로그)
- API 키, 세션 토큰, `.credentials`
- 웹 쿠키, 브라우저 저장소

### 감사
- 매 스캔마다 `audit.log`에 기록 (파일 경로, 크기, 해시)
- Settings UI에서 감사 내역 열람 가능

## OVO Pet 아키텍처

Tauri의 다중 창 기능으로 `pet.html` 별도 window 생성:
- 투명 배경 (`transparent: true`)
- 데코레이션 없음 (`decorations: false`)
- 최상위 (`alwaysOnTop: true`)
- Taskbar 숨김 (`skipTaskbar: true`)
- 클릭 통과 (`setIgnoreCursorEvents(true)` on transparent regions)

Canvas로 sprite sheet 애니메이션 렌더. 타이핑/추론 상태는 IPC로 본체 창에서 전달.

## 배포

- `tauri build` → `OVO.app` + `.dmg`
- macOS 노타라이즈 (수동, 사용자 서명)
- 자동 업데이트: Tauri updater (GitHub Releases 기반)

## 미결 사항

- [ ] 파이썬 사이드카 패키징: PyInstaller vs py-pkg vs Shiv (DMG 크기 영향)
- [ ] MLX 모델 판별 정확도 (네이밍 규칙 외 ML 레벨 감지 필요 시 확장)
- [ ] MCP 서버 모드 구현 우선순위 (Phase 6)
